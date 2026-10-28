use epub::doc::EpubDoc;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::Semaphore;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Epub,
    Pdf,
}

impl BookFormat {
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "epub" => Some(BookFormat::Epub),
            "pdf" => Some(BookFormat::Pdf),
            _ => None,
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            BookFormat::Pdf => "application/pdf",
            BookFormat::Epub => "application/epub+zip",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            BookFormat::Pdf => "PDF",
            BookFormat::Epub => "EPUB",
        }
    }
}

#[derive(Serialize, Clone)]
pub struct BookProgressSummary {
    pub current_page: i64,
    pub total_pages: i64,
    pub progress_percent: f64,
}

#[derive(Serialize, Clone)]
pub struct BookItem {
    pub id: String,
    pub title: String,
    /// Nama file saja, mis. "Rust.pdf"
    pub file_name: String,
    /// Path relatif terhadap folder library, mis. "Programming/Rust.pdf"
    pub rel_path: String,
    /// ID folder library (tabel `library_folders`)
    pub folder_id: i64,
    /// Path absolut di server — tidak dikirim ke browser
    #[serde(skip)]
    pub path: PathBuf,
    pub format: BookFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<BookProgressSummary>,
    pub categories: Vec<String>,
}

// ---------------------------------------------------------------------------
// ID buku yang stabil
// ---------------------------------------------------------------------------

/// ID buku = hash FNV-1a 64-bit dari path relatif di dalam folder library,
/// ditulis 16 digit hex. Untuk file yang langsung berada di folder library,
/// path relatif = nama file, jadi ID-nya sama dengan versi sebelumnya.
///
/// Sengaja tidak memakai `DefaultHasher`: hasilnya boleh berubah antar versi
/// Rust, padahal ID ini disimpan permanen di database.
pub fn book_id_for(rel_path: &str) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in rel_path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// Satu folder library yang dipilih user di halaman Settings.
#[derive(Clone, Debug)]
pub struct LibraryRoot {
    pub id: i64,
    pub path: PathBuf,
}

/// Batas kedalaman sub-folder (mencegah scan tanpa akhir).
const MAX_DEPTH: usize = 12;

/// Scan semua folder library (termasuk sub-folder).
/// - Folder & file tersembunyi (diawali ".") dilewati.
/// - Symlink ke folder tidak diikuti (mencegah loop); symlink ke file diikuti.
/// - Jika dua folder library punya path relatif yang sama, buku kedua
///   mendapat ID dari "<id folder>:<path relatif>" agar tetap unik.
pub fn scan_roots(roots: &[LibraryRoot]) -> Vec<BookItem> {
    let mut books = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let mut found = Vec::new();
        walk_dir(&root.path, "", 0, &mut found);
        found.sort_by(|a, b| a.0.cmp(&b.0));
        for (rel_path, path, format) in found {
            let mut id = book_id_for(&rel_path);
            if !seen.insert(id.clone()) {
                id = book_id_for(&format!("{}:{rel_path}", root.id));
                seen.insert(id.clone());
            }
            let file_name = rel_path.rsplit('/').next().unwrap_or(&rel_path).to_string();
            let title = Path::new(&file_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&file_name)
                .to_string();
            books.push(BookItem {
                id,
                title,
                file_name,
                rel_path,
                folder_id: root.id,
                path,
                format,
                progress: None,
                categories: Vec::new(),
            });
        }
    }
    books
}

fn walk_dir(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<(String, PathBuf, BookFormat)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        if depth == 0 {
            eprintln!("⚠️  Folder library tidak bisa dibaca: {}", dir.display());
        }
        return;
    };
    for entry in entries.flatten() {
        // Nama non-UTF-8 dilewati: tidak bisa dikirim aman sebagai JSON
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            if depth < MAX_DEPTH {
                walk_dir(&path, &rel, depth + 1, out);
            }
        } else if file_type.is_file() || (file_type.is_symlink() && path.is_file()) {
            if let Some(format) = BookFormat::from_path(&path) {
                out.push((rel, path, format));
            }
        }
    }
}

/// Meniru PERSIS cara lama memberi ID (urutan 1, 2, 3, …) — hanya dipakai
/// sekali untuk migrasi data lama ke ID baru. Mengembalikan (id_lama, nama_file).
pub fn legacy_positional_ids(dir_path: &Path) -> Vec<(String, String)> {
    let Ok(entries) = fs::read_dir(dir_path) else {
        return Vec::new();
    };
    let mut entry_list: Vec<_> = entries.flatten().collect();
    entry_list.sort_by_key(|e| e.file_name());

    let mut result = Vec::new();
    let mut counter = 1;
    for entry in entry_list {
        let file_path = entry.path();
        if !file_path.is_file() {
            continue;
        }
        let is_book = matches!(
            file_path.extension().and_then(|ext| ext.to_str()),
            Some("epub") | Some("EPUB") | Some("pdf") | Some("PDF")
        );
        if is_book {
            let file_name = file_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            result.push((counter.to_string(), file_name));
            counter += 1;
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Cache hasil scan
// ---------------------------------------------------------------------------

/// Daftar buku yang di-cache. Di-scan ulang jika:
/// - daftar folder library berubah (`set_roots`) atau diminta (`invalidate`),
/// - waktu modifikasi salah satu folder library berubah, atau
/// - cache berumur lebih dari `MAX_AGE` (menangkap perubahan di sub-folder).
pub struct Library {
    roots: RwLock<Vec<LibraryRoot>>,
    cache: RwLock<Option<Snapshot>>,
}

struct Snapshot {
    mtimes: Vec<Option<SystemTime>>,
    scanned_at: Instant,
    books: Arc<Vec<BookItem>>,
}

impl Library {
    const MAX_AGE: Duration = Duration::from_secs(60);

    pub fn new(roots: Vec<LibraryRoot>) -> Self {
        Library {
            roots: RwLock::new(roots),
            cache: RwLock::new(None),
        }
    }

    pub fn roots(&self) -> Vec<LibraryRoot> {
        self.roots.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_roots(&self, roots: Vec<LibraryRoot>) {
        *self.roots.write().unwrap_or_else(|e| e.into_inner()) = roots;
        self.invalidate();
    }

    pub fn invalidate(&self) {
        *self.cache.write().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn books(&self) -> Arc<Vec<BookItem>> {
        let roots = self.roots();
        let mtimes: Vec<_> = roots
            .iter()
            .map(|r| fs::metadata(&r.path).and_then(|m| m.modified()).ok())
            .collect();
        {
            let guard = self.cache.read().unwrap_or_else(|e| e.into_inner());
            if let Some(snap) = guard.as_ref() {
                if snap.mtimes == mtimes && snap.scanned_at.elapsed() < Self::MAX_AGE {
                    return snap.books.clone();
                }
            }
        }
        let books = Arc::new(scan_roots(&roots));
        *self.cache.write().unwrap_or_else(|e| e.into_inner()) = Some(Snapshot {
            mtimes,
            scanned_at: Instant::now(),
            books: books.clone(),
        });
        books
    }

    pub fn find(&self, id: &str) -> Option<BookItem> {
        self.books().iter().find(|b| b.id == id).cloned()
    }
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

/// Membaca cover EPUB (blocking — panggil lewat `spawn_blocking`).
pub fn extract_epub_cover(file_path: &Path) -> Option<(Vec<u8>, String)> {
    let mut doc = EpubDoc::new(file_path).ok()?;
    doc.get_cover()
}

/// Maksimal 2 proses pdftoppm sekaligus. Saat library pertama kali dibuka,
/// browser meminta puluhan cover bersamaan; tanpa batas ini server akan
/// menjalankan puluhan proses pdftoppm sekaligus.
static PDFTOPPM_SLOTS: Semaphore = Semaphore::const_new(2);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn is_fresh(cache: &Path, source: &Path) -> bool {
    let modified = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
    match (modified(cache), modified(source)) {
        (Some(c), Some(s)) => c >= s,
        _ => false,
    }
}

/// Render halaman pertama PDF ke PNG dengan `pdftoppm` (poppler-utils),
/// di-cache di `cache_dir/{book_id}.png`. Cache dibuat ulang jika file PDF
/// lebih baru dari cache-nya.
pub async fn extract_pdf_cover(
    file_path: &Path,
    book_id: &str,
    cache_dir: &Path,
) -> Option<(Vec<u8>, String)> {
    let cached_file = cache_dir.join(format!("{book_id}.png"));
    if is_fresh(&cached_file, file_path) {
        if let Ok(bytes) = tokio::fs::read(&cached_file).await {
            return Some((bytes, "image/png".into()));
        }
    }

    let _permit = PDFTOPPM_SLOTS.acquire().await.ok()?;

    // Request lain mungkin sudah membuatnya selagi kita menunggu antrian
    if is_fresh(&cached_file, file_path) {
        if let Ok(bytes) = tokio::fs::read(&cached_file).await {
            return Some((bytes, "image/png".into()));
        }
    }

    tokio::fs::create_dir_all(cache_dir).await.ok()?;
    // Nama sementara unik agar dua request untuk buku yang sama tidak bentrok
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let prefix = cache_dir.join(format!("tmp-{book_id}-{}-{n}", std::process::id()));
    let generated = prefix.with_extension("png");

    // tokio::process: tidak memblokir thread async selama pdftoppm berjalan
    let status = tokio::process::Command::new("pdftoppm")
        .args([
            "-png",
            "-f",
            "1",
            "-l",
            "1",
            "-scale-to",
            "600",
            "-singlefile",
        ])
        .arg(file_path)
        .arg(&prefix)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .ok()?;

    if !status.success() {
        let _ = tokio::fs::remove_file(&generated).await;
        return None;
    }

    tokio::fs::rename(&generated, &cached_file).await.ok()?;
    let bytes = tokio::fs::read(&cached_file).await.ok()?;
    Some((bytes, "image/png".into()))
}

/// Escape teks untuk dimasukkan ke XML/SVG.
///
/// Tanpa ini, file bernama `<script>alert(1)</script>.pdf` menghasilkan SVG
/// berisi script yang jalan saat URL cover dibuka langsung (stored XSS).
pub fn escape_xml(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            // Karakter kontrol tidak valid di XML 1.0
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

/// Potong judul per KARAKTER, bukan per byte. `&title[..57]` sebelumnya
/// panic jika byte ke-57 berada di tengah karakter non-ASCII (é, 日, emoji).
pub fn truncate_chars(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let kept: String = input.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{}...", kept.trim_end())
}

pub fn generate_svg_cover(title: &str, format_label: &str) -> Vec<u8> {
    let display_title = escape_xml(&truncate_chars(title, 60));
    let format_label = escape_xml(format_label);
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450" width="300" height="450">
  <rect width="300" height="450" fill="#f6f5f1"/>
  <rect x="18" y="18" width="264" height="414" fill="none" stroke="#111" stroke-width="2"/>
  <rect x="24" y="24" width="252" height="402" fill="none" stroke="#111" stroke-width="0.75"/>
  <text x="150" y="70" font-family="Georgia,serif" font-size="12" letter-spacing="3" fill="#111" text-anchor="middle">{format_label}</text>
  <line x1="120" y1="86" x2="180" y2="86" stroke="#111" stroke-width="1"/>
  <foreignObject x="40" y="120" width="220" height="220">
    <div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:center;height:100%;text-align:center;">
      <p style="font-family:Georgia,serif;font-size:22px;font-weight:bold;line-height:1.3;color:#111;margin:0;overflow-wrap:anywhere;">{display_title}</p>
    </div>
  </foreignObject>
  <line x1="120" y1="372" x2="180" y2="372" stroke="#111" stroke-width="1"/>
  <text x="150" y="398" font-family="Georgia,serif" font-size="11" font-style="italic" fill="#555" text-anchor="middle">OpenShelf</text>
</svg>"##
    );
    svg.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_id_is_stable_and_hex() {
        // Nilai tetap: kalau ini berubah, semua ID di database jadi tidak cocok
        assert_eq!(book_id_for(""), "cbf29ce484222325");
        assert_eq!(book_id_for("a"), "af63dc4c8601ec8c");
        let id = book_id_for("Clean Code.pdf");
        assert_eq!(id.len(), 16);
        assert_eq!(id, book_id_for("Clean Code.pdf"));
        assert_ne!(id, book_id_for("Clean Code (2).pdf"));
    }

    #[test]
    fn truncate_does_not_panic_on_multibyte() {
        let title = "日本語のタイトル".repeat(20);
        let out = truncate_chars(&title, 60);
        assert_eq!(out.chars().count(), 60);
        assert!(out.ends_with("..."));
        assert_eq!(truncate_chars("pendek", 60), "pendek");
    }

    #[test]
    fn svg_cover_escapes_title() {
        let svg =
            String::from_utf8(generate_svg_cover("<script>alert(1)</script>", "PDF")).unwrap();
        assert!(!svg.contains("<script>"));
        assert!(svg.contains("&lt;script&gt;"));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "openshelf-{tag}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recursive_scan_and_ids() {
        let dir = temp_dir("scan");
        fs::create_dir_all(dir.join("Programming/Rust")).unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::create_dir_all(dir.join("folder.pdf")).unwrap();
        for name in [
            "b.pdf",
            "a.EPUB",
            "c.txt",
            "Programming/Clean Code.pdf",
            "Programming/Rust/Book.Pdf",
            ".hidden/secret.pdf",
            ".dotfile.pdf",
        ] {
            fs::write(dir.join(name), b"x").unwrap();
        }

        let books = scan_roots(&[LibraryRoot {
            id: 1,
            path: dir.clone(),
        }]);
        let rels: Vec<_> = books.iter().map(|b| b.rel_path.as_str()).collect();
        assert_eq!(
            rels,
            [
                "Programming/Clean Code.pdf",
                "Programming/Rust/Book.Pdf",
                "a.EPUB",
                "b.pdf"
            ]
        );
        // File di level atas: ID sama seperti versi lama (hash nama file)
        let b = books.iter().find(|b| b.file_name == "b.pdf").unwrap();
        assert_eq!(b.id, book_id_for("b.pdf"));
        assert_eq!(b.path, dir.join("b.pdf"));
        let nested = &books[1];
        assert_eq!(nested.file_name, "Book.Pdf");
        assert_eq!(nested.title, "Book");
        assert_eq!(nested.format, BookFormat::Pdf);

        // Cara lama: hanya level atas, ekstensi persis pdf/PDF/epub/EPUB,
        // dan file tersembunyi IKUT dihitung (ditiru persis untuk migrasi)
        let legacy = legacy_positional_ids(&dir);
        let expected: Vec<(String, String)> =
            [(".dotfile.pdf", "1"), ("a.EPUB", "2"), ("b.pdf", "3")]
                .iter()
                .map(|(name, id)| (id.to_string(), name.to_string()))
                .collect();
        assert_eq!(legacy, expected);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn duplicate_relative_paths_get_unique_ids() {
        let one = temp_dir("one");
        let two = temp_dir("two");
        fs::write(one.join("same.pdf"), b"x").unwrap();
        fs::write(two.join("same.pdf"), b"x").unwrap();

        let lib = Library::new(vec![
            LibraryRoot {
                id: 1,
                path: one.clone(),
            },
            LibraryRoot {
                id: 2,
                path: two.clone(),
            },
        ]);
        let books = lib.books();
        assert_eq!(books.len(), 2);
        assert_ne!(books[0].id, books[1].id);
        assert_eq!(books[0].id, book_id_for("same.pdf"));
        assert_eq!(books[1].id, book_id_for("2:same.pdf"));
        assert!(lib.find(&books[1].id).is_some());

        lib.set_roots(vec![LibraryRoot {
            id: 1,
            path: one.clone(),
        }]);
        assert_eq!(lib.books().len(), 1);

        fs::remove_dir_all(&one).unwrap();
        fs::remove_dir_all(&two).unwrap();
    }
}
