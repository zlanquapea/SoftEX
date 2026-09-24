# syntax=docker/dockerfile:1
FROM node:25-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build

FROM node:25-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4000 SOFTEX_DATA_DIR=/app/server/data
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
# Run as the unprivileged "node" user; only the data directory is writable.
RUN mkdir -p /app/server/data && chown -R node:node /app/server/data
USER node
EXPOSE 4000
VOLUME /app/server/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
