use axum::{
    Router,
    http::{HeaderValue, Method, header},
    middleware,
    routing::{any, delete, get, post},
};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;

mod auth;
mod config;
mod db;
mod folders;
mod frontend;
mod routes;
mod scanner;
mod security;

use config::Config;
use routes::AppState;
use scanner::{Library, LibraryRoot};
use security::LoginLimiter;

#[tokio::main]
async fn main() {
    let config = Arc::new(Config::from_env());

    let pool = db::init_db(&config.db_path())
        .await
        .expect("Failed to initialize the SQLite database");

    let mut folders = db::list_folders(&pool)
        .await
        .expect("Failed to read library folders");
    if folders.is_empty()
        && let Some(seed) = config.seed_books_dir.as_ref().filter(|p| p.is_dir())
    {
        match db::add_folder(&pool, &seed.to_string_lossy()).await {
            Ok(folder) => {
                println!(
                    "📚 Added BOOKS_DIR as the first library folder: {}",
                    folder.path
                );
                folders.push(folder);
            }
            Err(e) => eprintln!("⚠️  Couldn't add BOOKS_DIR as a library folder: {e}"),
        }
    }
    let roots: Vec<LibraryRoot> = folders
        .iter()
        .map(|f| LibraryRoot {
            id: f.id,
            path: f.path.clone().into(),
        })
        .collect();

    let legacy = roots
        .first()
        .map(|r| scanner::legacy_positional_ids(&r.path))
        .unwrap_or_default();
    match db::migrate_legacy_book_ids(&pool, &legacy, Some(&config.db_path())).await {
        Ok(report) if report.migrated_rows > 0 || report.dropped_orphans > 0 => {
            println!(
                "🔁 Book ID migration: {} rows moved, {} orphaned rows removed. Backup: {}",
                report.migrated_rows,
                report.dropped_orphans,
                report.backup.as_deref().unwrap_or("-")
            );
        }
        Ok(_) => {}
        Err(e) => panic!("Book ID migration failed (database unchanged): {e}"),
    }

    if roots.is_empty() {
        println!("📚 No library folders yet. Add one in Settings in the app.");
    } else {
        for root in &roots {
            println!("📚 Library folder: {}", root.path.display());
        }
    }

    let library = Arc::new(Library::new(roots));
    // Initial scan in the background, so the first request doesn't wait
    // (noticeable when the books are on a sleeping HDD).
    {
        let library = library.clone();
        tokio::spawn(async move {
            let count = library.books().await.books().len();
            println!("📚 Initial scan done: {count} books");
        });
    }

    // Build the fallback sign-in hash now, so the first sign-in with an
    // unknown username isn't slower (see auth::DUMMY_HASH)
    tokio::task::spawn_blocking(auth::warm_up);

    if config.browse_roots.is_empty() {
        println!("📂 Choosing folders in Settings is turned off (OPENSHELF_BROWSE_ROOTS is empty)");
    } else {
        let list: Vec<_> = config
            .browse_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect();
        println!(
            "📂 Folders that can be chosen in Settings: {}",
            list.join(", ")
        );
    }

    let setup_code = match db::count_users(&pool).await {
        Ok(0) => {
            let code = auth::new_setup_code();
            println!();
            println!("🔑 No account yet. Open OpenShelf in your browser and create one");
            println!("   with this setup code:  {code}");
            println!("   (a new code is generated every time the server starts)");
            println!();
            Some(code)
        }
        Ok(_) => None,
        Err(e) => panic!("Failed to read accounts: {e}"),
    };

    let state = AppState {
        pool,
        library,
        config: config.clone(),
        login_limiter: Arc::new(LoginLimiter::default()),
        setup_code: Arc::new(std::sync::Mutex::new(setup_code)),
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

    let app = match frontend::routes(&config.frontend_dir) {
        Some(files) => {
            println!(
                "🖥️  Serving frontend from {}",
                config.frontend_dir.display()
            );
            app.merge(files)
        }
        None => {
            println!(
                "🖥️  Frontend not built ({} not found). Use `just dev` or run `just build` first",
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
        // SAMEORIGIN, not DENY: the reader iframes PDFs from this same server.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("SAMEORIGIN"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("same-origin"),
        ))
        .with_state(state);

    // CORS only when asked for; in development Vite proxies /api (same-origin).
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
            eprintln!("⚠️  OPENSHELF_CORS_ORIGIN is invalid, CORS disabled");
            app
        }
        None => app,
    };

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .unwrap_or_else(|e| panic!("Can't listen on {}: {e}", config.bind_addr));

    println!("OpenShelf backend running on http://{}", config.bind_addr);
    if let Ok(addr) = listener.local_addr()
        && !addr.ip().is_loopback()
        && !config.secure_cookies
    {
        println!(
            "⚠️  Reachable from the network over plain HTTP (not encrypted). Fine on a \
             home network; for internet access put it behind HTTPS (e.g. Caddy or \
             Nginx) and set OPENSHELF_SECURE_COOKIE=true and OPENSHELF_TRUST_PROXY=true."
        );
    }

    // ConnectInfo: client IP for the sign-in attempt limit
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .unwrap()
}
