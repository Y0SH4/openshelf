use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Epub,
    Pdf,
}

#[derive(Serialize)]
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
