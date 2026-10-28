use axum::{
    Router,
    http::{HeaderValue, Method, header},
    middleware,
    routing::{any, delete, get, post},
};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

mod auth;
mod config;
mod db;
mod folders;
mod frontend;
mod routes;
mod scanner;

use config::Config;
use routes::AppState;
use scanner::{Library, LibraryRoot};

#[tokio::main]
async fn main() {
    let config = Arc::new(Config::from_env());

    let pool = db::init_db(&config.db_path())
        .await
        .expect("Gagal menginisialisasi database SQLite");

    // Folder library diatur di halaman Settings. BOOKS_DIR (opsional) hanya
    // dipakai sekali sebagai folder awal jika daftar folder masih kosong.
    let mut folders = db::list_folders(&pool)
        .await
        .expect("Gagal membaca folder library");
    if folders.is_empty() {
        if let Some(seed) = config.seed_books_dir.as_ref().filter(|p| p.is_dir()) {
            match db::add_folder(&pool, &seed.to_string_lossy()).await {
                Ok(folder) => {
                    println!("📚 Folder library awal dari BOOKS_DIR: {}", folder.path);
                    folders.push(folder);
                }
                Err(e) => eprintln!("⚠️  Gagal menambah BOOKS_DIR sebagai folder library: {e}"),
            }
        }
    }
    let roots: Vec<LibraryRoot> = folders
        .iter()
        .map(|f| LibraryRoot {
            id: f.id,
            path: f.path.clone().into(),
        })
        .collect();

    // Sekali saja: pindahkan progres & koleksi dari ID lama (1, 2, 3, …) ke ID baru.
    let legacy = roots
        .first()
        .map(|r| scanner::legacy_positional_ids(&r.path))
        .unwrap_or_default();
    match db::migrate_legacy_book_ids(&pool, &legacy, Some(&config.db_path())).await {
        Ok(report) if report.migrated_rows > 0 || report.dropped_orphans > 0 => {
            println!(
                "🔁 Migrasi ID buku: {} baris dipindah, {} baris yatim dihapus. Backup: {}",
                report.migrated_rows,
                report.dropped_orphans,
                report.backup.as_deref().unwrap_or("-")
            );
        }
        Ok(_) => {}
        Err(e) => panic!("Migrasi ID buku gagal (database tidak diubah): {e}"),
    }

    if roots.is_empty() {
        println!("📚 Belum ada folder library — tambahkan lewat Settings di aplikasi.");
    } else {
        for root in &roots {
            println!("📚 Folder library: {}", root.path.display());
        }
    }

    let state = AppState {
        pool,
        library: Arc::new(Library::new(roots)),
        config: config.clone(),
    };

    let app = Router::new()
        .route("/api/health", get(routes::health_check))
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/setup", post(auth::setup))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route(
            "/api/library/folders",
            get(folders::list).post(folders::add),
        )
        .route("/api/library/folders/{id}", delete(folders::remove))
        .route("/api/library/scan", post(folders::rescan))
        .route("/api/fs/browse", get(folders::browse))
        .route("/api/books", get(routes::get_books))
        .route("/api/books/{id}/raw", get(routes::get_book_raw))
        .route("/api/books/{id}/cover", get(routes::get_book_cover))
        .route(
            "/api/books/{id}/progress",
            get(routes::get_book_progress).post(routes::save_book_progress),
        )
        .route(
            "/api/books/{id}/categories",
            post(routes::set_book_categories),
        )
        .route(
            "/api/categories",
            get(routes::get_categories).post(routes::create_category),
        )
        .route("/api/categories/{id}", delete(routes::delete_category))
        .route("/api/{*rest}", any(frontend::api_not_found));

    // Hasil build frontend (production). Saat development Vite yang menyajikannya.
    let app = match frontend::routes(&config.frontend_dir) {
        Some(files) => {
            println!("🖥️  Frontend disajikan dari {}", config.frontend_dir.display());
            app.merge(files)
        }
        None => {
            println!(
                "🖥️  Frontend belum di-build ({} tidak ada) — pakai `pnpm dev` atau `just build`",
                config.frontend_dir.display()
            );
            app
        }
    };

    let app = app
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_session,
        ))
        .with_state(state);

    // CORS hanya jika diminta. Saat development, Vite mem-proxy /api sehingga
    // semuanya same-origin dan CORS tidak dibutuhkan. Dulu: allow_origin(Any),
    // artinya website mana pun bisa memakai API ini lewat browser kamu.
    let app = match config.cors_origin.as_deref().map(HeaderValue::from_str) {
        Some(Ok(origin)) => app.layer(
            CorsLayer::new()
                .allow_origin(origin)
                .allow_methods([Method::GET, Method::POST, Method::DELETE])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::RANGE])
                .expose_headers([
                    header::CONTENT_RANGE,
                    header::ACCEPT_RANGES,
                    header::CONTENT_LENGTH,
                ])
                .allow_credentials(true),
        ),
        Some(Err(_)) => {
            eprintln!("⚠️  OPENSHELF_CORS_ORIGIN tidak valid, CORS dimatikan");
            app
        }
        None => app,
    };

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .unwrap_or_else(|e| panic!("Tidak bisa listen di {}: {e}", config.bind_addr));

    println!("OpenShelf backend running on http://{}", config.bind_addr);

    axum::serve(listener, app).await.unwrap()
}
