set shell := ["bash", "-c"]

# List available commands
default:
    @just --list

# Install frontend dependencies (run once after cloning)
setup:
    cd frontend && pnpm install
    @command -v pdftoppm >/dev/null || echo "⚠️  pdftoppm not found: install poppler-utils for PDF covers"

# Run the backend (Rust) and frontend (Vite) together
dev:
    trap 'kill 0' EXIT; (cd backend && cargo run) & (cd frontend && pnpm dev)

# Run only the backend
dev-backend:
    cd backend && cargo run

# Run only the frontend
dev-frontend:
    cd frontend && pnpm dev

# Check for errors and lint both projects
check:
    cd backend && cargo clippy
    cd frontend && pnpm tsc

# Format the code
fmt:
    cd backend && cargo fmt

# Release build for deployment
build:
    cd frontend && pnpm build
    cd backend && cargo build --release

# Build, then run the production version: frontend + API on one port (http://localhost:3000)
start: build
    ./backend/target/release/openshelf-backend
