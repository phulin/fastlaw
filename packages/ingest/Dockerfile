FROM node:20-slim

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn .yarn
COPY packages/ingest/package.json packages/ingest/package.json

RUN corepack enable && yarn workspaces focus @fastlaw/ingest --production

COPY packages/ingest packages/ingest

CMD ["yarn", "workspace", "@fastlaw/ingest", "container"]
