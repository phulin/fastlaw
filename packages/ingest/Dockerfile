FROM node:22-alpine

WORKDIR /app

RUN corepack enable

COPY container/package.json /app/container/package.json

WORKDIR /app/container
RUN yarn install --immutable

# Copy shared lib files that the container needs (excluding files with Workers types)
COPY src/lib/cga/crawler.ts /app/container/src/lib/cga/
COPY src/lib/cga/ingest.ts /app/container/src/lib/cga/
COPY src/lib/cga/parser.ts /app/container/src/lib/cga/
COPY src/lib/cga/utils.ts /app/container/src/lib/cga/
COPY src/lib/cga/cross-references.ts /app/container/src/lib/cga/
COPY src/lib/usc/fetcher.ts /app/container/src/lib/usc/
COPY src/lib/usc/ingest.ts /app/container/src/lib/usc/
COPY src/lib/usc/parser.ts /app/container/src/lib/usc/
COPY src/lib/usc/cross-references.ts /app/container/src/lib/usc/
COPY src/lib/packfile/hash.ts /app/container/src/lib/packfile/
COPY src/lib/packfile/index.ts /app/container/src/lib/packfile/
COPY src/lib/packfile/store.ts /app/container/src/lib/packfile/
COPY src/lib/packfile/writer.ts /app/container/src/lib/packfile/
COPY src/lib/versioning.ts /app/container/src/lib/
COPY src/types.ts /app/container/src/
COPY container/src/ /app/container/src/
COPY container/tsconfig.json /app/container/tsconfig.json

EXPOSE 8080

CMD ["yarn", "start"]
