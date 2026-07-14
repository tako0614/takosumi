FROM oven/bun:1

# OpenTofu 1.11.x. Pinned to the latest 1.11 patch at image-build time; the
# download URL shape is the published GitHub release asset
# tofu_${VERSION}_linux_amd64.zip.
ARG OPENTOFU_VERSION=1.11.8

# Source-sync (LANE M1) needs git + openssh-client to clone over https/ssh and
# zstd to compress the deterministic source archive. tar is in the debian base.
# ca-certificates + git + curl + unzip were already required by OpenTofu install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip openssh-client zstd \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    asset="tofu_${OPENTOFU_VERSION}_linux_amd64.zip"; \
    base="https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}"; \
    curl -fsSL "${base}/${asset}" -o "/tmp/${asset}"; \
    curl -fsSL "${base}/tofu_${OPENTOFU_VERSION}_SHA256SUMS" \
      -o /tmp/tofu_SHA256SUMS; \
    grep " ${asset}$" /tmp/tofu_SHA256SUMS > /tmp/tofu_SHA256SUM; \
    (cd /tmp && sha256sum -c /tmp/tofu_SHA256SUM); \
    unzip "/tmp/${asset}" -d /usr/local/bin; \
    rm "/tmp/${asset}" /tmp/tofu_SHA256SUM /tmp/tofu_SHA256SUMS; \
    tofu version

# ---------------------------------------------------------------------------
# Provider mirror (baked, offline plan/apply).
#
# Pre-mirror a curated cache into the reference image. The cache is an image
# optimization, not a provider catalog: the baked tofu.rc lets every provider
# use either the filesystem mirror or its ordinary registry. Mirror-only runs
# receive a generated CLI config with their explicit provider set. Runtime
# configs may use a run-local cache or the operator-configured
# TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR for provider binaries only.
#
# The concrete list is owned only by runner/mirror-providers.tf and can change
# with reference-image workload evidence without changing core semantics.
# ---------------------------------------------------------------------------
ENV OPENTOFU_PROVIDER_MIRROR=/opt/opentofu/provider-mirror
ENV TF_CLI_CONFIG_FILE=/opt/opentofu/tofu.rc

# The baked provider-neutral CLI config. Per-run generated configs may add a
# run-local or operator-configured provider plugin cache and strict policy.
COPY runner/tofu.rc ${TF_CLI_CONFIG_FILE}

# Minimal build-time config that pins the provider set to mirror. Lives in its
# own dir so `tofu providers mirror` resolves only this config.
COPY runner/mirror-providers.tf /opt/opentofu/mirror-build/providers.tf

RUN set -eux; \
    mkdir -p "${OPENTOFU_PROVIDER_MIRROR}"; \
    # `tofu providers mirror` must NOT use the baked filesystem-mirror config
    # (it is what populates that mirror); run it with an empty CLI config so it
    # talks to the registry directly.
    env -u TF_CLI_CONFIG_FILE tofu -chdir=/opt/opentofu/mirror-build \
        providers mirror "${OPENTOFU_PROVIDER_MIRROR}"; \
    rm -rf /opt/opentofu/mirror-build; \
    ls -R "${OPENTOFU_PROVIDER_MIRROR}" | head -40

# Capsule execution authority comes from the immutable Git/SourceSnapshot
# selected by the PlanRun. The image deliberately contains no app/module
# catalog. Explicit Resource Shape modules arrive through the operator-only
# dispatch seam after registry resolution.
WORKDIR /app

# The runner server imports the dependency-free shared provider->env-name table
# from the contract layer via a relative path. The build context is the repo root
# (image_build_context = "../.."), so we copy both files preserving the
# entrypoint.ts -> ../contract/provider-env-rules.ts relative layout. No
# other repo source (or the Worker browser bundle) is copied into the image.
COPY contract/provider-env-rules.ts ./contract/provider-env-rules.ts
COPY contract/reference/ip-classification.ts ./contract/reference/ip-classification.ts
COPY contract/reference/host-blocklist.ts ./contract/reference/host-blocklist.ts
COPY runner/entrypoint.ts ./runner/entrypoint.ts
# entrypoint.ts is a thin re-export/server shell; the runner implementation
# lives in runner/lib/*.ts (P3 god-file split). These MUST be copied or the
# container fails at runtime when entrypoint.ts imports ./lib/*.
COPY runner/lib/ ./runner/lib/
COPY runner/start.sh ./runner/start.sh
RUN chmod 0755 ./runner/start.sh

ENV PORT=8080
ENV TOFU_WORK_DIR=/workspace
ENV TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR=/tmp/takosumi-provider-cache
ENV TAKOSUMI_SOURCE_BUILD_CACHE_DIR=/tmp/takosumi-source-build-cache
ENV TAKOSUMI_RUNNER_START_SERVER=1

EXPOSE 8080
ENTRYPOINT ["/app/runner/start.sh"]
