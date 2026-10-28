//! Folder library yang dipilih user di halaman Settings, plus penjelajah
//! folder server untuk memilihnya.
//!
//! GET    /api/library/folders        daftar folder + jumlah buku
//! POST   /api/library/folders        { "path": "/home/me/Books" }
//! DELETE /api/library/folders/{id}
//! POST   /api/library/scan           paksa scan ulang
//! GET    /api/fs/browse?path=/home   isi sebuah folder (hanya sub-folder)

use axum::{
    Json,
    extract::{Path as UrlPath, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::db;
use crate::routes::{ApiError, AppState};
use crate::scanner::{BookFormat, LibraryRoot};

#[derive(Serialize)]
pub struct FolderInfo {
    pub id: i64,
    pub path: String,
    /// false jika folder sudah tidak ada / tidak bisa dibaca (mis. HDD dilepas)
    pub available: bool,
    pub book_count: usize,
}

#[derive(Deserialize)]
pub struct AddFolderPayload {
    pub path: String,
}

#[derive(Serialize)]
pub struct ScanResult {
    pub book_count: usize,
}

/// Muat ulang daftar folder dari database ke `Library` (cache scan ikut direset).
pub async fn reload_roots(state: &AppState) -> Result<(), ApiError> {
    let folders = db::list_folders(&state.pool)
        .await
        .map_err(|e| ApiError::internal("Failed to read library folders", e))?;
    state.library.set_roots(
        folders
            .into_iter()
            .map(|f| LibraryRoot {
                id: f.id,
                path: PathBuf::from(f.path),
            })
            .collect(),
    );
    Ok(())
}

async fn folder_infos(state: &AppState) -> Vec<FolderInfo> {
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for book in state.library.books().await.books() {
        *counts.entry(book.folder_id).or_default() += 1;
    }
    state
        .library
        .roots()
        .into_iter()
        .map(|root| FolderInfo {
            id: root.id,
            available: root.path.is_dir(),
            book_count: counts.get(&root.id).copied().unwrap_or(0),
            path: root.path.to_string_lossy().to_string(),
        })
        .collect()
}

/// "~/Books" → "/home/me/Books"
fn expand_home(input: &str) -> PathBuf {
    match (input.strip_prefix('~'), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            PathBuf::from(home).join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(input),
    }
}

/// GET /api/library/folders
pub async fn list(State(state): State<AppState>) -> Json<Vec<FolderInfo>> {
    Json(folder_infos(&state).await)
}

/// POST /api/library/folders
pub async fn add(
    State(state): State<AppState>,
    Json(payload): Json<AddFolderPayload>,
) -> Result<(StatusCode, Json<Vec<FolderInfo>>), ApiError> {
    let raw = payload.path.trim();
    if raw.is_empty() {
        return Err(ApiError::bad_request("Choose a folder first"));
    }
    let path = expand_home(raw);
    if !path.is_absolute() {
        return Err(ApiError::bad_request(
            "Use a full path, e.g. /home/you/Books",
        ));
    }
    let path = path
        .canonicalize()
        .map_err(|_| ApiError::bad_request("Folder not found"))?;
    if !path.is_dir() {
        return Err(ApiError::bad_request("That path is a file, not a folder"));
    }

    // Folder di dalam folder lain akan di-scan dua kali → tolak
    for root in state.library.roots() {
        if path == root.path {
            return Err(ApiError::conflict("This folder is already in your library"));
        }
        if path.starts_with(&root.path) {
            return Err(ApiError::conflict(format!(
                "Already included: it's inside {}",
                root.path.display()
            )));
        }
        if root.path.starts_with(&path) {
            return Err(ApiError::conflict(format!(
                "This folder contains {} which is already in your library. Remove that one first.",
                root.path.display()
            )));
        }
    }

    let path_str = path
        .to_str()
        .ok_or_else(|| ApiError::bad_request("Folder name must be valid UTF-8"))?;
    match db::add_folder(&state.pool, path_str).await {
        Ok(_) => {}
        Err(e)
            if e.as_database_error()
                .is_some_and(|d| d.is_unique_violation()) =>
        {
            return Err(ApiError::conflict("This folder is already in your library"));
        }
        Err(e) => return Err(ApiError::internal("Failed to add folder", e)),
    }

    reload_roots(&state).await?;
    Ok((StatusCode::CREATED, Json(folder_infos(&state).await)))
}

/// DELETE /api/library/folders/{id}
/// Hanya menghapus folder dari library; file buku dan progres baca tidak disentuh.
pub async fn remove(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<i64>,
) -> Result<Json<Vec<FolderInfo>>, ApiError> {
    let deleted = db::delete_folder(&state.pool, id)
        .await
        .map_err(|e| ApiError::internal("Failed to remove folder", e))?;
    if !deleted {
        return Err(ApiError::not_found("Folder not found"));
    }
    reload_roots(&state).await?;
    Ok(Json(folder_infos(&state).await))
}

/// POST /api/library/scan
pub async fn rescan(State(state): State<AppState>) -> Json<ScanResult> {
    state.library.invalidate();
    Json(ScanResult {
        book_count: state.library.books().await.books().len(),
    })
}

// ---------------------------------------------------------------------------
// Penjelajah folder
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct BrowseQuery {
    pub path: Option<String>,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct BrowseResult {
    pub path: String,
    pub parent: Option<String>,
    pub folders: Vec<DirEntry>,
    /// Jumlah file PDF/EPUB langsung di folder ini (petunjuk untuk user)
    pub book_files: usize,
}

const MAX_BROWSE_ENTRIES: usize = 2000;

pub fn browse_dir(path: &Path) -> Result<BrowseResult, String> {
    let entries = fs::read_dir(path).map_err(|e| format!("Can't open folder: {e}"))?;
    let mut folders = Vec::new();
    let mut book_files = 0;
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let entry_path = entry.path();
        if entry_path.is_dir() {
            if folders.len() < MAX_BROWSE_ENTRIES {
                folders.push(DirEntry {
                    path: entry_path.to_string_lossy().to_string(),
                    name,
                });
            }
        } else if BookFormat::from_path(&entry_path).is_some() {
            book_files += 1;
        }
    }
    folders.sort_by_key(|f| f.name.to_lowercase());
    Ok(BrowseResult {
        path: path.to_string_lossy().to_string(),
        parent: path.parent().map(|p| p.to_string_lossy().to_string()),
        folders,
        book_files,
    })
}

/// GET /api/fs/browse?path=...
/// Tanpa `path`: mulai dari folder home user yang menjalankan server.
pub async fn browse(Query(query): Query<BrowseQuery>) -> Result<Json<BrowseResult>, ApiError> {
    let start = match query.path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => expand_home(p),
        _ => std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/")),
    };
    if !start.is_absolute() {
        return Err(ApiError::bad_request(
            "Use a full path, e.g. /home/you/Books",
        ));
    }
    let path = start
        .canonicalize()
        .map_err(|_| ApiError::not_found("Folder not found"))?;
    if !path.is_dir() {
        return Err(ApiError::bad_request("That path is a file, not a folder"));
    }

    tokio::task::spawn_blocking(move || browse_dir(&path))
        .await
        .map_err(|e| ApiError::internal("Failed to read folder", e))?
        .map(Json)
        .map_err(|msg| ApiError(StatusCode::FORBIDDEN, msg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browse_lists_folders_and_counts_books() {
        let dir = std::env::temp_dir().join(format!("openshelf-browse-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Zeta")).unwrap();
        fs::create_dir_all(dir.join("alpha")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("one.pdf"), b"x").unwrap();
        fs::write(dir.join("two.EPUB"), b"x").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();

        let res = browse_dir(&dir).unwrap();
        let names: Vec<_> = res.folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["alpha", "Zeta"]);
        assert_eq!(res.book_files, 2);
        assert_eq!(res.parent.as_deref(), dir.parent().and_then(|p| p.to_str()));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn expand_home_works() {
        if let Some(home) = std::env::var_os("HOME") {
            assert_eq!(expand_home("~"), PathBuf::from(&home));
            assert_eq!(expand_home("~/Books"), PathBuf::from(&home).join("Books"));
        }
        assert_eq!(expand_home("/abs/path"), PathBuf::from("/abs/path"));
        assert_eq!(expand_home("~other"), PathBuf::from("~other"));
    }
}
