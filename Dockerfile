# OpenShelf — one image with the backend and the built frontend.
#
#   docker compose up -d        (see docker-compose.yml)
#
# Books are read from /books (mount your folder there, read-only is fine),
# the database and cover cache live in /data.

# ---- Frontend --------------------------------------------------------------
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
RUN npm install -g pnpm@12.14.0
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ---- Backend ---------------------------------------------------------------
FROM rust:1-trixie AS backend
WORKDIR /app/backend
# Build dependencies first so they're cached when only the source changes
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY backend/src ./src
RUN touch src/main.rs && cargo build --release --locked

# ---- Runtime ---------------------------------------------------------------
FROM debian:trixie-slim
# poppler-utils: pdftoppm renders PDF covers
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1000 --home-dir /data --shell /usr/sbin/nologin openshelf \
    && mkdir -p /data /books \
    && chown openshelf:openshelf /data

COPY --from=backend /app/backend/target/release/openshelf /usr/local/bin/openshelf
COPY --from=frontend /app/frontend/dist /app/frontend/dist

ENV OPENSHELF_BIND=0.0.0.0:3000 \
    OPENSHELF_DATA_DIR=/data \
    OPENSHELF_FRONTEND_DIR=/app/frontend/dist \
    OPENSHELF_BROWSE_ROOTS=/books \
    BOOKS_DIR=/books

USER openshelf
VOLUME ["/data"]
EXPOSE 3000
CMD ["openshelf"]
