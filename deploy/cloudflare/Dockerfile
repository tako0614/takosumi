FROM docker.io/denoland/deno:alpine-2.5.6

WORKDIR /workspace

# Build this Dockerfile from the takosumi repository root:
#   docker build -f deploy/cloudflare/Dockerfile .
COPY . ./takosumi

WORKDIR /workspace/takosumi

ENV TAKOSUMI_PROCESS_ROLE=takosumi-api
ENV TAKOSUMI_PORT=8080

EXPOSE 8080

CMD ["deno", "run", "--config", "deno.json", "--allow-all", "packages/kernel/src/index.ts"]
