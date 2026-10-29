use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::scanner::book_id_for;

/// Nilai `meta.book_id_scheme` setelah migrasi ID berbasis nama file.
const BOOK_ID_SCHEME: &str = "fnv1a-filename-v1";

pub async fn init_db(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    if let Some(dir) = db_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // SqliteConnectOptions::filename aman untuk path berisi spasi / karakter khusus.
    // sqlx menyalakan PRAGMA foreign_keys secara default.
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    migrate(&pool).await?;

    println!("📦 SQLite database ready at {}", db_path.display());
    Ok(pool)
}

/// Membuat tabel & data awal. Dipakai oleh init_db dan oleh test.
pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::Error> {
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
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS book_categories (
            book_id TEXT NOT NULL,
            category_id TEXT NOT NULL,
            PRIMARY KEY (book_id, category_id),
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    // Folder buku yang dipilih user di halaman Settings
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS library_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        "#,
    )
    .execute(pool)
    .await?;

    // Akun login. COLLATE NOCASE: "Reza" dan "reza" dianggap sama.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        "#,
    )
    .execute(pool)
    .await?;

    // Session login. Yang disimpan hanya SHA-256 dari token (bukan token aslinya),
    // jadi kalau file database bocor, isinya tidak bisa dipakai untuk login.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO categories (id, name) VALUES
            ('programming', 'Programming'),
            ('fiction', 'Fiction'),
            ('non-fiction', 'Non-Fiction'),
            ('philosophy', 'Philosophy'),
            ('favorites', 'Favorites');
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Migrasi ID buku: "1", "2", … → hash nama file
// ---------------------------------------------------------------------------

/// Hasil migrasi ID, untuk dicetak di log.
#[derive(Debug, Default, PartialEq)]
pub struct IdMigrationReport {
    pub migrated_rows: u64,
    pub dropped_orphans: u64,
    pub backup: Option<String>,
}

/// Memindahkan progres & koleksi dari ID lama (urutan file) ke ID baru
/// (hash nama file). Hanya berjalan sekali; ditandai di tabel `meta`.
///
/// `legacy` = pasangan (id_lama, nama_file) dari `scanner::legacy_positional_ids`,
/// yaitu urutan file SAAT INI dengan aturan lama. Asumsinya isi folder buku
/// belum berubah sejak server terakhir dijalankan.
///
/// Jika `db_path` diberikan, database di-backup dulu ke
/// `openshelf.db.bak-<timestamp>` sebelum ada yang diubah.
pub async fn migrate_legacy_book_ids(
    pool: &SqlitePool,
    legacy: &[(String, String)],
    db_path: Option<&Path>,
) -> Result<IdMigrationReport, sqlx::Error> {
    let scheme: Option<String> =
        sqlx::query_scalar("SELECT value FROM meta WHERE key = 'book_id_scheme'")
            .fetch_optional(pool)
            .await?;
    if scheme.as_deref() == Some(BOOK_ID_SCHEME) {
        return Ok(IdMigrationReport::default());
    }

    // ID lama = angka saja. Semua SQL di sini statis: sqlx 0.9 hanya menerima
    // string SQL statis (`&'static str`) untuk mencegah SQL injection.
    let legacy_rows: i64 = sqlx::query_scalar(
        r#"
        SELECT
            (SELECT COUNT(*) FROM reading_progress
             WHERE book_id <> '' AND book_id NOT GLOB '*[^0-9]*')
          + (SELECT COUNT(*) FROM book_categories
             WHERE book_id <> '' AND book_id NOT GLOB '*[^0-9]*')
        "#,
    )
    .fetch_one(pool)
    .await?;

    let mut report = IdMigrationReport::default();

    // Folder buku kosong/tidak terbaca padahal ada data lama: JANGAN migrasi,
    // kalau tidak semua data lama akan dianggap yatim dan dihapus.
    // Coba lagi di start berikutnya setelah BOOKS_DIR benar.
    if legacy_rows > 0 && legacy.is_empty() {
        eprintln!(
            "⚠️  Found {legacy_rows} rows with old book IDs, but the books folder is empty \
             or unreadable. Book ID migration postponed; check BOOKS_DIR."
        );
        return Ok(report);
    }

    if legacy_rows > 0 {
        if let Some(path) = db_path {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_extension(format!("db.bak-{stamp}"));
            // VACUUM INTO menerima ekspresi, jadi path bisa di-bind sebagai parameter
            sqlx::query("VACUUM INTO ?")
                .bind(backup.to_string_lossy().to_string())
                .execute(pool)
                .await?;
            report.backup = Some(backup.display().to_string());
        }

        let mut tx = pool.begin().await?;
        for (old_id, file_name) in legacy {
            let new_id = book_id_for(file_name);
            let progress =
                sqlx::query("UPDATE OR IGNORE reading_progress SET book_id = ? WHERE book_id = ?")
                    .bind(&new_id)
                    .bind(old_id)
                    .execute(&mut *tx)
                    .await?;
            let cats =
                sqlx::query("UPDATE OR IGNORE book_categories SET book_id = ? WHERE book_id = ?")
                    .bind(&new_id)
                    .bind(old_id)
                    .execute(&mut *tx)
                    .await?;
            report.migrated_rows += progress.rows_affected() + cats.rows_affected();
        }

        // Sisa ID angka = buku yang filenya sudah tidak ada; tidak bisa dipetakan.
        let p = sqlx::query(
            "DELETE FROM reading_progress WHERE book_id <> '' AND book_id NOT GLOB '*[^0-9]*'",
        )
        .execute(&mut *tx)
        .await?;
        let c = sqlx::query(
            "DELETE FROM book_categories WHERE book_id <> '' AND book_id NOT GLOB '*[^0-9]*'",
        )
        .execute(&mut *tx)
        .await?;
        report.dropped_orphans = p.rows_affected() + c.rows_affected();

        mark_scheme(&mut tx).await?;
        tx.commit().await?;
    } else {
        let mut conn = pool.acquire().await?;
        mark_scheme(&mut conn).await?;
    }

    Ok(report)
}

async fn mark_scheme(conn: &mut sqlx::SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT OR REPLACE INTO meta (key, value) VALUES ('book_id_scheme', ?)")
        .bind(BOOK_ID_SCHEME)
        .execute(conn)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Folder library
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow, Clone, Debug, Serialize)]
pub struct LibraryFolder {
    pub id: i64,
    pub path: String,
}

pub async fn list_folders(pool: &SqlitePool) -> Result<Vec<LibraryFolder>, sqlx::Error> {
    sqlx::query_as::<_, LibraryFolder>("SELECT id, path FROM library_folders ORDER BY path ASC")
        .fetch_all(pool)
        .await
}

pub async fn add_folder(pool: &SqlitePool, path: &str) -> Result<LibraryFolder, sqlx::Error> {
    let res = sqlx::query("INSERT INTO library_folders (path) VALUES (?)")
        .bind(path)
        .execute(pool)
        .await?;
    Ok(LibraryFolder {
        id: res.last_insert_rowid(),
        path: path.to_string(),
    })
}

/// Mengembalikan `true` jika ada folder yang terhapus.
pub async fn delete_folder(pool: &SqlitePool, id: i64) -> Result<bool, sqlx::Error> {
    let res = sqlx::query("DELETE FROM library_folders WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

// ---------------------------------------------------------------------------
// Akun & session
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow, Clone, Debug)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub async fn count_users(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await
}

pub async fn find_user(pool: &SqlitePool, username: &str) -> Result<Option<User>, sqlx::Error> {
    sqlx::query_as::<_, User>("SELECT id, username, password_hash FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await
}

/// Membuat akun PERTAMA. Mengembalikan None jika sudah ada akun.
/// Pengecekan & insert dalam satu query, jadi dua request setup yang
/// bersamaan tidak bisa sama-sama berhasil (race condition).
pub async fn create_first_user(
    pool: &SqlitePool,
    username: &str,
    password_hash: &str,
) -> Result<Option<i64>, sqlx::Error> {
    let res = sqlx::query(
        r#"
        INSERT INTO users (username, password_hash)
        SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)
        "#,
    )
    .bind(username)
    .bind(password_hash)
    .execute(pool)
    .await?;
    Ok((res.rows_affected() == 1).then(|| res.last_insert_rowid()))
}

pub async fn create_session(
    pool: &SqlitePool,
    token_hash: &str,
    user_id: i64,
    expires_at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(token_hash)
        .bind(user_id)
        .bind(expires_at)
        .execute(pool)
        .await?;
    Ok(())
}

/// User pemilik session yang masih berlaku.
pub async fn user_for_session(
    pool: &SqlitePool,
    token_hash: &str,
) -> Result<Option<User>, sqlx::Error> {
    sqlx::query_as::<_, User>(
        r#"
        SELECT u.id, u.username, u.password_hash
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
        "#,
    )
    .bind(token_hash)
    .bind(now_unix())
    .fetch_optional(pool)
    .await
}

pub async fn delete_session(pool: &SqlitePool, token_hash: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(token_hash)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_expired_sessions(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    let res = sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(now_unix())
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ReadingProgress {
    pub book_id: String,
    pub current_page: i64,
    pub total_pages: i64,
    pub progress_percent: f64,
    pub updated_at: Option<String>,
}

#[derive(Serialize, Deserialize, sqlx::FromRow, Clone, Debug)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub book_count: i64,
}

#[derive(Deserialize)]
pub struct CreateCategoryPayload {
    pub name: String,
}

#[derive(Deserialize)]
pub struct SetBookCategoriesPayload {
    #[serde(alias = "category_id")]
    pub category_ids: Vec<String>,
}

#[derive(Deserialize)]
pub struct SaveProgressPayload {
    pub current_page: i64,
    pub total_pages: i64,
}

// ---------------------------------------------------------------------------
// Progres baca
// ---------------------------------------------------------------------------

pub async fn get_progress(pool: &SqlitePool, book_id: &str) -> Option<ReadingProgress> {
    sqlx::query_as::<_, ReadingProgress>(
        "SELECT book_id, current_page, total_pages, progress_percent, updated_at FROM reading_progress WHERE book_id = ?"
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await
    .ok()?
}

pub async fn get_all_progress_map(pool: &SqlitePool) -> HashMap<String, ReadingProgress> {
    let mut map = HashMap::new();
    if let Ok(rows) = sqlx::query_as::<_, ReadingProgress>(
        "SELECT book_id, current_page, total_pages, progress_percent, updated_at FROM reading_progress",
    )
    .fetch_all(pool)
    .await
    {
        for row in rows {
            map.insert(row.book_id.clone(), row);
        }
    }
    map
}

pub async fn save_progress(
    pool: &SqlitePool,
    book_id: &str,
    current_page: i64,
    total_pages: i64,
) -> Result<(), sqlx::Error> {
    let total = total_pages.max(1);
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

// ---------------------------------------------------------------------------
// Koleksi / kategori
// ---------------------------------------------------------------------------

pub const MAX_CATEGORY_NAME_CHARS: usize = 50;

/// "Self Improvement!!" → "self-improvement". Huruf non-ASCII (é, 日) dipertahankan.
pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_string()
}

pub async fn get_categories(pool: &SqlitePool) -> Result<Vec<Category>, sqlx::Error> {
    sqlx::query_as::<_, Category>(
        r#"
        SELECT
            c.id,
            c.name,
            COUNT(bc.book_id) AS book_count
        FROM categories c
        LEFT JOIN book_categories bc ON c.id = bc.category_id
        GROUP BY c.id, c.name
        ORDER BY c.name ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

/// Nama harus sudah divalidasi pemanggil (lihat routes::create_category).
pub async fn create_category(pool: &SqlitePool, name: &str) -> Result<Category, sqlx::Error> {
    let name = name.trim();
    let id = slugify(name);
    sqlx::query("INSERT INTO categories (id, name) VALUES (?, ?)")
        .bind(&id)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(Category {
        id,
        name: name.to_string(),
        book_count: 0,
    })
}

/// Mengembalikan `true` jika ada kategori yang terhapus.
pub async fn delete_category(pool: &SqlitePool, category_id: &str) -> Result<bool, sqlx::Error> {
    let res = sqlx::query("DELETE FROM categories WHERE id = ?")
        .bind(category_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// All (category_id, book_id) pairs, including books whose files aren't
/// currently in the library (folder removed). That data is kept on purpose so
/// the collections come back when the folder is added again.
pub async fn get_category_memberships(
    pool: &SqlitePool,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    sqlx::query_as("SELECT category_id, book_id FROM book_categories")
        .fetch_all(pool)
        .await
}

pub async fn get_all_book_categories_map(pool: &SqlitePool) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    #[derive(sqlx::FromRow)]
    struct Row {
        book_id: String,
        category_name: String,
    }
    if let Ok(rows) = sqlx::query_as::<_, Row>(
        r#"
        SELECT bc.book_id, c.name as category_name
        FROM book_categories bc
        JOIN categories c ON bc.category_id = c.id
        ORDER BY c.name ASC
        "#,
    )
    .fetch_all(pool)
    .await
    {
        for row in rows {
            map.entry(row.book_id).or_default().push(row.category_name);
        }
    }
    map
}

/// Mengganti semua kategori sebuah buku, lalu mengembalikan nama-nama
/// kategori yang benar-benar tersimpan (urut nama).
///
/// ID kategori yang tidak ada di tabel `categories` dilewati dengan aman
/// (INSERT ... SELECT hanya menyisipkan jika kategorinya ada), sehingga
/// tidak pernah memicu error FOREIGN KEY.
pub async fn set_book_categories(
    pool: &SqlitePool,
    book_id: &str,
    category_ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    // Gunakan transaksi agar penghapusan & penambahan atomic
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM book_categories WHERE book_id = ?")
        .bind(book_id)
        .execute(&mut *tx)
        .await?;
    for cat_id in category_ids {
        sqlx::query(
            r#"
            INSERT OR IGNORE INTO book_categories (book_id, category_id)
            SELECT ?, id FROM categories WHERE id = ?
            "#,
        )
        .bind(book_id)
        .bind(cat_id)
        .execute(&mut *tx)
        .await?;
    }
    let names = sqlx::query_scalar::<_, String>(
        r#"
        SELECT c.name
        FROM book_categories bc
        JOIN categories c ON c.id = bc.category_id
        WHERE bc.book_id = ?
        ORDER BY c.name ASC
        "#,
    )
    .bind(book_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Satu koneksi saja: setiap koneksi `sqlite::memory:` punya database
    /// kosong sendiri, jadi pool dengan >1 koneksi bisa "kehilangan" tabel.
    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        migrate(&pool).await.unwrap();
        pool
    }

    #[test]
    fn slugify_cases() {
        assert_eq!(slugify("Self Improvment"), "self-improvment");
        assert_eq!(slugify("  Rust  &  Go!! "), "rust-go");
        assert_eq!(slugify("C++"), "c");
        assert_eq!(slugify("!!!"), "");
        assert_eq!(slugify("Café Été"), "café-été");
    }

    #[tokio::test]
    async fn test_categories_crud() {
        let pool = test_pool().await;

        // 5 kategori bawaan + 1 baru
        let created = create_category(&pool, "Rust").await.unwrap();
        assert_eq!(created.id, "rust");
        let cats = get_categories(&pool).await.unwrap();
        assert_eq!(cats.len(), 6);
        assert!(cats.iter().any(|c| c.name == "Rust"));

        let saved = set_book_categories(&pool, "1", &["rust".to_string(), "fiction".to_string()])
            .await
            .unwrap();
        assert_eq!(saved, vec!["Fiction".to_string(), "Rust".to_string()]);

        let map = get_all_book_categories_map(&pool).await;
        assert_eq!(map.get("1"), Some(&saved));

        let rust = get_categories(&pool)
            .await
            .unwrap()
            .into_iter()
            .find(|c| c.id == "rust")
            .unwrap();
        assert_eq!(rust.book_count, 1);
    }

    #[tokio::test]
    async fn test_duplicate_category_is_unique_violation() {
        let pool = test_pool().await;
        let err = create_category(&pool, "Fiction").await.unwrap_err();
        assert!(
            err.as_database_error()
                .is_some_and(|e| e.is_unique_violation())
        );
    }

    #[tokio::test]
    async fn test_unknown_category_is_skipped_not_error() {
        let pool = test_pool().await;
        let saved = set_book_categories(
            &pool,
            "1",
            &["programming".to_string(), "does-not-exist".to_string()],
        )
        .await
        .expect("kategori tak dikenal tidak boleh membuat error");
        assert_eq!(saved, vec!["Programming".to_string()]);
    }

    #[tokio::test]
    async fn test_replace_and_clear_categories() {
        let pool = test_pool().await;
        set_book_categories(&pool, "1", &["fiction".to_string()])
            .await
            .unwrap();
        let saved = set_book_categories(&pool, "1", &["philosophy".to_string()])
            .await
            .unwrap();
        assert_eq!(saved, vec!["Philosophy".to_string()]);

        let cleared = set_book_categories(&pool, "1", &[]).await.unwrap();
        assert!(cleared.is_empty());
    }

    #[tokio::test]
    async fn test_delete_category_cascades() {
        let pool = test_pool().await;
        set_book_categories(&pool, "1", &["fiction".to_string()])
            .await
            .unwrap();
        assert!(delete_category(&pool, "fiction").await.unwrap());
        assert!(!delete_category(&pool, "fiction").await.unwrap());
        let map = get_all_book_categories_map(&pool).await;
        assert!(!map.contains_key("1"));
    }

    #[tokio::test]
    async fn test_library_folders() {
        let pool = test_pool().await;
        assert!(list_folders(&pool).await.unwrap().is_empty());
        let a = add_folder(&pool, "/books/b").await.unwrap();
        add_folder(&pool, "/books/a").await.unwrap();
        let err = add_folder(&pool, "/books/b").await.unwrap_err();
        assert!(
            err.as_database_error()
                .is_some_and(|e| e.is_unique_violation())
        );

        let paths: Vec<_> = list_folders(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(paths, ["/books/a", "/books/b"]);
        assert!(delete_folder(&pool, a.id).await.unwrap());
        assert!(!delete_folder(&pool, a.id).await.unwrap());
        assert_eq!(list_folders(&pool).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_first_user_only_once_and_case_insensitive() {
        let pool = test_pool().await;
        assert_eq!(count_users(&pool).await.unwrap(), 0);
        let id = create_first_user(&pool, "Reza", "hash1").await.unwrap();
        assert!(id.is_some());
        // Akun kedua lewat setup harus ditolak
        assert_eq!(
            create_first_user(&pool, "lain", "hash2").await.unwrap(),
            None
        );
        assert_eq!(count_users(&pool).await.unwrap(), 1);
        // Username tidak peka huruf besar/kecil
        let u = find_user(&pool, "reza").await.unwrap().unwrap();
        assert_eq!(u.username, "Reza");
        assert!(find_user(&pool, "orang").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_sessions_expire_and_delete() {
        let pool = test_pool().await;
        let id = create_first_user(&pool, "reza", "h")
            .await
            .unwrap()
            .unwrap();
        create_session(&pool, "aktif", id, now_unix() + 3600)
            .await
            .unwrap();
        create_session(&pool, "kedaluwarsa", id, now_unix() - 1)
            .await
            .unwrap();

        assert_eq!(
            user_for_session(&pool, "aktif").await.unwrap().unwrap().id,
            id
        );
        assert!(
            user_for_session(&pool, "kedaluwarsa")
                .await
                .unwrap()
                .is_none()
        );
        assert!(user_for_session(&pool, "ngawur").await.unwrap().is_none());

        assert_eq!(delete_expired_sessions(&pool).await.unwrap(), 1);
        delete_session(&pool, "aktif").await.unwrap();
        assert!(user_for_session(&pool, "aktif").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_migration_skipped_when_books_dir_empty() {
        let pool = test_pool().await;
        save_progress(&pool, "1", 9, 256).await.unwrap();
        let report = migrate_legacy_book_ids(&pool, &[], None).await.unwrap();
        assert_eq!(report, IdMigrationReport::default());
        // Data lama masih utuh, dan migrasi belum ditandai selesai
        assert!(get_progress(&pool, "1").await.is_some());
        let scheme: Option<String> =
            sqlx::query_scalar("SELECT value FROM meta WHERE key = 'book_id_scheme'")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(scheme.is_none());
    }

    #[tokio::test]
    async fn test_legacy_id_migration() {
        let pool = test_pool().await;
        // Data gaya lama: ID = urutan file
        save_progress(&pool, "1", 9, 256).await.unwrap();
        save_progress(&pool, "4", 2, 250).await.unwrap();
        set_book_categories(&pool, "1", &["philosophy".to_string()])
            .await
            .unwrap();
        set_book_categories(&pool, "3", &["fiction".to_string()])
            .await
            .unwrap();
        set_book_categories(&pool, "9", &["fiction".to_string()])
            .await
            .unwrap(); // file sudah hilang

        let legacy = vec![
            ("1".to_string(), "A.pdf".to_string()),
            ("2".to_string(), "B.pdf".to_string()),
            ("3".to_string(), "C.epub".to_string()),
            ("4".to_string(), "D.pdf".to_string()),
        ];
        let report = migrate_legacy_book_ids(&pool, &legacy, None).await.unwrap();
        assert_eq!(report.migrated_rows, 4);
        assert_eq!(report.dropped_orphans, 1);

        let a = book_id_for("A.pdf");
        assert_eq!(get_progress(&pool, &a).await.unwrap().current_page, 9);
        assert_eq!(
            get_progress(&pool, &book_id_for("D.pdf"))
                .await
                .unwrap()
                .current_page,
            2
        );
        assert!(get_progress(&pool, "1").await.is_none());
        let map = get_all_book_categories_map(&pool).await;
        assert_eq!(map.get(&a), Some(&vec!["Philosophy".to_string()]));
        assert_eq!(
            map.get(&book_id_for("C.epub")),
            Some(&vec!["Fiction".to_string()])
        );
        assert!(!map.contains_key("9"));

        // Kedua kali: tidak melakukan apa-apa
        save_progress(&pool, "2", 1, 10).await.unwrap();
        let again = migrate_legacy_book_ids(&pool, &legacy, None).await.unwrap();
        assert_eq!(again, IdMigrationReport::default());
        assert!(get_progress(&pool, "2").await.is_some());
    }
}
