# The backend (API), for the Oracle Cloud VM (ARM / Ampere) or any x86 machine.
#   docker build -t school-erp-backend .
# Chromium is for PDF documents (receipts, report cards, ID cards).
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
COPY tsconfig.json ./
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl chromium fonts-noto fonts-noto-cjk ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PDF_BROWSER_PATH=/usr/bin/chromium PORT=8000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./
COPY reports ./reports
RUN mkdir -p storage && chown -R node:node /app
USER node
EXPOSE 8000
# Database changes are applied before the server starts (one container runs them; they are idempotent).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
