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
}

fn non_empty(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
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
            secure_cookies: non_empty("OPENSHELF_SECURE_COOKIE")
                .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes")),
            frontend_dir,
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("openshelf.db")
    }

    pub fn cover_cache_dir(&self) -> PathBuf {
        self.data_dir.join("covers")
    }
}
