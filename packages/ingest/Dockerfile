FROM alpine:3.23
RUN apk add --no-cache ca-certificates
ARG RUST_PROFILE=release
COPY ./container-rust/target/x86_64-unknown-linux-musl/${RUST_PROFILE}/ingest /usr/local/bin/ingest
COPY ./sources.json /usr/local/share/sources.json
ENV CONFIGS_PATH=/usr/local/share
EXPOSE 8080
CMD ["ingest"]
