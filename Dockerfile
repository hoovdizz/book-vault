FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
LABEL org.opencontainers.image.title="BookVault" \
      org.opencontainers.image.description="Self-hosted personal book library" \
      org.opencontainers.image.source="https://github.com/hoovdizz/book-vault"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/config/book-vault.sqlite \
    SESSION_DAYS=30
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
RUN mkdir -p /config && chown -R node:node /app /config
USER node
EXPOSE 3000
VOLUME ["/config"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/server.mjs"]
