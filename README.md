# OpenShelf

[![CI](https://github.com/Y0SH4/openshelf/actions/workflows/ci.yml/badge.svg)](https://github.com/Y0SH4/openshelf/actions/workflows/ci.yml)

A self-hosted library for your PDF and EPUB books, with a calm, Kindle-like reader in the browser.

Point OpenShelf at the folders where you keep your books. It scans them (including sub-folders), shows your shelf with covers, and lets you read PDFs on any device on your network while it remembers where you left off.

## Features

- **Your folders, scanned automatically.** Add one or more folders in Settings. Sub-folders are included and new files show up on their own.
- **Covers.** EPUB covers come from the book itself and PDF covers are rendered from the first page. Books without either get a clean generated cover.
- **PDF reader.** Pages load lazily, so even large books open fast. It has zoom and fit-to-width, white, sepia and black page colors, and keyboard navigation (← → + − Esc).
- **Reading progress** is saved automatically, per book.
- **Notes.** Notion-style notes shown as cards, with headings, lists, to-dos and quotes. Open them from the Library or next to the book you're reading. Select text in a PDF to quote it into a note, or insert a link to the current page; clicking a page link opens the book at that page. Notes are stored as Markdown.
- **Collections, search, filters and sorting.** Grid or list view.
- **One private account**, protected by a setup code on first run and rate-limited sign-in.
- EPUB books can be downloaded. In-browser EPUB reading is planned.

## Quick start with Docker

```bash
git clone https://github.com/Y0SH4/openshelf.git
cd openshelf
BOOKS_PATH=/path/to/your/books docker compose up -d --build
docker logs openshelf     # shows the setup code
```

Open `http://<your-server>:3000`, enter the **setup code** from the log, and create your account. The folder you mounted is already in your library.

The setup code makes sure only someone with access to the server can create the account. It's only needed once, for the first account. A few tips:

- **Portainer, Synology, Unraid, CasaOS…** open the OpenShelf container's **Logs** to see the code.
- A new code is made **every time OpenShelf restarts**. If the code is refused, check the log again and use the newest one.
- Prefer not to read logs? Set your own code with `OPENSHELF_SETUP_CODE` (at least 8 letters or digits) in `docker-compose.yml` before the first start.

To use more folders, mount them inside `/books` in `docker-compose.yml`, then add them in **Settings → Library folders**:

```yaml
    volumes:
      - openshelf-data:/data
      - /mnt/hdd/ebooks:/books/ebooks:ro
      - ~/Comics:/books/comics:ro
```

To update: `git pull && docker compose up -d --build`.

Prefer not to build? Released versions are published as a ready-made image for `amd64` and `arm64` (e.g. Raspberry Pi). In `docker-compose.yml`, replace `build: .` with `image: ghcr.io/y0sh4/openshelf:latest`, then update with `docker compose pull && docker compose up -d`.

## Run from source

Requirements:

- [Rust](https://rustup.rs) 1.88 or newer
- [Node.js](https://nodejs.org) 20.19+ or 22.12+, and [pnpm](https://pnpm.io)
- [just](https://github.com/casey/just) (optional; the commands it runs are in the `justfile`)
- `poppler-utils` for PDF covers (optional; without it PDFs get a generated cover)
  - Debian/Ubuntu: `sudo apt install poppler-utils`, Arch: `sudo pacman -S poppler`, macOS: `brew install poppler`

```bash
git clone https://github.com/Y0SH4/openshelf.git
cd openshelf
just setup      # install frontend dependencies
just start      # build everything and run on http://localhost:3000
```

The terminal shows a **setup code**. Open `http://localhost:3000`, create your account, then go to **Settings → Library folders → Add folder** and choose where your books are.

## Configuration

Everything is optional and set with environment variables.

| Variable | Default | |
|---|---|---|
| `OPENSHELF_BIND` | `0.0.0.0:3000` | Address to listen on. `127.0.0.1:3000` = only this computer |
| `OPENSHELF_DATA_DIR` | `backend/data` | Database and cover cache |
| `OPENSHELF_BROWSE_ROOTS` | `$HOME:/mnt:/media:/run/media:/srv` | Folders that can be picked as libraries in Settings, separated by `:`. `/` allows everything |
| `BOOKS_DIR` | | Added as the first library folder if there is none yet |
| `OPENSHELF_SECURE_COOKIE` | `false` | Set to `true` when OpenShelf is served over HTTPS |
| `OPENSHELF_TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy, so sign-in limits use the real client IP from `X-Forwarded-For` |
| `OPENSHELF_SETUP_CODE` | random | Code for creating the first account, at least 8 letters or digits. Without it, a random code is printed in the log on every start |
| `OPENSHELF_FRONTEND_DIR` | `frontend/dist` | Built frontend to serve |
| `OPENSHELF_CORS_ORIGIN` | | Only needed if the frontend is hosted on a different origin |

## Accessing it from outside your home network

OpenShelf speaks plain HTTP, which is fine on a home network. For access over the internet, put it behind a reverse proxy with HTTPS, such as [Caddy](https://caddyserver.com):

```
books.example.com {
    reverse_proxy localhost:3000
}
```

Then set `OPENSHELF_SECURE_COOKIE=true` and `OPENSHELF_TRUST_PROXY=true`.

## Forgot your password?

Delete the account, then restart OpenShelf. It prints a new setup code so you can create the account again. Your books, folders, reading progress, collections and notes are kept.

```bash
# From source (stop the server first)
sqlite3 backend/data/openshelf.db "DELETE FROM sessions; DELETE FROM users;"

# Docker (the volume is named <folder>_openshelf-data, e.g. openshelf_openshelf-data)
docker compose down
docker run --rm -v openshelf_openshelf-data:/data alpine \
  sh -c "apk add -q sqlite && sqlite3 /data/openshelf.db 'DELETE FROM sessions; DELETE FROM users;'"
docker compose up -d
docker logs openshelf     # the new setup code
```

## Development

```bash
just setup   # once
just dev     # backend on :3000 + Vite dev server on :5173 (open this one)
just check   # clippy + TypeScript
cd backend && cargo test
```

The backend is Rust (Axum, SQLite via sqlx). The frontend is React, TypeScript, Vite and Tailwind, with PDF.js for rendering.

```
backend/src/
  main.rs       routes and startup
  auth.rs       account, sessions, setup code
  scanner.rs    folder scanning, book IDs, covers
  folders.rs    library folders and the folder picker
  routes.rs     books, progress, collections, notes
  db.rs         SQLite schema and queries
  security.rs   sign-in rate limiting
  frontend.rs   serves the built frontend
frontend/src/
  components/   library, reader, notes, settings, auth
  lib/          API helper, PDF.js loader
```
