FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY ./target/x86_64-unknown-linux-musl/release/ingest /usr/local/bin/
EXPOSE 8080
CMD ["ingest"]
