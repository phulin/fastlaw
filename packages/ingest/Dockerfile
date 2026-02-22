FROM alpine:3.23
RUN apk add --no-cache ca-certificates
ARG RUST_PROFILE=release
COPY ./sources.json /usr/local/share/sources.json
COPY ./container-rust/target/x86_64-unknown-linux-musl/${RUST_PROFILE}/ingest /usr/local/bin/ingest
ENV CONFIGS_PATH=/usr/local/share
EXPOSE 8080
CMD ["ingest"]
