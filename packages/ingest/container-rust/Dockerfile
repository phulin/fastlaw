FROM alpine:3.23
RUN apk add --no-cache ca-certificates
ARG RUST_PROFILE=release
COPY ./target/x86_64-unknown-linux-musl/${RUST_PROFILE}/ingest /usr/local/bin/ingest
EXPOSE 8080
CMD ["ingest"]
