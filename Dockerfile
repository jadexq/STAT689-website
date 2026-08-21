# One image, both servers. They already talk over localhost:3000, so
# co-locating them means no networking changes, one IAP configuration, and
# one cold start instead of two chained ones. At ~5 students there is no
# argument for splitting them into separate Cloud Run services.
#
# The two projects are deliberately NOT merged: virtual_space is CommonJS
# run through tsx with Express 4, virtual_ta is ESM run through Node's own
# type stripping with Express 5. They keep their own node_modules.

# ---------- build ----------
FROM node:25-slim AS build
WORKDIR /app

# Dependencies first, so a source-only edit does not reinstall everything.
COPY virtual_space/package*.json ./virtual_space/
COPY virtual_ta/package*.json ./virtual_ta/
RUN npm ci --prefix virtual_space && npm ci --prefix virtual_ta

COPY virtual_space ./virtual_space
COPY virtual_ta ./virtual_ta

# esbuild bundles the Phaser client into client/static/bundle.js. Both
# esbuild and phaser are build-time only — the browser gets the bundle.
RUN npm run --prefix virtual_space build:client

# Neither server is compiled: the space runs TypeScript through tsx, the TA
# through Node's own type stripping. tsx therefore survives the prune (it
# is a runtime dependency); esbuild, phaser and typescript do not.
RUN npm prune --omit=dev --prefix virtual_space \
 && npm prune --omit=dev --prefix virtual_ta

# ---------- run ----------
FROM node:25-slim AS run
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/virtual_space ./virtual_space
COPY --from=build --chown=node:node /app/virtual_ta ./virtual_ta
COPY --chown=node:node docker/start.sh ./docker/start.sh
COPY --chown=node:node docker/sync.mjs ./docker/sync.mjs
RUN chmod +x docker/start.sh docker/sync.mjs

# Both servers write here; docker/sync.mjs restores it at boot and uploads a
# snapshot of it on a timer. On Cloud Run this is an in-memory filesystem, so
# it is durable only because of that sync — and it counts against instance RAM.
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data

# Cloud Run injects PORT; the space listens on it and is the only thing
# exposed. The TA stays on 127.0.0.1:3000, reachable from the space alone.
ENV PORT=8080
ENV TA_BASE_URL=http://127.0.0.1:3000
EXPOSE 8080

USER node
CMD ["./docker/start.sh"]
