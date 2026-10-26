use axum::{
    Json,
    extract::Path,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use serde::Serialize;
use std::env;

use crate::scanner::{self, BookFormat, BookItem};

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

pub async fn get_book_raw(
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, &'static str)> {
    let books_dir =
        env::var("BOOKS_DIR").unwrap_or_else(|_| "/home/kernelcraft/Documents/E-Book".to_string());
    let book = scanner::find_book_by_id(&books_dir, &id)
        .ok_or((StatusCode::NOT_FOUND, "Buku tidak ditemukan"))?;
    let file_path = std::path::Path::new(&books_dir).join(&book.file_name);
    let file_bytes = tokio::fs::read(&file_path).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Gagal membaca file dari disk",
        )
    })?;
    let mime_type = match book.format {
        BookFormat::Pdf => "application/pdf",
        BookFormat::Epub => "application/epub+zip",
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, mime_type.parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        format!("inline; filename=\"{}\"", book.file_name)
            .parse()
            .unwrap(),
    );
    Ok((headers, file_bytes))
}
pub async fn get_book_cover(
    Path(id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, &'static str)> {
    let books_dir = env::var("BOOKS_DIR").unwrap_or_else(|_| "/home/kernelcraft/Document/E-Book".to_string());
    let book = scanner::find_book_by_id(&books_dir, &id).ok_or((StatusCode::NOT_FOUND, "Buku tidak ditemukan"))?;

    let file_path = std::path::Path::new(&books_dir).join(&book.file_name);

    if let Some((bytes, mime)) = scanner::extract_epub_cover(&file_path) {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, mime.parse().unwrap());
        return Ok((headers, bytes))
    };

    let format_str = match book.format{
        BookFormat::Pdf => "PDF",
        BookFormat::Epub => "EPUB"
    };
    let svg_bytes = scanner::generate_svg_cover(&book.title, format_str);
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "image/svg+xml".parse().unwrap());
    Ok((headers,svg_bytes))
}
