# Takosumi Accounts — Bun + Postgres reference distribution.
#
# Substrate-neutral counterpart to deploy/accounts-cloudflare/. Runs the same
# accounts-service handler against PostgresAccountsStore on Bun.
# Use this to self-host on a VM, container, or Kubernetes pod.

FROM oven/bun:1 AS deps
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
FROM oven/bun:1 AS dashboard
WORKDIR /work
COPY package.json bun.lock tsconfig.json bunfig.toml /work/
COPY dashboard /work/dashboard
COPY docs /work/docs
COPY app-docs /work/app-docs
COPY scripts/build-app-docs.sh /work/scripts/build-app-docs.sh
RUN bun install --frozen-lockfile
RUN cd dashboard && bun run build && cd /work && bash scripts/build-app-docs.sh

FROM oven/bun:1
WORKDIR /app
COPY --from=deps --chown=bun:bun /work /app
COPY --from=dashboard --chown=bun:bun \
  /work/dashboard/dist \
  /app/dashboard/dist

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
