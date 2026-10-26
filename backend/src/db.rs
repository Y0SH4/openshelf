use serde::{Deserialize, Serialize};
use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
use std::fs;
use std::path::Path;

pub async fn init_db() -> Result<SqlitePool, sqlx::Error> {
    let data_dir = Path::new("data");
    let _ = fs::create_dir_all(data_dir);
    let db_url = "sqlite:data/openshelf.db?mode=rwc";
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(db_url)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS reading_progress (
            book_id TEXT PRIMARY KEY,
            current_page INTEGER NOT NULL DEFAULT 1,
            total_pages INTEGER NOT NULL DEFAULT 1,
            progress_percent REAL NOT NULL DEFAULT 0.0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        "#,
    )
    .execute(&pool)
    .await?;

    println!("📦 Database SQLite siap di data/openshelf.db");
    Ok(pool)
}

#[derive(Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ReadingProgress {
    pub book_id: String,
    pub current_page: i64,
    pub total_pages: i64,
    pub progress_percent: f64,
    pub updated_at: Option<String>,
}

#[derive(Deserialize)]
pub struct SaveProgressPayload {
    pub current_page: i64,
    pub total_pages: i64,
}

pub async fn get_progress(pool: &SqlitePool, book_id: &str) -> Option<ReadingProgress> {
    sqlx::query_as::<_, ReadingProgress>(
        "SELECT book_id, current_page, total_pages, progress_percent, updated_at FROM reading_progress WHERE book_id = ?"
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await
    .ok()?
}

pub async fn save_progress(
    pool: &SqlitePool,
    book_id: &str,
    current_page: i64,
    total_pages: i64,
) -> Result<(), sqlx::Error> {
    let total = if total_pages <= 0 { 1 } else { total_pages };
    let percent = (current_page as f64 / total as f64) * 100.0;
    let clamped_percent = percent.clamp(0.0, 100.0);

    sqlx::query(
        r#"
        INSERT INTO reading_progress (book_id, current_page, total_pages, progress_percent, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(book_id) DO UPDATE SET
            current_page = excluded.current_page,
            total_pages = excluded.total_pages,
            progress_percent = excluded.progress_percent,
            updated_at = CURRENT_TIMESTAMP
        "#,
    )
    .bind(book_id)
    .bind(current_page)
    .bind(total)
    .bind(clamped_percent)
    .execute(pool)
    .await?;
    Ok(())
}
