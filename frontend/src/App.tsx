import { useEffect, useState } from "react";
import {
  BookOpen,
  Search,
  ArrowLeft,
  Sun,
  Moon,
  BookA,
  Library,
  FileText,
  Bookmark,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface Book {
  id: string;
  title: string;
  file_name: string;
  format: "pdf" | "epub";
}

type ThemeMode = "light" | "sepia" | "dark";

export default function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [search, setSearch] = useState("");
  const [formatFilter, setFormatFilter] = useState<"all" | "pdf" | "epub">(
    "all",
  );
  const [theme, setTheme] = useState<ThemeMode>(() => {
    return (localStorage.getItem("openshelf_theme") as ThemeMode) || "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark", "sepia");
    if (theme === "dark") root.classList.add("dark");
    if (theme === "sepia") root.classList.add("sepia");
    localStorage.setItem("openshelf_theme", theme);
  }, [theme]);

  useEffect(() => {
    fetch("/api/books")
      .then((res) => res.json())
      .then((data) => {
        setBooks(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Gagal mengambil daftar buku:", err);
        setLoading(false);
      });
  }, []);

  const filteredBooks = books.filter((b) => {
    const matchesSearch = b.title.toLowerCase().includes(search.toLowerCase());
    const matchesFormat = formatFilter === "all" || b.format === formatFilter;
    return matchesSearch && matchesFormat;
  });

  if (selectedBook) {
    return (
      <div className="flex flex-col h-screen bg-background text-foreground transition-colors duration-200 select-none">
        {/* Bilah Navigasi Atas ala Kindle */}
        <header className="h-14 border-b border-border/80 px-4 md:px-8 flex items-center justify-between bg-card/70 backdrop-blur-sm z-10">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedBook(null)}
              className="gap-2 font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Library</span>
            </Button>
            <div className="h-4 w-px bg-border hidden sm:block" />
            <div className="max-w-[280px] sm:max-w-md truncate">
              <h1 className="text-sm font-serif font-semibold truncate">
                {selectedBook.title}
              </h1>
              <p className="text-[11px] text-muted-foreground truncate font-mono">
                {selectedBook.file_name}
              </p>
            </div>
          </div>

          {/* Pengaturan Cepat Tampilan Baca ("Aa" Kindle) */}
          <div className="flex items-center gap-1.5">
            <div className="flex items-center bg-secondary/80 rounded-md p-0.5 border border-border/50 text-xs">
              <button
                onClick={() => setTheme("light")}
                className={`px-2.5 py-1 rounded transition-colors ${
                  theme === "light"
                    ? "bg-background text-foreground shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Paperwhite Light"
              >
                Paper
              </button>
              <button
                onClick={() => setTheme("sepia")}
                className={`px-2.5 py-1 rounded transition-colors ${
                  theme === "sepia"
                    ? "bg-amber-100 dark:bg-amber-900/40 text-amber-950 dark:text-amber-100 shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Sepia Warm"
              >
                Sepia
              </button>
              <button
                onClick={() => setTheme("dark")}
                className={`px-2.5 py-1 rounded transition-colors ${
                  theme === "dark"
                    ? "bg-background text-foreground shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Kindle Dark"
              >
                Dark
              </button>
            </div>

            <Badge variant="kindle" className="ml-2 hidden md:inline-flex">
              {selectedBook.format}
            </Badge>
          </div>
        </header>

        {/* Reader Container */}
        <main className="flex-1 w-full bg-background relative overflow-hidden">
          <iframe
            src={`/api/books/${selectedBook.id}/raw`}
            className="w-full h-full border-none"
            title={selectedBook.title}
          />
        </main>

        {/* Bilah Navigasi Bawah ala Kindle */}
        <footer className="h-8 border-t border-border/60 px-6 flex items-center justify-between text-[11px] text-muted-foreground bg-card/40">
          <span className="flex items-center gap-1.5 font-serif italic">
            <BookOpen className="w-3.5 h-3.5" /> OpenShelf Reader
          </span>
          <span className="font-mono">
            {selectedBook.format.toUpperCase()} Document
          </span>
        </footer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground transition-colors duration-200">
      {/* Top Header */}
      <header className="border-b border-border/80 sticky top-0 bg-background/90 backdrop-blur-md z-20">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shadow-sm">
              <BookOpen className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-lg font-serif font-bold tracking-tight leading-none">
                OpenShelf
              </h1>
              <span className="text-[10px] text-muted-foreground tracking-wider uppercase font-mono">
                Homeserver Library
              </span>
            </div>
          </div>

          <div className="relative flex-1 max-w-md hidden sm:block">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search your library..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-card border-border/80 text-sm focus-visible:ring-primary/40 font-serif"
            />
          </div>

          {/* Theme switcher */}
          <div className="flex items-center gap-2">
            <div className="flex bg-card rounded-lg p-1 border border-border/80 shadow-sm">
              <button
                onClick={() => setTheme("light")}
                className={`p-1.5 rounded-md transition-colors ${
                  theme === "light"
                    ? "bg-secondary text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Paperwhite Light"
              >
                <Sun className="w-4 h-4" />
              </button>
              <button
                onClick={() => setTheme("sepia")}
                className={`p-1.5 rounded-md transition-colors ${
                  theme === "sepia"
                    ? "bg-amber-100 text-amber-950 shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Warm Sepia"
              >
                <BookA className="w-4 h-4" />
              </button>
              <button
                onClick={() => setTheme("dark")}
                className={`p-1.5 rounded-md transition-colors ${
                  theme === "dark"
                    ? "bg-secondary text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Kindle Dark"
              >
                <Moon className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="px-6 pb-3 sm:hidden">
          <div className="relative w-full">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search books..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-card"
            />
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-6 border-t border-border/40 flex items-center justify-between text-xs overflow-x-auto py-2">
          <div className="flex items-center gap-1 font-medium">
            <button
              onClick={() => setFormatFilter("all")}
              className={`px-3 py-1.5 rounded-md transition-all ${
                formatFilter === "all"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              All ({books.length})
            </button>
            <button
              onClick={() => setFormatFilter("pdf")}
              className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
                formatFilter === "pdf"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              <FileText className="w-3.5 h-3.5" /> PDFs
            </button>
            <button
              onClick={() => setFormatFilter("epub")}
              className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
                formatFilter === "epub"
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" /> EPUBs
            </button>
          </div>

          <span className="text-[11px] text-muted-foreground font-serif italic hidden md:inline">
            Showing {filteredBooks.length} items
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-sm font-serif text-muted-foreground">
              Scanning your homeserver library...
            </p>
          </div>
        ) : filteredBooks.length === 0 ? (
          <div className="text-center py-20 border border-dashed border-border rounded-xl bg-card/40">
            <Library className="w-10 h-10 mx-auto text-muted-foreground/60 mb-3" />
            <h3 className="text-base font-serif font-semibold">
              No books found
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              {search
                ? `No books matching "${search}"`
                : "No files found in the books folder."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6 md:gap-7">
            {filteredBooks.map((book) => (
              <div
                key={book.id}
                onClick={() => setSelectedBook(book)}
                className="group cursor-pointer flex flex-col transition-all duration-200"
              >
                <div className="relative aspect-[3/4] w-full rounded-md border border-border/80 bg-card overflow-hidden shadow-xs transition-all duration-200 group-hover:-translate-y-1.5 group-hover:shadow-md group-hover:border-primary/50">
                  <img
                    src={`/api/books/${book.id}/cover`}
                    alt={book.title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />

                  <div className="absolute left-0 top-0 bottom-0 w-2.5 bg-gradient-to-r from-black/20 to-transparent pointer-events-none" />

                  <div className="absolute top-2 right-2 z-10">
                    <Badge variant="kindle">{book.format}</Badge>
                  </div>
                </div>

                {/* Book Title below cover */}
                <div className="mt-2.5 px-0.5">
                  <h4 className="text-xs font-serif font-medium line-clamp-2 leading-relaxed text-foreground/90 group-hover:text-primary transition-colors">
                    {book.title}
                  </h4>
                  <p className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
                    {book.file_name}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
