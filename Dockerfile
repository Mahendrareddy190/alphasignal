FROM node:20-slim

# better-sqlite3 needs build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Rebuild better-sqlite3 for this platform
RUN npm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/futures.db

EXPOSE 8080

CMD ["node", "dist/index.js"]
