//! Konfigurasi dari environment variable.
//!
//! | Variabel                | Default                                   |
//! |-------------------------|-------------------------------------------|
//! | `BOOKS_DIR`             | (opsional) folder awal library — hanya dipakai jika belum ada folder di Settings |
//! | `OPENSHELF_DATA_DIR`    | `<folder backend>/data` (db + cache cover) |
//! | `OPENSHELF_BIND`        | `0.0.0.0:3000` (`127.0.0.1:3000` = hanya komputer ini) |
//! | `OPENSHELF_CORS_ORIGIN` | (kosong = tidak ada CORS, same-origin saja) |
//! | `OPENSHELF_SECURE_COOKIE` | `false`; set `true` jika diakses lewat HTTPS |
//! | `OPENSHELF_FRONTEND_DIR` | `<folder repo>/frontend/dist` (hasil `pnpm build`) |
//! | `OPENSHELF_BROWSE_ROOTS` | `$HOME:/mnt:/media:/run/media:/srv` — folder yang boleh dijelajahi & dijadikan library (`/` = semua) |
//! | `OPENSHELF_TRUST_PROXY` | `false`; set `true` jika di belakang Nginx/Caddy (IP client dari `X-Forwarded-For`) |

use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    /// Folder awal library dari env `BOOKS_DIR`. Folder sebenarnya diatur di Settings.
    pub seed_books_dir: Option<PathBuf>,
    pub data_dir: PathBuf,
    pub bind_addr: String,
    pub cors_origin: Option<String>,
    /// Tambahkan flag `Secure` ke cookie session (wajib saat lewat HTTPS).
    pub secure_cookies: bool,
    /// Hasil build frontend yang disajikan backend (lihat `frontend.rs`).
    pub frontend_dir: PathBuf,
    /// Hanya folder di dalam salah satu path ini yang bisa dijelajahi dan
    /// ditambahkan sebagai library dari Settings. Sudah di-canonicalize.
    pub browse_roots: Vec<PathBuf>,
    /// Ambil IP client dari `X-Forwarded-For` (untuk batas percobaan login).
    pub trust_proxy: bool,
}

fn non_empty(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn flag(key: &str) -> bool {
    non_empty(key).is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
}

/// Path yang ada saja, di-canonicalize, tanpa duplikat / yang sudah tercakup path lain.
fn browse_roots(raw: Option<String>) -> Vec<PathBuf> {
    let candidates: Vec<PathBuf> = match raw {
        Some(list) => env::split_paths(&list).collect(),
        None => env::var_os("HOME")
            .map(PathBuf::from)
            .into_iter()
            .chain(["/mnt", "/media", "/run/media", "/srv"].map(PathBuf::from))
            .collect(),
    };
    let mut roots: Vec<PathBuf> = candidates
        .into_iter()
        .filter_map(|p| p.canonicalize().ok())
        .filter(|p| p.is_dir())
        .collect();
    roots.sort();
    roots.dedup();
    let all = roots.clone();
    roots.retain(|r| !all.iter().any(|o| o != r && r.starts_with(o)));
    roots
}

impl Config {
    pub fn from_env() -> Self {
        let seed_books_dir = non_empty("BOOKS_DIR")
            .map(PathBuf::from)
            .map(|p| p.canonicalize().unwrap_or(p));

        // Default: selalu folder `backend/data`, apa pun folder kerja saat `cargo run`.
        // Sebelumnya path relatif membuat dua database (data/ dan backend/data/).
        let data_dir = non_empty("OPENSHELF_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/data")));

        let bind_addr = non_empty("OPENSHELF_BIND").unwrap_or_else(|| "0.0.0.0:3000".into());

        let frontend_dir = non_empty("OPENSHELF_FRONTEND_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../frontend/dist"))
            });
        // ".../backend/../frontend/dist" → ".../frontend/dist" (jika sudah ada)
        let frontend_dir = frontend_dir.canonicalize().unwrap_or(frontend_dir);

        Config {
            seed_books_dir,
            data_dir,
            bind_addr,
            cors_origin: non_empty("OPENSHELF_CORS_ORIGIN"),
            secure_cookies: flag("OPENSHELF_SECURE_COOKIE"),
            frontend_dir,
            browse_roots: browse_roots(non_empty("OPENSHELF_BROWSE_ROOTS")),
            trust_proxy: flag("OPENSHELF_TRUST_PROXY"),
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("openshelf.db")
    }

    pub fn cover_cache_dir(&self) -> PathBuf {
        self.data_dir.join("covers")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browse_roots_drop_missing_and_nested() {
        let base = env::temp_dir().join(format!("openshelf-roots-{}", std::process::id()));
        std::fs::create_dir_all(base.join("a/inner")).unwrap();
        std::fs::create_dir_all(base.join("b")).unwrap();
        let base = base.canonicalize().unwrap();
        let list = format!(
            "{0}/a:{0}/a/inner:{0}/b:{0}/b:{0}/tidak-ada",
            base.display()
        );
        assert_eq!(
            browse_roots(Some(list)),
            [base.join("a"), base.join("b")]
        );
        assert_eq!(browse_roots(Some("/".into())), [PathBuf::from("/")]);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
