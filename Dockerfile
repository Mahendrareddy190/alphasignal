# Stage 1 — build
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Stage 2 — production
FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3

COPY --from=builder /app/dist ./dist
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/tmp/futures.db

EXPOSE 8080
CMD ["node", "dist/index.js"]
