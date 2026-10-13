# syntax=docker/dockerfile:1.7

# Takosumi Accounts — Bun + Postgres reference distribution.
#
# Substrate-neutral counterpart to deploy/accounts-cloudflare/. Runs the same
# accounts-service handler against PostgresAccountsStore on Bun.
# Use this to self-host on a VM, container, or Kubernetes pod.

FROM oven/bun:1.3.14 AS deps
WORKDIR /work
COPY package.json bun.lock tsconfig.json bunfig.toml /work/
# Every root workspace must be present for `bun install --frozen-lockfile`.
# The server (src/server.ts -> composed-app.ts) and the `migrations` CLI also
# import the embedded control plane from core/, lib/, providers/, and the
# contract tsconfig paths at runtime, so those trees ship in the image too.
COPY contract /work/contract
COPY core /work/core
COPY lib /work/lib
COPY providers /work/providers
COPY accounts/contract /work/accounts/contract
COPY accounts/service /work/accounts/service
COPY cli /work/cli
# The CLI statically imports this REST transport for its optional migrate-d1
# command. It does not need the Cloudflare Worker distribution or build tools.
COPY deploy/cloudflare/d1-rest-transport.ts /work/deploy/cloudflare/d1-rest-transport.ts
COPY deploy/node-postgres/package.json /work/deploy/node-postgres/package.json
COPY deploy/node-postgres/src /work/deploy/node-postgres/src
COPY worker/src/state_crypto.ts /work/worker/src/state_crypto.ts
RUN bun install --frozen-lockfile --production

# Build the dashboard SPA so the runtime image can serve it from the same
# origin as the API (parity with the Cloudflare Workers Static Assets profile).
# Built in an isolated stage; only the static `dist` directory is copied into
# the runtime image. If this build is removed/fails, the server auto-detects the
# missing build and disables static serving (it does not crash).
# The dashboard is not a root workspace: it installs from its own lockfile and
# only reads the two contract trees its vite aliases point at.
FROM oven/bun:1.3.14 AS dashboard
WORKDIR /work
COPY contract /work/contract
COPY accounts/contract /work/accounts/contract
COPY dashboard /work/dashboard
RUN cd dashboard && bun install --frozen-lockfile
RUN cd dashboard && bun run build

# App docs intentionally use their tracked npm lockfile. Keeping them in a
# separate Node stage prevents a developer's ignored docs/node_modules from
# becoming an undeclared build input.
FROM node:26.1.0-bookworm-slim AS app-docs
WORKDIR /work
# app-docs enables vitepress `lastUpdated`, which spawns `git` per page. The
# slim image has no git binary; `.git` stays excluded, so timestamps are empty.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
COPY docs/package.json docs/package-lock.json /work/docs/
RUN cd docs && npm ci --no-fund --no-audit
COPY app-docs /work/app-docs
COPY scripts/build-app-docs.sh /work/scripts/build-app-docs.sh
RUN bash scripts/build-app-docs.sh

FROM oven/bun:1.3.14
WORKDIR /app
# Runtime sources, workspace links and migration SQL only; build inputs such
# as lockfiles and the Cloudflare deployment tree stay out of the final image.
COPY --from=deps --chown=bun:bun /work/package.json /work/tsconfig.json /work/bunfig.toml /app/
COPY --from=deps --chown=bun:bun /work/node_modules /app/node_modules
COPY --from=deps --chown=bun:bun /work/contract /app/contract
COPY --from=deps --chown=bun:bun /work/core /app/core
COPY --from=deps --chown=bun:bun /work/lib /app/lib
COPY --from=deps --chown=bun:bun /work/providers /app/providers
COPY --from=deps --chown=bun:bun /work/accounts/contract /app/accounts/contract
COPY --from=deps --chown=bun:bun /work/accounts/service /app/accounts/service
COPY --from=deps --chown=bun:bun /work/cli /app/cli
COPY --from=deps --chown=bun:bun /work/deploy/node-postgres /app/deploy/node-postgres
COPY --from=deps --chown=bun:bun /work/worker/src/state_crypto.ts /app/worker/src/state_crypto.ts
COPY --from=deps --chown=bun:bun /work/deploy/cloudflare/d1-rest-transport.ts /app/deploy/cloudflare/d1-rest-transport.ts
COPY --from=dashboard --chown=bun:bun \
  /work/dashboard/dist \
  /app/dashboard/dist
COPY --from=app-docs --chown=bun:bun \
  /work/dashboard/dist/docs \
  /app/dashboard/dist/docs

# Outbound network destinations the accounts handler is allowed to reach.
# Defaults cover the Postgres service alias used by docker-compose and Google
# upstream OAuth. Operators that embed this image elsewhere
# should override the build arg, or set TAKOSUMI_ACCOUNTS_ALLOW_NET at runtime
# and enforce it at the container network / service-mesh layer.
ARG TAKOSUMI_ACCOUNTS_ALLOW_NET="postgres:5432"
ENV TAKOSUMI_ACCOUNTS_ALLOW_NET=${TAKOSUMI_ACCOUNTS_ALLOW_NET}
ENV TAKOSUMI_ACCOUNTS_BIND_HOST=0.0.0.0
ENV TAKOSUMI_ACCOUNTS_PORT=8787
EXPOSE 8787

# Docker initializes the named runtime volume from this private, bun-owned path.
RUN mkdir -p /var/lib/takosumi/backups \
  && chown -R bun:bun /var/lib/takosumi \
  && chmod 0700 /var/lib/takosumi /var/lib/takosumi/backups

# `oven/bun` ships a non-root `bun` user (uid/gid 1000:1000).
USER bun
CMD ["bun", "/app/deploy/node-postgres/src/server.ts"]
