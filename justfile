set shell := ["bash", "-c"]

# Tampilkan daftar perintah yang tersedia
default:
    @just --list

# Jalankan backend (Rust) dan frontend (Vite) secara paralel
dev:
    trap 'kill 0' EXIT; (cd backend && cargo run) & (cd frontend && pnpm dev)

# Jalankan hanya backend
dev-backend:
    cd backend && cargo run

# Jalankan hanya frontend
dev-frontend:
    cd frontend && pnpm dev

# Cek error & linting di kedua project
check:
    cd backend && cargo clippy
    cd frontend && pnpm tsc

# Format kode otomatis
fmt:
    cd backend && cargo fmt

# Build release untuk deployment homeserver
build:
    cd frontend && pnpm build
    cd backend && cargo build --release
