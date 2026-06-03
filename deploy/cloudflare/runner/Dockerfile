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

WORKDIR /runner
COPY runner/server.ts ./server.ts

ENV PORT=8080
ENV TOFU_WORK_DIR=/workspace

EXPOSE 8080
CMD ["bun", "run", "./server.ts"]
