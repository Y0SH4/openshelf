//! Serves the built frontend (`frontend/dist`) from the backend, so a
//! homeserver needs just one program: open `http://server:3000` and done.
//!
//! - `/assets/*`  JS/CSS from Vite. File names contain a content hash
//!   (e.g. `index-DbR01WFa.js`), so browsers may cache them forever.
//! - other URLs  the file in `dist/` if it exists (favicon, etc.), else
//!   `index.html` so the SPA still works when a page is reloaded.
//!   Always `no-cache` so browsers pick up a new build right away.
//!
//! In development Vite serves the frontend; this module isn't used.

use axum::{
    Router,
    http::{HeaderValue, Response, StatusCode, header},
};
use std::path::Path;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeader;

/// Routes for the frontend files, or `None` if `dist/index.html` doesn't
/// exist (frontend not built).
pub fn routes<S>(dist: &Path) -> Option<Router<S>>
where
    S: Clone + Send + Sync + 'static,
{
    let index = dist.join("index.html");
    if !index.is_file() {
        return None;
    }

    // Successful responses only: a 404 (e.g. an old build asking for a file
    // that's gone) must not stay in the browser cache for a year.
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

/// Unknown `/api/...` → 404, not `index.html`.
pub async fn api_not_found() -> (StatusCode, &'static str) {
    (StatusCode::NOT_FOUND, "Not found")
}
