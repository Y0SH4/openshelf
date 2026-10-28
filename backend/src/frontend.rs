//! Menyajikan hasil build frontend (`frontend/dist`) dari backend, supaya di
//! homeserver cukup satu program: buka `http://server:3000` dan selesai.
//!
//! - `/assets/*`  file JS/CSS dari Vite. Nama filenya berisi hash isi
//!   (mis. `index-DbR01WFa.js`), jadi boleh di-cache browser selamanya.
//! - URL lain     file di `dist/` jika ada (favicon, dll.), selain itu
//!   `index.html` agar SPA tetap jalan saat halaman di-refresh.
//!   Selalu `no-cache` supaya browser langsung memakai build terbaru.
//!
//! Saat development, Vite yang menyajikan frontend; modul ini tidak dipakai.

use axum::{
    Router,
    http::{HeaderValue, Response, StatusCode, header},
};
use std::path::Path;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeader;

/// Route untuk file frontend, atau `None` jika `dist/index.html` belum ada
/// (frontend belum di-build).
pub fn routes<S>(dist: &Path) -> Option<Router<S>>
where
    S: Clone + Send + Sync + 'static,
{
    let index = dist.join("index.html");
    if !index.is_file() {
        return None;
    }

    // Hanya respons sukses: 404 (mis. build lama minta file yang sudah hilang)
    // tidak boleh tersimpan di cache browser selama setahun.
    let assets = SetResponseHeader::overriding(
        ServeDir::new(dist.join("assets")),
        header::CACHE_CONTROL,
        |res: &Response<_>| {
            res.status()
                .is_success()
                .then(|| HeaderValue::from_static("public, max-age=31536000, immutable"))
        },
    );
    let app = SetResponseHeader::overriding(
        ServeDir::new(dist).fallback(ServeFile::new(index)),
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );

    Some(
        Router::new()
            .nest_service("/assets", assets)
            .fallback_service(app),
    )
}

/// `/api/...` yang tidak dikenal → 404, bukan `index.html`.
pub async fn api_not_found() -> (StatusCode, &'static str) {
    (StatusCode::NOT_FOUND, "Not found")
}
