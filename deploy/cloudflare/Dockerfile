FROM docker.io/denoland/deno:alpine-2.5.6

WORKDIR /workspace

# Build this Dockerfile from the ecosystem root:
#   docker build -f takosumi-plugins/deploy/cloudflare/Dockerfile .
# Cloudflare's Wrangler container build must use an equivalent context that
# includes both takos/paas and takosumi-plugins.
COPY takos/paas ./takos/paas
COPY takosumi-plugins ./takosumi-plugins

WORKDIR /workspace/takos/paas

ENV TAKOS_PAAS_PROCESS_ROLE=takosumi-api
ENV TAKOS_PROCESS_ROLE=takosumi-api
ENV TAKOS_PORT=8080

EXPOSE 8080

CMD ["deno", "run", "--config", "deno.json", "--allow-all", "apps/paas/src/index.ts"]
