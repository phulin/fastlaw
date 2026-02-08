FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY src/ ./src/
COPY container/ ./container/
RUN npx esbuild container/server.ts --bundle --platform=node --outfile=dist/server.mjs --format=esm

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist/server.mjs ./dist/server.mjs
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
