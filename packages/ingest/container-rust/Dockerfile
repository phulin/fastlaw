FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/target/release/ingest /usr/local/bin/
EXPOSE 8080
CMD ["ingest"]
