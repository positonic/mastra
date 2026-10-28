# syntax=docker/dockerfile:1
#
# Mastra agent service image, for the self-host Docker Compose stack.
#
# Build from the repo root (the context is the repo, the file lives here):
#   docker build -f docker/Dockerfile -t mastra .
#
# Reproduces what Railway's default builder does for production from
# package.json: `npm run build` (`mastra build`), then
# `npm start` (`node .mastra/output/index.mjs`).
#
# Why docker/ and not the repo root: Railway switches a service to Dockerfile
# builds when it finds a `Dockerfile` at the root, and applies a root
# `.dockerignore` to its builds. Keeping both here leaves the production
# Railway deploy on its default builder, untouched. The ignore rules are in
# docker/Dockerfile.dockerignore, which BuildKit reads for this Dockerfile
# in place of a root .dockerignore.
#
# Dependencies install from package-lock.json with `npm ci`, the same lockfile
# and command CI runs. bun.lockb is not used here.

# ---- build ------------------------------------------------------------------
# Full Debian image: npm ci needs git for the libsignal git dependency, and
# the toolchain covers native modules that have no prebuilt binary.
FROM node:22-bookworm AS build
WORKDIR /app

# postinstall runs patch-package, so the patches must be in place before npm ci.
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# NODE_ENV=production turns off the dev-only fallbacks in src/mastra/index.ts
# (EXPONENTIAL_TEST_JWT and the injected test workspace/project ids).
ENV NODE_ENV=production \
    PORT=4111

# Same layout production runs from: the bundled server under .mastra/output,
# with the installed node_modules beside it.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.mastra/output ./.mastra/output

# Gateway session files are written under $HOME/.mastra (/home/node/.mastra).
USER node

EXPOSE 4111
CMD ["node", ".mastra/output/index.mjs"]
