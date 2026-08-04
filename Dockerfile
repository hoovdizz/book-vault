FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
LABEL org.opencontainers.image.title="BookVault" \
      org.opencontainers.image.description="Self-hosted personal book library" \
      org.opencontainers.image.source="https://github.com/hoovdizz/book-vault"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8130 \
    PUID=99 \
    PGID=100 \
    DATABASE_PATH=/config/book-vault.sqlite \
    BOOK_LOOKUP_TIMEOUT_MS=6000 \
    SESSION_DAYS=30
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server/database.mjs server/server.mjs server/book-search.mjs ./server/
COPY docker-entrypoint.sh /usr/local/bin/book-vault-entrypoint
# npm is required only in the build stage. The runtime uses Node built-ins, so
# remove npm/npx and their dependency tree from the published attack surface.
RUN apk add --no-cache su-exec \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && chmod 0755 /usr/local/bin/book-vault-entrypoint \
    && mkdir -p /config \
    && chown -R node:node /app \
    && chown -R 99:100 /config
EXPOSE 8130
VOLUME ["/config"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8130/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/book-vault-entrypoint"]
CMD ["node", "server/server.mjs"]
