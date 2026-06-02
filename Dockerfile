# Takosumi Accounts image for product-root compose builds.
#
# The self-hosted private composition builds from the Takosumi product root so
# operators can run the Accounts CLI and migration commands from one image.

FROM oven/bun:1 AS deps
WORKDIR /work

COPY package.json bun.lock tsconfig.json bunfig.toml /work/
COPY src /work/src
COPY packages/accounts-contract /work/packages/accounts-contract
COPY packages/accounts-service /work/packages/accounts-service
COPY packages/all /work/packages/all
COPY packages/cli /work/packages/cli
COPY packages/platform-services /work/packages/platform-services
COPY deploy/node-postgres/package.json /work/deploy/node-postgres/package.json
COPY deploy/node-postgres/src /work/deploy/node-postgres/src
RUN bun install --frozen-lockfile

FROM oven/bun:1
WORKDIR /app
COPY --from=deps --chown=bun:bun /work /app

ENV TAKOSUMI_ACCOUNTS_BIND_HOST=0.0.0.0
ENV TAKOSUMI_ACCOUNTS_PORT=8787
EXPOSE 8787

USER bun
CMD ["bun", "/app/packages/cli/src/main.ts", "accounts", "serve", "--hostname", "0.0.0.0", "--port", "8787"]
