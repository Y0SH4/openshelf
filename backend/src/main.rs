use axum::{Router, routing::get};
use tower_http::cors::{Any, CorsLayer};

mod db;
mod routes;
mod scanner;

use routes::{
    get_book_cover, get_book_progress, get_book_raw, get_books, health_check, save_book_progress,
};

#[tokio::main]
async fn main() {
    let pool = db::init_db()
        .await
        .expect("Gagal menginisialisasi database SQLite");

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(health_check))
        .route("/api/books", get(get_books))
        .route("/api/books/{id}/raw", get(get_book_raw))
        .route("/api/books/{id}/cover", get(get_book_cover))
        .route(
            "/api/books/{id}/progress",
            get(get_book_progress).post(save_book_progress),
        )
        .with_state(pool)
        .layer(cors);

    let addr = "0.0.0.0:3000";
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    println!("OpenShelf backend running on http://{}", addr);

    axum::serve(listener, app).await.unwrap()
}
