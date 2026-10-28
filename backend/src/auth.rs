//! Login: satu akun + session cookie.
//!
//! - Pertama kali dibuka (belum ada akun) → halaman "Create account". Butuh
//!   kode setup yang dicetak di log server, supaya orang lain di jaringan
//!   yang sama tidak bisa mendahului pemilik server membuat akun.
//! - Login → token acak disimpan (di-hash) di tabel `sessions` dan dikirim lewat cookie.
//! - Middleware `require_session` memeriksa cookie di setiap request `/api/*`.

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use std::sync::LazyLock;
use std::time::Duration;

use crate::db;
use crate::routes::{ApiError, AppState};
use crate::security;

pub const SESSION_COOKIE: &str = "openshelf_session";
pub const SESSION_TTL_SECS: i64 = 30 * 24 * 60 * 60; // 30 hari

// ---------------------------------------------------------------------------
// Password & token
// ---------------------------------------------------------------------------

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Token session acak 32 byte (64 karakter hex).
pub fn new_session_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    to_hex(&bytes)
}

/// Yang disimpan di database: SHA-256 dari token.
pub fn hash_token(token: &str) -> String {
    to_hex(Sha256::digest(token.as_bytes()).as_slice())
}

/// Huruf & angka yang tidak mudah tertukar (tanpa I, O, 0, 1). Tepat 32
/// karakter, jadi `byte % 32` tidak berat sebelah.
const SETUP_CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Kode setup acak, mis. "K7QM-2XRD" (40 bit; ditambah batas percobaan per IP).
pub fn new_setup_code() -> String {
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    let chars: String = bytes
        .iter()
        .map(|b| SETUP_CODE_ALPHABET[usize::from(*b) % 32] as char)
        .collect();
    format!("{}-{}", &chars[..4], &chars[4..])
}

/// "k7qm 2xrd" dan "K7QM-2XRD" dianggap sama.
fn normalize_setup_code(code: &str) -> String {
    code.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

// ---------------------------------------------------------------------------
// Validasi
// ---------------------------------------------------------------------------

pub fn validate_username(username: &str) -> Result<(), &'static str> {
    let len = username.chars().count();
    if !(3..=32).contains(&len) {
        return Err("Username must be 3–32 characters");
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err("Username can only contain letters, numbers, . _ and -");
    }
    Ok(())
}

pub fn validate_password(password: &str) -> Result<(), &'static str> {
    if password.chars().count() < 8 {
        return Err("Password must be at least 8 characters");
    }
    if password.len() > 512 {
        return Err("Password is too long");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

pub fn session_token_from(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, value)| *name == SESSION_COOKIE && !value.is_empty())
        .map(|(_, value)| value.to_string())
}

fn session_cookie(token: &str, max_age: i64, secure: bool) -> HeaderValue {
    let mut cookie =
        format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}");
    if secure {
        cookie.push_str("; Secure");
    }
    HeaderValue::from_str(&cookie).unwrap_or(HeaderValue::from_static(""))
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct UserInfo {
    pub username: String,
}

#[derive(Serialize)]
pub struct AuthStatus {
    pub setup_required: bool,
    pub user: Option<UserInfo>,
}

#[derive(Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct SetupPayload {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub setup_code: String,
}

async fn start_session(
    state: &AppState,
    user_id: i64,
    username: String,
) -> Result<Response, ApiError> {
    let token = new_session_token();
    db::create_session(
        &state.pool,
        &hash_token(&token),
        user_id,
        db::now_unix() + SESSION_TTL_SECS,
    )
    .await
    .map_err(|e| ApiError::internal("Failed to create session", e))?;

    let mut res = Json(UserInfo { username }).into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(&token, SESSION_TTL_SECS, state.config.secure_cookies),
    );
    Ok(res)
}

/// GET /api/auth/status — perlu buat akun? siapa yang sedang login?
pub async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AuthStatus>, ApiError> {
    let setup_required = db::count_users(&state.pool)
        .await
        .map_err(|e| ApiError::internal("Failed to read accounts", e))?
        == 0;

    let user = match session_token_from(&headers) {
        Some(token) => db::user_for_session(&state.pool, &hash_token(&token))
            .await
            .ok()
            .flatten()
            .map(|u| UserInfo {
                username: u.username,
            }),
        None => None,
    };

    Ok(Json(AuthStatus {
        setup_required,
        user,
    }))
}

/// POST /api/auth/setup — membuat akun pertama (hanya jika belum ada akun).
/// Butuh kode setup dari log server; salah kode dihitung sebagai percobaan
/// login gagal (lihat `security.rs`).
pub async fn setup(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<SetupPayload>,
) -> Result<Response, ApiError> {
    let username = payload.username.trim().to_string();
    validate_username(&username).map_err(ApiError::bad_request)?;
    validate_password(&payload.password).map_err(ApiError::bad_request)?;

    let ip = security::client_ip(&headers, peer, state.config.trust_proxy);
    if let Err(wait) = state.login_limiter.begin(ip) {
        return Ok(too_many_attempts(wait));
    }
    let expected = state
        .setup_code
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(expected) = expected else {
        // Kode hanya dibuat saat server start tanpa akun
        return Err(ApiError::conflict(
            "An account already exists. Please sign in.",
        ));
    };
    if normalize_setup_code(&payload.setup_code) != normalize_setup_code(&expected) {
        eprintln!("⚠️  Kode setup salah dari {ip}");
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Wrong setup code. It's printed in the server log when OpenShelf starts.".into(),
        ));
    }

    // Argon2 butuh ±50–100 ms CPU → jalankan di luar thread async
    let password = payload.password;
    let hash = tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|e| ApiError::internal("Failed to hash password", e))?
        .map_err(|e| ApiError::internal("Failed to hash password", e))?;

    let Some(id) = db::create_first_user(&state.pool, &username, &hash)
        .await
        .map_err(|e| ApiError::internal("Failed to create account", e))?
    else {
        return Err(ApiError::conflict(
            "An account already exists. Please sign in.",
        ));
    };

    *state.setup_code.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.login_limiter.success(ip);
    println!("✅ Account \"{username}\" created");
    start_session(&state, id, username).await
}

/// Hash Argon2 cadangan untuk username yang tidak ada. Password tetap dicek
/// terhadap hash ini, supaya waktu respons sama dengan username yang ada;
/// tanpa ini, username bisa ditebak dari cepat-lambatnya jawaban.
static DUMMY_HASH: LazyLock<String> =
    LazyLock::new(|| hash_password("openshelf-dummy-password").unwrap_or_default());

/// Membuat `DUMMY_HASH` saat start (blocking — panggil lewat `spawn_blocking`).
pub fn warm_up() {
    LazyLock::force(&DUMMY_HASH);
}

fn too_many_attempts(wait: Duration) -> Response {
    let minutes = wait.as_secs().div_ceil(60).max(1);
    let mut res = (
        StatusCode::TOO_MANY_REQUESTS,
        format!(
            "Too many sign-in attempts. Try again in {minutes} minute{}.",
            if minutes == 1 { "" } else { "s" }
        ),
    )
        .into_response();
    if let Ok(v) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
        res.headers_mut().insert(header::RETRY_AFTER, v);
    }
    res
}

/// POST /api/auth/login
/// Maksimal 5 percobaan gagal per IP per 15 menit (lihat `security.rs`).
pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<Credentials>,
) -> Result<Response, ApiError> {
    let ip = security::client_ip(&headers, peer, state.config.trust_proxy);
    if let Err(wait) = state.login_limiter.begin(ip) {
        return Ok(too_many_attempts(wait));
    }

    let user = db::find_user(&state.pool, payload.username.trim())
        .await
        .map_err(|e| ApiError::internal("Failed to read accounts", e))?;

    let password = payload.password;
    let hash = user
        .as_ref()
        .map(|u| u.password_hash.clone())
        .unwrap_or_else(|| DUMMY_HASH.clone());
    let password_ok = tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false);

    let Some(user) = user.filter(|_| password_ok) else {
        eprintln!("⚠️  Login gagal dari {ip}");
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Wrong username or password".into(),
        ));
    };

    state.login_limiter.success(ip);
    let _ = db::delete_expired_sessions(&state.pool).await;
    start_session(&state, user.id, user.username).await
}

/// POST /api/auth/logout
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token_from(&headers) {
        let _ = db::delete_session(&state.pool, &hash_token(&token)).await;
    }
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie("", 0, state.config.secure_cookies),
    );
    res
}

/// Middleware: semua `/api/*` wajib login, kecuali `/api/health` dan `/api/auth/*`.
pub async fn require_session(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let is_public =
        !path.starts_with("/api/") || path == "/api/health" || path.starts_with("/api/auth/");
    if is_public {
        return next.run(req).await;
    }

    let logged_in = match session_token_from(req.headers()) {
        Some(token) => matches!(
            db::user_for_session(&state.pool, &hash_token(&token)).await,
            Ok(Some(_))
        ),
        None => false,
    };

    if logged_in {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "Please sign in").into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_roundtrip() {
        let hash = hash_password("rahasia-banget").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("rahasia-banget", &hash));
        assert!(!verify_password("rahasia-bangeT", &hash));
        assert!(!verify_password("apa saja", "bukan-hash"));
    }

    #[test]
    fn tokens() {
        let a = new_session_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, new_session_token());
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn cookie_parsing() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("theme=dark; openshelf_session=abc123; other=1"),
        );
        assert_eq!(session_token_from(&headers).as_deref(), Some("abc123"));
        assert_eq!(session_token_from(&HeaderMap::new()), None);
    }

    #[test]
    fn setup_codes() {
        let code = new_setup_code();
        assert_eq!(code.len(), 9);
        assert_eq!(&code[4..5], "-");
        assert!(
            code.bytes()
                .filter(|&b| b != b'-')
                .all(|b| SETUP_CODE_ALPHABET.contains(&b))
        );
        assert_ne!(code, new_setup_code());
        assert_eq!(normalize_setup_code("k7qm 2xrd"), "K7QM2XRD");
        assert_eq!(normalize_setup_code("K7QM-2XRD"), "K7QM2XRD");
    }

    #[test]
    fn validation() {
        assert!(validate_username("reza").is_ok());
        assert!(validate_username("re").is_err());
        assert!(validate_username("reza ganteng").is_err());
        assert!(validate_password("1234567").is_err());
        assert!(validate_password("12345678").is_ok());
    }
}
