use epub::doc::EpubDoc;
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Epub,
    Pdf,
}

#[derive(Serialize, Clone)]
pub struct BookItem {
    pub id: String,
    pub title: String,
    pub file_name: String,
    pub format: BookFormat,
}

pub fn scan_books_dir(dir_path: &str) -> Vec<BookItem> {
    let mut books = Vec::new();
    let path = Path::new(dir_path);

    if let Ok(entries) = fs::read_dir(path) {
        let mut counter = 1;

        for entry in entries.flatten() {
            let file_path = entry.path();

            if file_path.is_file() {
                let format = match file_path.extension().and_then(|ext| ext.to_str()) {
                    Some("epub") | Some("EPUB") => Some(BookFormat::Epub),
                    Some("pdf") | Some("PDF") => Some(BookFormat::Pdf),
                    _ => None,
                };

                if let Some(book_format) = format {
                    let file_stem = file_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Unknown Title")
                        .to_string();

                    let file_name = file_path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();

                    books.push(BookItem {
                        id: counter.to_string(),
                        title: file_stem,
                        file_name,
                        format: book_format,
                    });

                    counter += 1;
                }
            }
        }
    }

    books
}

pub fn find_book_by_id(dir_path: &str, target_id: &str) -> Option<BookItem> {
    let books = scan_books_dir(dir_path);
    books.into_iter().find(|b| b.id == target_id)
}

pub fn extract_epub_cover(file_path: &Path) -> Option<(Vec<u8>, String)> {
    let mut doc = EpubDoc::new(file_path).ok()?;
    doc.get_cover()
}

pub fn generate_svg_cover(title: &str, format_label: &str) -> Vec<u8> {
    // Potong judul jika terlalu panjang agar muat di cover
    let display_title = if title.len() > 60 {
        format!("{}...", &title[..57])
    } else {
        title.to_string()
    };
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420" width="300" height="420">
  <defs>
    <linearGradient id="paper" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fdfbf7"/>
      <stop offset="100%" stop-color="#f4ede2"/>
    </linearGradient>
    <linearGradient id="spine" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="rgba(0,0,0,0.15)"/>
      <stop offset="100%" stop-color="transparent"/>
    </linearGradient>
  </defs>
  <!-- Latar Kertas Buku -->
  <rect width="300" height="420" rx="6" fill="url(#paper)"/>
  <rect width="18" height="420" rx="6" fill="url(#spine)"/>
  <!-- Bingkai Klasik Kindle -->
  <rect x="24" y="20" width="252" height="380" rx="4" fill="none" stroke="#d5cbbe" stroke-width="2"/>
  <rect x="28" y="24" width="244" height="372" rx="2" fill="none" stroke="#e8e0d5" stroke-width="1"/>
  <!-- Badge Format -->
  <rect x="120" y="45" width="60" height="20" rx="4" fill="#2d2a26"/>
  <text x="150" y="59" font-family="monospace" font-size="11" font-weight="bold" fill="#fdfbf7" text-anchor="middle">{}</text>
  <!-- Ikon Buku Minimalis -->
  <circle cx="150" cy="125" r="28" fill="#e8dfd3"/>
  <path d="M140 120 C145 117 155 117 160 120 V135 C155 132 145 132 140 135 Z" fill="#4a443c"/>
  <!-- Judul Buku (Font Serif Klasik) -->
  <foreignObject x="38" y="175" width="224" height="170">
    <div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:center;height:100%;text-align:center;padding:0 8px;">
      <p style="font-family:Georgia,serif;font-size:18px;font-weight:bold;line-height:1.35;color:#23201d;margin:0;word-wrap:break-word;">
        {}
      </p>
    </div>
  </foreignObject>
  <!-- Footer Tipis -->
  <line x1="50" y1="365" x2="250" y2="365" stroke="#d5cbbe" stroke-width="1"/>
  <text x="150" y="385" font-family="Georgia,serif" font-size="10" font-style="italic" fill="#8c8275" text-anchor="middle">OpenShelf Edition</text>
</svg>"##,
        format_label, display_title
    );
    svg.into_bytes()
}
