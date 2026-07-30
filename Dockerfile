# node:22-bookworm-slim (glibc), NOT alpine: better-sqlite3 ships prebuilt
# binaries for glibc only, none usable on musl (alpine) without compiling
# from source anyway. This is a deliberate deviation from an alpine-based
# spec, kept consistent across both stages below so whatever native binding
# gets built/verified in `build` is guaranteed loadable in `runtime`.
#
# Non-alpine does NOT mean "the bundled prebuild just works", though: this
# package's own linux-arm64 prebuild turned out to be linked against a
# glibc newer than bookworm ships (verified below: bookworm has glibc
# 2.36; that prebuild requires GLIBC_2.38 and fails to load at runtime with
# "version `GLIBC_2.38' not found"). The build stage below compiles from
# source and deletes the bundled prebuilds so the compiled-here binary
# (guaranteed to match this exact runtime's glibc) is what actually loads.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# `npm rebuild --build-from-source` was tried first and turned out to be a
# no-op for this package (it ships no install/postinstall script, so npm's
# rebuild has nothing to hook into). node-gyp is invoked directly instead,
# using the copy npm itself bundles.
#
# The prebuilds directory is removed BEFORE invoking node-gyp, not after:
# better-sqlite3's binding.gyp checks `prebuild_exists% : '<!(node
# lib/binding.js)'` at gyp-configure time and makes its compile target a
# `type: 'none'` no-op whenever a prebuild for the host platform is present
# -- discovered by first deleting prebuilds afterwards and getting a clean
# build that had actually only touched stamp files with no compiled .node
# at all. Deleting first forces the real CC/CXX/SOLINK_MODULE compile,
# producing a build/Release/better_sqlite3.node that matches this exact
# runtime glibc. Verified by running the resulting module before trusting
# it (the `node -e require(...)` line below fails the build otherwise).
RUN npm run build && \
    rm -rf node_modules/better-sqlite3/prebuilds && \
    (cd node_modules/better-sqlite3 && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release) && \
    node -e "require('./node_modules/better-sqlite3')" && \
    npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Pre-create /data and chown it to the node user (uid 1000) while still root.
# This matters even though the container runs as `node`: a *named* Docker
# volume mounted over /data on first run is seeded from whatever is already
# at that path in the image, ownership included, so a freshly created
# volume comes up writable by `node` with no separate init step. (This does
# NOT help a bind-mount of a host directory owned by root — see README.)
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

# Timing deviates from a naive interval=30s/retries=3 default. The daemon's
# own reconnect loop (src/imap/watcher.ts) backs off exponentially per
# account (1s, 2s, 4s, ... capped at 5min) for up to 20 consecutive
# failures before giving up on that one account, and /healthz reports 503
# while ANY account is merely 'reconnecting' (see src/health.ts). With
# interval=30s/retries=3/start-period=20s, a container would be marked
# unhealthy after only ~110s of a degraded account -- well inside the range
# of an ordinary transient IMAP blip (a server restart, a brief network
# hiccup) that the app is already recovering from on its own. Marking (and
# potentially restarting) the container mid-recovery would throw away that
# progress for no benefit: a restart cannot fix a still-unreachable IMAP
# host, and cannot fix a bad password either (auth-failed is deliberately
# terminal per-account and env vars don't change across a restart).
#
# start-period=45s gives the initial concurrent connect attempts (all
# accounts, Promise.allSettled) room to succeed before failures start
# counting. interval=30s/retries=5 requires ~150s of continuously degraded
# state (roughly the app's own first 6-7 backoff attempts) before flipping
# unhealthy -- long enough to ride out a normal transient outage, short
# enough to still surface a genuinely stuck daemon.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
