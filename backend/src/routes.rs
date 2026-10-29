use axum::{
    Json,
    body::Body,
    extract::{FromRef, Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use sqlx::SqlitePool;
use std::fmt::Display;
use std::io::SeekFrom;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::config::Config;
use crate::db::{
    self, Category, CreateCategoryPayload, MAX_CATEGORY_NAME_CHARS, ReadingProgress,
    SaveProgressPayload, SetBookCategoriesPayload,
};
use crate::scanner::{self, BookFormat, BookItem, Library};
use crate::security::LoginLimiter;

// ---------------------------------------------------------------------------
// State & error
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub library: Arc<Library>,
    pub config: Arc<Config>,
    pub login_limiter: Arc<LoginLimiter>,
    /// Kode untuk membuat akun pertama; `None` jika sudah ada akun.
    pub setup_code: Arc<Mutex<Option<String>>>,
}

/// Handler yang hanya butuh database tetap bisa memakai `State<SqlitePool>`.
impl FromRef<AppState> for SqlitePool {
    fn from_ref(state: &AppState) -> Self {
        state.pool.clone()
    }
}

/// Error API: status + pesan teks. Detail error internal hanya ditulis ke log
/// server, tidak dikirim ke client.
pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        ApiError(StatusCode::BAD_REQUEST, msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        ApiError(StatusCode::NOT_FOUND, msg.into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        ApiError(StatusCode::CONFLICT, msg.into())
    }
    pub fn internal(msg: &str, err: impl Display) -> Self {
        eprintln!("❌ {msg}: {err}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, msg.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

async fn find_book(state: &AppState, id: &str) -> Result<BookItem, ApiError> {
    state
        .library
        .find(id)
        .await
        .ok_or_else(|| ApiError::not_found("Book not found"))
}

// ---------------------------------------------------------------------------
// Helper header
// ---------------------------------------------------------------------------

/// `Content-Disposition` yang aman untuk nama file apa pun.
///
/// Sebelumnya nama file dimasukkan mentah lalu `.parse().unwrap()`: nama
/// dengan karakter non-ASCII atau `"` membuat request panic / header rusak.
/// Sekarang: fallback ASCII untuk browser lama + `filename*` (RFC 6266/5987)
/// berisi nama asli yang di-percent-encode.
pub fn content_disposition(disposition: &str, file_name: &str) -> HeaderValue {
    let fallback: String = file_name
        .chars()
        .map(|c| {
            if (c.is_ascii_graphic() && c != '"' && c != '\\') || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();

    let mut encoded = String::with_capacity(file_name.len() * 3);
    for b in file_name.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }

    HeaderValue::from_str(&format!(
        "{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("inline"))
}

#[derive(Debug, PartialEq)]
pub enum RangeRequest {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

/// Parse header `Range: bytes=...` (satu range saja).
/// Format tidak dikenal / multi-range → kirim seluruh file (diizinkan RFC 9110).
pub fn parse_range(header: Option<&str>, len: u64) -> RangeRequest {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return RangeRequest::Full;
    };
    if spec.contains(',') {
        return RangeRequest::Full;
    }
    let Some((a, b)) = spec.split_once('-') else {
        return RangeRequest::Full;
    };
    let (a, b) = (a.trim(), b.trim());

    if a.is_empty() {
        // bytes=-500 → 500 byte terakhir
        let Ok(suffix) = b.parse::<u64>() else {
            return RangeRequest::Full;
        };
        if suffix == 0 || len == 0 {
            return RangeRequest::Unsatisfiable;
        }
        return RangeRequest::Partial {
            start: len.saturating_sub(suffix),
            end: len - 1,
        };
    }

    let Ok(start) = a.parse::<u64>() else {
        return RangeRequest::Full;
    };
    let end = if b.is_empty() {
        u64::MAX
    } else {
        match b.parse::<u64>() {
            Ok(e) => e,
            Err(_) => return RangeRequest::Full,
        }
    };
    if start > end {
        return RangeRequest::Full; // sintaks tidak valid → abaikan
    }
    if start >= len {
        return RangeRequest::Unsatisfiable;
    }
    RangeRequest::Partial {
        start,
        end: end.min(len - 1),
    }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub message: String,
}

pub async fn health_check() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        message: "OpenShelf API is healthy".to_string(),
    })
}

pub async fn get_books(State(state): State<AppState>) -> Json<Vec<BookItem>> {
    let catalog = state.library.books().await;
    let progress_map = db::get_all_progress_map(&state.pool).await;
    let categories_map = db::get_all_book_categories_map(&state.pool).await;

    let result = catalog
        .books()
        .iter()
        .cloned()
        .map(|mut book| {
            if let Some(prog) = progress_map.get(&book.id) {
                book.progress = Some(scanner::BookProgressSummary {
                    current_page: prog.current_page,
                    total_pages: prog.total_pages,
                    progress_percent: prog.progress_percent,
                });
            }
            if let Some(cats) = categories_map.get(&book.id) {
                book.categories = cats.clone();
            }
            book
        })
        .collect();

    Json(result)
}

/// GET /api/books/{id}/raw — file buku, di-stream dan mendukung `Range`.
///
/// Dulu seluruh file dibaca ke RAM per request. Sekarang file di-stream, dan
/// dengan `Accept-Ranges: bytes` PDF.js bisa memuat potongan yang dibutuhkan
/// saja, jadi halaman pertama buku besar muncul jauh lebih cepat.
pub async fn get_book_raw(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let book = find_book(&state, &id).await?;
    let path = book.path.clone();

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| ApiError::internal("Failed to open the book file", e))?;
    let len = file
        .metadata()
        .await
        .map_err(|e| ApiError::internal("Failed to read file info", e))?
        .len();

    let range = parse_range(
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        len,
    );

    let builder = Response::builder()
        .header(header::CONTENT_TYPE, book.format.mime())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CONTENT_DISPOSITION,
            content_disposition("inline", &book.file_name),
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-cache");

    let response = match range {
        RangeRequest::Full => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, len)
            .body(Body::from_stream(ReaderStream::new(file))),
        RangeRequest::Partial { start, end } => {
            file.seek(SeekFrom::Start(start))
                .await
                .map_err(|e| ApiError::internal("Failed to read the book file", e))?;
            let count = end - start + 1;
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_LENGTH, count)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .body(Body::from_stream(ReaderStream::new(file.take(count))))
        }
        RangeRequest::Unsatisfiable => Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Body::empty()),
    };

    response.map_err(|e| ApiError::internal("Failed to build the response", e))
}

/// GET /api/books/{id}/cover
pub async fn get_book_cover(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let book = find_book(&state, &id).await?;
    let path = book.path.clone();

    let extracted = match book.format {
        BookFormat::Epub => {
            // Parsing EPUB = I/O blocking → jalankan di thread pool terpisah
            let p = path.clone();
            tokio::task::spawn_blocking(move || scanner::extract_epub_cover(&p))
                .await
                .ok()
                .flatten()
        }
        BookFormat::Pdf => {
            scanner::extract_pdf_cover(&path, &book.id, &state.config.cover_cache_dir()).await
        }
    };

    let (bytes, mime) = extracted.unwrap_or_else(|| {
        (
            scanner::generate_svg_cover(&book.title, book.format.label()),
            "image/svg+xml".to_string(),
        )
    });

    // Hanya tipe image/* yang dikirim apa adanya
    let content_type = HeaderValue::from_str(&mime)
        .ok()
        .filter(|v| v.to_str().is_ok_and(|s| s.starts_with("image/")))
        .unwrap_or(HeaderValue::from_static("application/octet-stream"));

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // Cover bisa berupa SVG (buatan kita, atau dari dalam EPUB = buatan orang lain).
    // CSP ini mematikan script jika URL cover dibuka langsung di browser.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
        ),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );

    Ok((headers, bytes).into_response())
}

// GET /api/books/{id}/progress
pub async fn get_book_progress(
    State(pool): State<SqlitePool>,
    Path(id): Path<String>,
) -> Json<Option<ReadingProgress>> {
    Json(db::get_progress(&pool, &id).await)
}

// POST /api/books/{id}/progress
pub async fn save_book_progress(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<SaveProgressPayload>,
) -> Result<Json<ReadingProgress>, ApiError> {
    find_book(&state, &id).await?;

    let SaveProgressPayload {
        current_page,
        total_pages,
    } = payload;
    if !(1..=1_000_000).contains(&total_pages) {
        return Err(ApiError::bad_request(
            "total_pages must be between 1 and 1,000,000",
        ));
    }
    if !(1..=total_pages).contains(&current_page) {
        return Err(ApiError::bad_request(
            "current_page must be between 1 and total_pages",
        ));
    }

    db::save_progress(&state.pool, &id, current_page, total_pages)
        .await
        .map_err(|e| ApiError::internal("Failed to save reading progress", e))?;

    let progress = db::get_progress(&state.pool, &id)
        .await
        .ok_or_else(|| ApiError::internal("Failed to read saved progress", "no row"))?;

    Ok(Json(progress))
}

// GET /api/categories
pub async fn get_categories(
    State(pool): State<SqlitePool>,
) -> Result<Json<Vec<Category>>, ApiError> {
    db::get_categories(&pool)
        .await
        .map(Json)
        .map_err(|e| ApiError::internal("Failed to load collections", e))
}

// POST /api/categories
pub async fn create_category(
    State(pool): State<SqlitePool>,
    Json(payload): Json<CreateCategoryPayload>,
) -> Result<(StatusCode, Json<Category>), ApiError> {
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("Collection name can't be empty"));
    }
    if name.chars().count() > MAX_CATEGORY_NAME_CHARS {
        return Err(ApiError::bad_request(format!(
            "Collection name can be at most {MAX_CATEGORY_NAME_CHARS} characters"
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "Collection name contains invalid characters",
        ));
    }
    if db::slugify(name).is_empty() {
        return Err(ApiError::bad_request(
            "Collection name must contain a letter or number",
        ));
    }

    match db::create_category(&pool, name).await {
        Ok(category) => Ok((StatusCode::CREATED, Json(category))),
        Err(e)
            if e.as_database_error()
                .is_some_and(|d| d.is_unique_violation()) =>
        {
            Err(ApiError::conflict(
                "A collection with that name already exists",
            ))
        }
        Err(e) => Err(ApiError::internal("Failed to create collection", e)),
    }
}

// DELETE /api/categories/{id}
pub async fn delete_category(
    State(pool): State<SqlitePool>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let deleted = db::delete_category(&pool, &id)
        .await
        .map_err(|e| ApiError::internal("Failed to delete collection", e))?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("Collection not found"))
    }
}

// POST /api/books/{id}/categories
// Mengembalikan daftar nama kategori buku yang tersimpan, mis. ["Fiction", "Rust"]
pub async fn set_book_categories(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<SetBookCategoriesPayload>,
) -> Result<Json<Vec<String>>, ApiError> {
    find_book(&state, &id).await?;
    if payload.category_ids.len() > 100 {
        return Err(ApiError::bad_request("Too many collections in one request"));
    }

    let names = db::set_book_categories(&state.pool, &id, &payload.category_ids)
        .await
        .map_err(|e| ApiError::internal("Failed to update the book's collections", e))?;
    Ok(Json(names))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        use RangeRequest::*;
        assert_eq!(parse_range(None, 100), Full);
        assert_eq!(
            parse_range(Some("bytes=0-9"), 100),
            Partial { start: 0, end: 9 }
        );
        assert_eq!(
            parse_range(Some("bytes=90-"), 100),
            Partial { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=90-500"), 100),
            Partial { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-10"), 100),
            Partial { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-500"), 100),
            Partial { start: 0, end: 99 }
        );
        assert_eq!(parse_range(Some("bytes=100-"), 100), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-0"), 0), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Full);
        assert_eq!(parse_range(Some("bytes=abc"), 100), Full);
        assert_eq!(parse_range(Some("bytes=9-1"), 100), Full);
        assert_eq!(parse_range(Some("items=0-1"), 100), Full);
    }

    #[test]
    fn content_disposition_is_always_valid() {
        let v = content_disposition("inline", "Buku \"Rahasia\" — 日本.pdf");
        let s = v.to_str().unwrap();
        assert!(s.starts_with("inline; filename=\"Buku _Rahasia_ _ __.pdf\""));
        assert!(s.contains(
            "filename*=UTF-8''Buku%20%22Rahasia%22%20%E2%80%94%20%E6%97%A5%E6%9C%AC.pdf"
        ));

        // Karakter kontrol / CRLF tidak boleh lolos ke header (header injection)
        let v = content_disposition("inline", "a\r\nSet-Cookie: x=1.pdf");
        assert!(!v.to_str().unwrap().contains('\n'));
    }
}
