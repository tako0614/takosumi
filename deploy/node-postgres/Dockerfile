# syntax=docker/dockerfile:1.7

# Takosumi Accounts — Bun + Postgres reference distribution.
#
# Substrate-neutral counterpart to deploy/accounts-cloudflare/. Runs the same
# accounts-service handler against PostgresAccountsStore on Bun.
# Use this to self-host on a VM, container, or Kubernetes pod.

FROM oven/bun:1.3.14 AS deps
WORKDIR /work
COPY package.json bun.lock tsconfig.json bunfig.toml /work/
COPY accounts/contract /work/accounts/contract
COPY accounts/service /work/accounts/service
COPY cli /work/cli
COPY deploy/node-postgres/package.json /work/deploy/node-postgres/package.json
COPY deploy/node-postgres/src /work/deploy/node-postgres/src
RUN bun install --frozen-lockfile

# Build the dashboard SPA so the runtime image can serve it from the same
# origin as the API (parity with the Cloudflare Workers Static Assets profile).
# Built in an isolated stage; only the static `dist` directory is copied into
# the runtime image. If this build is removed/fails, the server auto-detects the
# missing build and disables static serving (it does not crash).
FROM oven/bun:1.3.14 AS dashboard
WORKDIR /work
COPY package.json bun.lock tsconfig.json bunfig.toml /work/
COPY dashboard /work/dashboard
RUN bun install --frozen-lockfile
RUN cd dashboard && bun install --frozen-lockfile
RUN cd dashboard && bun run build

# App docs intentionally use their tracked npm lockfile. Keeping them in a
# separate Node stage prevents a developer's ignored docs/node_modules from
# becoming an undeclared build input.
FROM node:26.1.0-bookworm-slim AS app-docs
WORKDIR /work
COPY docs/package.json docs/package-lock.json /work/docs/
RUN cd docs && npm ci --no-fund --no-audit
COPY app-docs /work/app-docs
COPY scripts/build-app-docs.sh /work/scripts/build-app-docs.sh
RUN bash scripts/build-app-docs.sh

FROM oven/bun:1.3.14
WORKDIR /app
COPY --from=deps --chown=bun:bun /work /app
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

# `oven/bun` ships a non-root `bun` user (uid/gid 1000:1000).
USER bun
CMD ["bun", "/app/deploy/node-postgres/src/server.ts"]
