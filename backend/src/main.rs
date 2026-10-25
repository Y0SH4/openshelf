use axum::{Router, routing::get};
use tower_http::cors::{Any, CorsLayer};

mod routes;
use routes::health_check;

#[tokio::main]
async fn main() {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(health_check))
        .layer(cors);

    let addr = "0.0.0.0:3000";
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    println!("OpenShelf backend running on http//{}", addr);

    axum::serve(listener, app).await.unwrap()
}
