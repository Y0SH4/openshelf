use axum::Json;
use serde::Serialize;
use std::env;

use crate::scanner::{self, BookItem};

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub message: String,
}

pub async fn health_check() -> Json<HealthResponse> {
    let response = HealthResponse {
        status: "oke".to_string(),
        version: "0.1.0".to_string(),
        message: "OpenShelf API is Helath!".to_string(),
    };

    Json(response)
}

pub async fn get_books() -> Json<Vec<BookItem>> {
    let books_dir =
        env::var("BOOKS_DIR").unwrap_or_else(|_| "/home/kernelcraft/Documents/E-Book".to_string());

    let books = scanner::scan_books_dir(&books_dir);
    Json(books)
}
