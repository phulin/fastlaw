FROM rust:1.93-alpine3.23 AS builder
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN touch src/main.rs
RUN cargo build --release
COPY src/ ./src/
RUN cargo build --release

FROM alpine:3.23
COPY --from=builder /app/target/release/usc-ingest /usr/local/bin/
EXPOSE 8080
CMD ["usc-ingest"]
