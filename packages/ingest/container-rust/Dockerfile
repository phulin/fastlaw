FROM rust:1.93-alpine3.23 AS builder
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs
COPY src/dummy.rs ./src/
RUN cargo build --release --bin dummy
COPY src/ ./src/
RUN cargo build --release --bin usc-ingest

FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/target/release/usc-ingest /usr/local/bin/
EXPOSE 8080
CMD ["usc-ingest"]
