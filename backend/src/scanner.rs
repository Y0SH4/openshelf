use epub::doc::EpubDoc;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// File name only, e.g. "Rust.pdf"
    pub file_name: String,
    /// Path relative to the library folder, e.g. "Programming/Rust.pdf"
    pub rel_path: String,
    /// Library folder ID (`library_folders` table)
    pub folder_id: i64,
    /// Absolute path on the server — never sent to the browser
    #[serde(skip)]
    pub path: PathBuf,
    pub format: BookFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<BookProgressSummary>,
    pub categories: Vec<String>,
}

// ---------------------------------------------------------------------------
// Stable book IDs
// ---------------------------------------------------------------------------

/// Book ID = 64-bit FNV-1a hash of the path relative to the library folder,
/// written as 16 hex digits. For files directly in the library folder the
/// relative path is the file name, so the ID matches the previous version.
///
/// Deliberately not `DefaultHasher`: its output may change between Rust
/// versions, while these IDs are stored permanently in the database.
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

#[derive(Clone, Debug)]
pub struct LibraryRoot {
    pub id: i64,
    pub path: PathBuf,
}

/// Max sub-folder depth (prevents endless scans).
const MAX_DEPTH: usize = 12;

/// Scans all library folders (including sub-folders).
/// - Hidden files and folders (starting with ".") are skipped.
/// - Symlinks to folders aren't followed (prevents loops); symlinks to files are.
/// - If two library folders have the same relative path, the second book
///   gets its ID from "<folder id>:<relative path>" so it stays unique.
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
            eprintln!("⚠️  Can't read library folder: {}", dir.display());
        }
        return;
    };
    for entry in entries.flatten() {
        // Non-UTF-8 names are skipped: they can't be sent safely as JSON
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
        } else if (file_type.is_file() || (file_type.is_symlink() && path.is_file()))
            && let Some(format) = BookFormat::from_path(&path)
        {
            out.push((rel, path, format));
        }
    }
}

/// Reproduces EXACTLY the old ID scheme (order 1, 2, 3, …) — only used once to
/// migrate old data to the new IDs. Returns (old_id, file_name).
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
// Scan cache
// ---------------------------------------------------------------------------

/// Result of one scan: the book list + an ID → position index.
pub struct Catalog {
    books: Vec<BookItem>,
    by_id: HashMap<String, usize>,
}

impl Catalog {
    fn new(books: Vec<BookItem>) -> Self {
        let by_id = books
            .iter()
            .enumerate()
            .map(|(i, b)| (b.id.clone(), i))
            .collect();
        Catalog { books, by_id }
    }

    fn empty() -> Self {
        Catalog::new(Vec::new())
    }

    pub fn books(&self) -> &[BookItem] {
        &self.books
    }

    pub fn find(&self, id: &str) -> Option<&BookItem> {
        self.by_id.get(id).map(|&i| &self.books[i])
    }
}

/// Cached book list.
///
/// Scanning folders is blocking I/O that can be slow (thousands of files, a
/// sleeping HDD, a NAS). To avoid holding up Tokio worker threads:
/// - Scans always run in `spawn_blocking`.
/// - Only one scan at a time (`scan_lock`); other requests wait and use
///   the same result.
/// - Once there is a scan result, requests are answered from it right away.
///   Changes are checked in the background (stale-while-revalidate):
///   - every `CHECK_EVERY`: check the library folders' modification times,
///     rescan if they changed;
///   - every `MAX_AGE`: full rescan (catches changes in sub-folders).
/// - `set_roots` / `invalidate` drop the cache: the next request waits for
///   a fresh scan (used by Settings, so results show up immediately).
pub struct Library {
    roots: RwLock<Vec<LibraryRoot>>,
    cache: RwLock<Option<Arc<Snapshot>>>,
    /// Bumped on every `invalidate`, so a scan started earlier can't store
    /// stale results in the cache.
    generation: AtomicU64,
    scan_lock: tokio::sync::Mutex<()>,
    refreshing: AtomicBool,
}

struct Snapshot {
    generation: u64,
    mtimes: Vec<Option<SystemTime>>,
    scanned_at: Instant,
    checked_at: Instant,
    catalog: Arc<Catalog>,
}

fn root_mtimes(roots: &[LibraryRoot]) -> Vec<Option<SystemTime>> {
    roots
        .iter()
        .map(|r| fs::metadata(&r.path).and_then(|m| m.modified()).ok())
        .collect()
}

/// Resets `refreshing` to false even if the refresh fails / panics.
struct RefreshGuard<'a>(&'a AtomicBool);

impl Drop for RefreshGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Library {
    const CHECK_EVERY: Duration = Duration::from_secs(5);
    const MAX_AGE: Duration = Duration::from_secs(60);

    pub fn new(roots: Vec<LibraryRoot>) -> Self {
        Library {
            roots: RwLock::new(roots),
            cache: RwLock::new(None),
            generation: AtomicU64::new(0),
            scan_lock: tokio::sync::Mutex::new(()),
            refreshing: AtomicBool::new(false),
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
        self.generation.fetch_add(1, Ordering::AcqRel);
        *self.cache.write().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// The scan result that's still valid (not from before an `invalidate`).
    fn snapshot(&self) -> Option<Arc<Snapshot>> {
        let snap = self
            .cache
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        (snap.generation == self.generation.load(Ordering::Acquire)).then_some(snap)
    }

    fn store(&self, snap: Snapshot) {
        if snap.generation == self.generation.load(Ordering::Acquire) {
            *self.cache.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(snap));
        }
    }

    pub async fn books(self: &Arc<Self>) -> Arc<Catalog> {
        if let Some(snap) = self.snapshot() {
            if snap.checked_at.elapsed() >= Self::CHECK_EVERY {
                self.spawn_refresh();
            }
            return snap.catalog.clone();
        }

        // No scan result yet → must wait. Only one scan; the others wait
        // on the lock and then use its result.
        let _lock = self.scan_lock.lock().await;
        if let Some(snap) = self.snapshot() {
            return snap.catalog.clone();
        }
        let generation = self.generation.load(Ordering::Acquire);
        let roots = self.roots();
        let scanned = tokio::task::spawn_blocking(move || {
            let mtimes = root_mtimes(&roots);
            (mtimes, scan_roots(&roots))
        })
        .await;
        let Ok((mtimes, books)) = scanned else {
            eprintln!("❌ Library scan failed (scan thread panicked)");
            return Arc::new(Catalog::empty());
        };

        let catalog = Arc::new(Catalog::new(books));
        let now = Instant::now();
        self.store(Snapshot {
            generation,
            mtimes,
            scanned_at: now,
            checked_at: now,
            catalog: catalog.clone(),
        });
        catalog
    }

    pub async fn find(self: &Arc<Self>, id: &str) -> Option<BookItem> {
        self.books().await.find(id).cloned()
    }

    /// Check for changes in the background; does nothing if already running.
    fn spawn_refresh(self: &Arc<Self>) {
        if self
            .refreshing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let _guard = RefreshGuard(&this.refreshing);
            this.refresh().await;
        });
    }

    async fn refresh(&self) {
        let _lock = self.scan_lock.lock().await;
        let Some(prev) = self.snapshot() else {
            return; // invalidated; the next request will scan
        };
        if prev.checked_at.elapsed() < Self::CHECK_EVERY {
            return; // just checked
        }

        let roots = self.roots();
        let prev_mtimes = prev.mtimes.clone();
        let full_rescan = prev.scanned_at.elapsed() >= Self::MAX_AGE;
        let checked = tokio::task::spawn_blocking(move || {
            let mtimes = root_mtimes(&roots);
            let books = (full_rescan || mtimes != prev_mtimes).then(|| scan_roots(&roots));
            (mtimes, books)
        })
        .await;
        let Ok((mtimes, books)) = checked else {
            eprintln!("❌ Library rescan failed (scan thread panicked)");
            return;
        };

        let now = Instant::now();
        self.store(match books {
            Some(books) => Snapshot {
                generation: prev.generation,
                mtimes,
                scanned_at: now,
                checked_at: now,
                catalog: Arc::new(Catalog::new(books)),
            },
            None => Snapshot {
                generation: prev.generation,
                mtimes,
                scanned_at: prev.scanned_at,
                checked_at: now,
                catalog: prev.catalog.clone(),
            },
        });
    }
}

// ---------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------

/// Reads an EPUB cover (blocking — call via `spawn_blocking`).
pub fn extract_epub_cover(file_path: &Path) -> Option<(Vec<u8>, String)> {
    let mut doc = EpubDoc::new(file_path).ok()?;
    doc.get_cover()
}

/// At most 2 pdftoppm processes at once. When the library is first opened,
/// the browser requests dozens of covers at the same time; without this
/// limit the server would run dozens of pdftoppm processes at once.
static PDFTOPPM_SLOTS: Semaphore = Semaphore::const_new(2);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn is_fresh(cache: &Path, source: &Path) -> bool {
    let modified = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
    match (modified(cache), modified(source)) {
        (Some(c), Some(s)) => c >= s,
        _ => false,
    }
}

/// Renders the first page of a PDF to PNG with `pdftoppm` (poppler-utils),
/// cached at `cache_dir/{book_id}.png`. The cache is rebuilt when the PDF
/// is newer than its cached cover.
pub async fn extract_pdf_cover(
    file_path: &Path,
    book_id: &str,
    cache_dir: &Path,
) -> Option<(Vec<u8>, String)> {
    let cached_file = cache_dir.join(format!("{book_id}.png"));
    if is_fresh(&cached_file, file_path)
        && let Ok(bytes) = tokio::fs::read(&cached_file).await
    {
        return Some((bytes, "image/png".into()));
    }

    let _permit = PDFTOPPM_SLOTS.acquire().await.ok()?;

    // Another request may have created it while we waited in the queue
    if is_fresh(&cached_file, file_path)
        && let Ok(bytes) = tokio::fs::read(&cached_file).await
    {
        return Some((bytes, "image/png".into()));
    }

    tokio::fs::create_dir_all(cache_dir).await.ok()?;
    // Unique temp name so two requests for the same book don't collide
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let prefix = cache_dir.join(format!("tmp-{book_id}-{}-{n}", std::process::id()));
    let generated = prefix.with_extension("png");

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

/// Escapes text for use inside XML/SVG.
///
/// Without this, a file named `<script>alert(1)</script>.pdf` would produce an
/// SVG with a script that runs when the cover URL is opened directly (stored XSS).
pub fn escape_xml(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            // Control characters are invalid in XML 1.0
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

/// Truncates a title by CHARACTER, not by byte: cutting by byte can panic
/// in the middle of a non-ASCII character (é, 日, emoji).
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
        // Fixed values: if these change, every ID in the database stops matching
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
        // Top-level files: same ID as the old version (hash of the file name)
        let b = books.iter().find(|b| b.file_name == "b.pdf").unwrap();
        assert_eq!(b.id, book_id_for("b.pdf"));
        assert_eq!(b.path, dir.join("b.pdf"));
        let nested = &books[1];
        assert_eq!(nested.file_name, "Book.Pdf");
        assert_eq!(nested.title, "Book");
        assert_eq!(nested.format, BookFormat::Pdf);

        // Old scheme: top level only, extensions exactly pdf/PDF/epub/EPUB,
        // and hidden files ARE counted (reproduced exactly for the migration)
        let legacy = legacy_positional_ids(&dir);
        let expected: Vec<(String, String)> =
            [(".dotfile.pdf", "1"), ("a.EPUB", "2"), ("b.pdf", "3")]
                .iter()
                .map(|(name, id)| (id.to_string(), name.to_string()))
                .collect();
        assert_eq!(legacy, expected);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn duplicate_relative_paths_get_unique_ids() {
        let one = temp_dir("one");
        let two = temp_dir("two");
        fs::write(one.join("same.pdf"), b"x").unwrap();
        fs::write(two.join("same.pdf"), b"x").unwrap();

        let lib = Arc::new(Library::new(vec![
            LibraryRoot {
                id: 1,
                path: one.clone(),
            },
            LibraryRoot {
                id: 2,
                path: two.clone(),
            },
        ]));
        let catalog = lib.books().await;
        let books = catalog.books();
        assert_eq!(books.len(), 2);
        assert_ne!(books[0].id, books[1].id);
        assert_eq!(books[0].id, book_id_for("same.pdf"));
        assert_eq!(books[1].id, book_id_for("2:same.pdf"));
        assert_eq!(lib.find(&books[1].id).await.unwrap().folder_id, 2);
        assert!(lib.find("tidak-ada").await.is_none());

        lib.set_roots(vec![LibraryRoot {
            id: 1,
            path: one.clone(),
        }]);
        assert_eq!(lib.books().await.books().len(), 1);

        fs::remove_dir_all(&one).unwrap();
        fs::remove_dir_all(&two).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_requests_share_one_scan() {
        let dir = temp_dir("flight");
        fs::write(dir.join("a.pdf"), b"x").unwrap();
        let lib = Arc::new(Library::new(vec![LibraryRoot {
            id: 1,
            path: dir.clone(),
        }]));

        let tasks: Vec<_> = (0..16)
            .map(|_| {
                let lib = lib.clone();
                tokio::spawn(async move { lib.books().await })
            })
            .collect();
        let mut results = Vec::new();
        for t in tasks {
            results.push(t.await.unwrap());
        }
        // All requests use the same scan result (only one scan)
        assert!(results.iter().all(|c| Arc::ptr_eq(c, &results[0])));
        assert_eq!(results[0].books().len(), 1);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn invalidate_rescans_and_refresh_detects_changes() {
        let dir = temp_dir("refresh");
        fs::write(dir.join("a.pdf"), b"x").unwrap();
        let lib = Arc::new(Library::new(vec![LibraryRoot {
            id: 1,
            path: dir.clone(),
        }]));
        let first = lib.books().await;
        assert_eq!(first.books().len(), 1);

        // Still within CHECK_EVERY: the old result is used without touching the disk
        fs::write(dir.join("b.pdf"), b"x").unwrap();
        assert!(Arc::ptr_eq(&lib.books().await, &first));

        // A forced rescan (Rescan button in Settings) shows up immediately
        lib.invalidate();
        assert_eq!(lib.books().await.books().len(), 2);

        // Background refresh: pretend CHECK_EVERY has passed
        fs::write(dir.join("c.pdf"), b"x").unwrap();
        let snap = lib.snapshot().unwrap();
        lib.store(Snapshot {
            generation: snap.generation,
            mtimes: vec![None], // as if the folder changed
            scanned_at: snap.scanned_at,
            checked_at: Instant::now() - Library::CHECK_EVERY,
            catalog: snap.catalog.clone(),
        });
        lib.refresh().await;
        assert_eq!(lib.books().await.books().len(), 3);

        // An old refresh must not overwrite the result after an invalidate
        let stale_generation = lib.snapshot().unwrap().generation;
        lib.invalidate();
        lib.store(Snapshot {
            generation: stale_generation,
            mtimes: Vec::new(),
            scanned_at: Instant::now(),
            checked_at: Instant::now(),
            catalog: Arc::new(Catalog::empty()),
        });
        assert!(lib.snapshot().is_none());

        fs::remove_dir_all(&dir).unwrap();
    }
}
