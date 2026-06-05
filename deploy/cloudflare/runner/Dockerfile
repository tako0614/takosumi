FROM oven/bun:1

ARG OPENTOFU_VERSION=1.9.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL \
    "https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}/tofu_${OPENTOFU_VERSION}_linux_amd64.zip" \
    -o /tmp/tofu.zip \
    && unzip /tmp/tofu.zip -d /usr/local/bin \
    && rm /tmp/tofu.zip \
    && tofu version

# The runner server imports the dependency-free shared provider->env-name table
# from src/contract via a relative path. The build context is the repo root
# (image_build_context = "../.."), so we copy both files preserving the
# server.ts -> ../../../src/contract/provider-env-rules.ts relative layout. No
# other repo source (or the Worker browser bundle) is copied into the image.
WORKDIR /app
COPY src/contract/provider-env-rules.ts ./src/contract/provider-env-rules.ts
COPY deploy/cloudflare/runner/server.ts ./deploy/cloudflare/runner/server.ts

ENV PORT=8080
ENV TOFU_WORK_DIR=/workspace

EXPOSE 8080
CMD ["bun", "run", "./deploy/cloudflare/runner/server.ts"]
