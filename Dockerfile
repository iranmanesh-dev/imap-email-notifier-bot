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
# rebuild has nothing to hook into). node-gyp is invoked directly instead
# via `npx`, backed by `node-gyp` as an explicit devDependency (see
# package.json) rather than reaching into npm's own bundled copy at a
# hardcoded internal path -- more standard, and doesn't break if a future
# npm version moves or removes its vendored node-gyp.
#
# The prebuilds directory is removed BEFORE invoking node-gyp, not after,
# for two independent reasons, both load-bearing:
#   1. (build time) better-sqlite3's binding.gyp checks `prebuild_exists% :
#      '<!(node lib/binding.js)'` at gyp-configure time and makes its
#      compile target a `type: 'none'` no-op whenever a prebuild for the
#      host platform is present -- discovered by first deleting prebuilds
#      afterwards and getting a "successful" build that had actually only
#      touched stamp files with no compiled .node at all. `--force_build=1`
#      alone does not override this the way it looks like it should.
#   2. (run time, found on review) even with a real compiled binary sitting
#      in build/Release, `better-sqlite3/lib/binding.js`'s getBinding()
#      checks getPrebuildPath() FIRST and only falls back to build/Release
#      if no prebuild file exists. So even a successful from-source compile
#      would silently load the broken bundled prebuild at runtime unless
#      prebuilds/ is gone -- `rm -rf prebuilds` is not just a way to force
#      the compile, it is what makes the compiled output the thing that
#      actually loads.
# Verified by running the resulting module before trusting it (the
# `node -e require(...)` line below fails the whole build otherwise).
RUN npm run build && \
    rm -rf node_modules/better-sqlite3/prebuilds && \
    npx node-gyp rebuild --release --force_build=1 -C node_modules/better-sqlite3 && \
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

# This HEALTHCHECK deliberately checks LIVENESS ONLY -- did /healthz answer
# at all -- and ignores the HTTP status code entirely. An earlier version of
# this file failed on r.ok (i.e. treated the app's own 503-while-degraded
# response as unhealthy) and got the following wrong, per review:
#
# A container HEALTHCHECK's only real lever is provoking a restart (Docker
# itself doesn't restart on "unhealthy", but Coolify and other orchestrators
# do, and Coolify additionally gates a *deploy* on reaching healthy). So the
# only question that matters is: is there a degraded state a restart fixes?
#   - 'reconnecting': a restart resets AccountWatcher's backoff `attempt` to
#     0, making the replacement MORE aggressive against a mailbox that's
#     already mid-recovery on its own -- strictly worse, not fixed.
#   - 'auth-failed': env vars don't change across a restart, so it just
#     re-submits the same wrong password and re-sends the Telegram alert.
#     Repeated failed IMAP logins are exactly what gets a VPS IP blocked.
#   - 'connect-failed': a restart zeroes the per-account consecutive-failure
#     counter, defeating MAX_CONSECUTIVE_FAILURES=20 (src/imap/watcher.ts) at
#     the orchestration layer -- an unbounded retry loop across restarts,
#     when that cap exists specifically to bound it.
#   - a genuinely wedged process / dead-but-bound event loop / health server
#     that never bound: `fetch` itself fails or times out here regardless of
#     status-code handling, so liveness-only already catches this.
# Every degraded-but-alive state a restart could theoretically "fix" is a
# state a restart actively makes worse or does nothing for; every case a
# restart legitimately helps is already caught by liveness alone. So the
# status code is checked for nothing and cost real harm (restart loops,
# and Coolify marking an in-spec degraded deploy as FAILED and possibly
# rolling it back). Degraded-account visibility instead goes through three
# channels that aren't "kill the process": the /healthz response body
# (still 503 with `{status, accounts}` detail -- see src/health.ts), the
# Telegram alert AccountWatcher's onFatal sends, and stderr. See README.
#
# --retries=3 (down from a wider window this file used when the status code
# still mattered): only liveness needs covering now, so the multi-minute
# reconnect-backoff runway is irrelevant. --start-period=45s is kept: it's
# sized for the initial concurrent connect attempts (all accounts via
# Promise.allSettled) to run and the health server to bind, not for any
# degraded state to clear.
#
# HEALTH_PORT is read from process.env here (not hardcoded) so this check
# can't silently diverge from a deployment that overrides HEALTH_PORT --
# see src/config.ts's own HEALTH_PORT default (8080), mirrored below.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "const p=process.env.HEALTH_PORT||'8080';fetch('http://127.0.0.1:'+p+'/healthz').then(()=>process.exit(0)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
