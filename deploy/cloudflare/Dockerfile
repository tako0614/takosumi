FROM docker.io/denoland/deno:alpine-2.5.6

WORKDIR /workspace

# Build this Dockerfile from the ecosystem root:
#   docker build -f takos-paas-plugins/deploy/cloudflare/Dockerfile .
# Cloudflare's Wrangler container build must use an equivalent context that
# includes both takos/paas and takos-paas-plugins.
COPY takos/paas ./takos/paas
COPY takos-paas-plugins ./takos-paas-plugins

WORKDIR /workspace/takos/paas

ENV TAKOS_PAAS_PROCESS_ROLE=takos-paas-api
ENV TAKOS_PROCESS_ROLE=takos-paas-api
ENV TAKOS_PORT=8080

EXPOSE 8080

CMD ["deno", "run", "--config", "deno.json", "--allow-all", "apps/paas/src/index.ts"]
