# Takosumi Accounts — Bun + Postgres reference distribution.
#
# Substrate-neutral counterpart to deploy/accounts-cloudflare/. Runs the same
# accounts-service handler against PostgresAccountsStore on Bun.
# Use this to self-host on a VM, container, or Kubernetes pod.

FROM oven/bun:1 AS deps
WORKDIR /work
COPY package.json bun.lock tsconfig.json bunfig.toml /work/
COPY packages/accounts-contract /work/packages/accounts-contract
COPY packages/accounts-service /work/packages/accounts-service
COPY packages/all /work/packages/all
COPY packages/cli /work/packages/cli
COPY packages/platform-services /work/packages/platform-services
COPY deploy/node-postgres/package.json /work/deploy/node-postgres/package.json
COPY deploy/node-postgres/src /work/deploy/node-postgres/src
RUN bun install --frozen-lockfile

# Build the dashboard SPA so the runtime image can serve it from the same
# origin as the API (parity with the Cloudflare Workers Static Assets profile).
# Built in an isolated stage; only the static `.output/public` is copied into
# the runtime image. If this build is removed/fails, the server auto-detects the
# missing build and disables static serving (it does not crash).
FROM oven/bun:1 AS dashboard
WORKDIR /work
COPY package.json bun.lock tsconfig.json bunfig.toml /work/
COPY packages /work/packages
RUN bun install --frozen-lockfile
RUN cd packages/dashboard-ui && bun run build

FROM oven/bun:1
WORKDIR /app
COPY --from=deps --chown=bun:bun /work /app
COPY --from=dashboard --chown=bun:bun \
  /work/packages/dashboard-ui/.output/public \
  /app/packages/dashboard-ui/.output/public

# Outbound network destinations the accounts handler is allowed to reach.
# Defaults cover the Postgres service alias used by docker-compose, Stripe
# API, and the Google / GitHub / Apple upstream IdPs. Operators that
# embed this image elsewhere should override the build arg, or set
# TAKOSUMI_ACCOUNTS_ALLOW_NET at runtime and enforce it at the container
# network / service-mesh layer.
ARG TAKOSUMI_ACCOUNTS_ALLOW_NET="postgres:5432,api.stripe.com:443,accounts.google.com:443,oauth2.googleapis.com:443,openidconnect.googleapis.com:443,www.googleapis.com:443,github.com:443,api.github.com:443,appleid.apple.com:443"
ENV TAKOSUMI_ACCOUNTS_ALLOW_NET=${TAKOSUMI_ACCOUNTS_ALLOW_NET}
ENV TAKOSUMI_ACCOUNTS_BIND_HOST=0.0.0.0
ENV TAKOSUMI_ACCOUNTS_PORT=8787
EXPOSE 8787

# `oven/bun` ships a non-root `bun` user (uid/gid 1000:1000).
USER bun
CMD ["bun", "/app/deploy/node-postgres/src/server.ts"]
