ARG BUN_BASE_IMAGE=oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
FROM ${BUN_BASE_IMAGE}

# GA runner runtimes. Versions and official release archive checksums are
# immutable build inputs. The release workflow additionally verifies the
# OpenTofu SHA256SUMS Sigstore signature before this Dockerfile is built.
ARG OPENTOFU_VERSION=1.12.5
ARG OPENTOFU_SHA256=dade9650e6b74fc7a8b986bd8717497d32f9e09cf82e479afef4977fa3085536
ARG NODE_VERSION=24.19.0
ARG NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647

# Source-sync (LANE M1) needs git + openssh-client to clone over https/ssh and
# zstd to compress the deterministic source archive. tar is in the debian base.
# ca-certificates + git + curl + unzip were already required by OpenTofu install.
# xz-utils extracts the pinned Node runtime used by app-owned provider CLIs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip openssh-client xz-utils zstd \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    archive="node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" \
      -o "/tmp/${archive}"; \
    printf '%s  %s\n' "${NODE_SHA256}" "${archive}" \
      > /tmp/node_SHA256SUM; \
    (cd /tmp && sha256sum -c /tmp/node_SHA256SUM); \
    tar -xJf "/tmp/${archive}" \
      --strip-components=2 \
      -C /usr/local/bin \
      "node-v${NODE_VERSION}-linux-x64/bin/node"; \
    install -d -m 0755 /usr/local/share/licenses/node; \
    tar -xJf "/tmp/${archive}" \
      --strip-components=1 \
      -C /usr/local/share/licenses/node \
      "node-v${NODE_VERSION}-linux-x64/LICENSE"; \
    rm "/tmp/${archive}" /tmp/node_SHA256SUM; \
    test "$(node --version)" = "v${NODE_VERSION}"

RUN set -eux; \
    asset="tofu_${OPENTOFU_VERSION}_linux_amd64.zip"; \
    base="https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}"; \
    curl -fsSL "${base}/${asset}" -o "/tmp/${asset}"; \
    curl -fsSL "${base}/tofu_${OPENTOFU_VERSION}_SHA256SUMS" \
      -o /tmp/tofu_SHA256SUMS; \
    printf '%s  %s\n' "${OPENTOFU_SHA256}" "${asset}" \
      > /tmp/tofu_SHA256SUM; \
    grep -F "${OPENTOFU_SHA256}  ${asset}" /tmp/tofu_SHA256SUMS; \
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
ARG TAKOFORM_PROVIDER_VERSION=3.0.0
ARG TAKOFORM_PROVIDER_LINUX_AMD64_SHA256=f632146757f688dc4e48f65636fefe70fcbe2cb597d0e5e2f77cc1788a7f6585

# The baked provider-neutral CLI config. Per-run generated configs may add a
# run-local or operator-configured provider plugin cache and strict policy.
COPY runner/tofu.rc ${TF_CLI_CONFIG_FILE}

# Minimal build-time config that pins the provider set to mirror. Lives in its
# own dir so `tofu providers mirror` resolves only this config.
COPY runner/mirror-providers.tf /opt/opentofu/mirror-build/providers.tf
COPY runner/mirror-providers.lock.hcl /opt/opentofu/mirror-build/reviewed.lock.hcl

RUN set -eux; \
    mkdir -p "${OPENTOFU_PROVIDER_MIRROR}"; \
    cd /opt/opentofu/mirror-build; \
    # Regenerate the native lock with the pinned OpenTofu binary. This verifies
    # the registries' signed checksum metadata and fails if the reviewed source,
    # version, platform, or hash set drifts.
    env -u TF_CLI_CONFIG_FILE tofu providers lock -platform=linux_amd64; \
    cmp reviewed.lock.hcl .terraform.lock.hcl; \
    # `tofu providers mirror` must NOT use the baked filesystem-mirror config
    # (it is what populates that mirror); run it with an empty CLI config so it
    # talks to the registry directly.
    env -u TF_CLI_CONFIG_FILE tofu providers mirror -platform=linux_amd64 \
        "${OPENTOFU_PROVIDER_MIRROR}"; \
    takoform_archive="${OPENTOFU_PROVIDER_MIRROR}/registry.terraform.io/tako0614/takoform/terraform-provider-takoform_${TAKOFORM_PROVIDER_VERSION}_linux_amd64.zip"; \
    test -f "${takoform_archive}"; \
    printf '%s  %s\n' "${TAKOFORM_PROVIDER_LINUX_AMD64_SHA256}" \
        "${takoform_archive}" > /tmp/takoform_SHA256SUM; \
    sha256sum -c /tmp/takoform_SHA256SUM; \
    rm /tmp/takoform_SHA256SUM; \
    rm -rf /opt/opentofu/mirror-build; \
    ls -R "${OPENTOFU_PROVIDER_MIRROR}" | head -40

# Capsule execution authority comes from the immutable Git/SourceSnapshot
# selected by the PlanRun. The image deliberately contains no app/module
# catalog. Explicit Resource Shape modules arrive through the operator-only
# dispatch seam after registry resolution.
WORKDIR /app

# The runner server imports a small shared contract dependency closure via
# relative paths. The build context is the repo root
# (image_build_context = "../.."), so preserve that layout explicitly. No other
# repo source (or the Worker browser bundle) is copied into the image.
COPY contract/provider-env-rules.ts ./contract/provider-env-rules.ts
COPY contract/provider-configurations.ts ./contract/provider-configurations.ts
COPY contract/api-surface.ts ./contract/api-surface.ts
COPY contract/sources.ts ./contract/sources.ts
COPY contract/repository-manifest.ts ./contract/repository-manifest.ts
COPY contract/plan-scope.ts ./contract/plan-scope.ts
COPY contract/redaction.ts ./contract/redaction.ts
COPY contract/types.ts ./contract/types.ts
COPY contract/reference/ip-classification.ts ./contract/reference/ip-classification.ts
COPY contract/reference/host-blocklist.ts ./contract/reference/host-blocklist.ts
COPY lib/opentofu-configuration/src/mod.ts ./lib/opentofu-configuration/src/mod.ts
COPY runner/entrypoint.ts ./runner/entrypoint.ts
# entrypoint.ts is a thin re-export/server shell; the runner implementation
# lives in runner/lib/*.ts (P3 god-file split). These MUST be copied or the
# container fails at runtime when entrypoint.ts imports ./lib/*.
COPY runner/lib/ ./runner/lib/
COPY runner/start.sh ./runner/start.sh
# Sealed/private source checkouts may have owner-only source modes. COPY keeps
# those modes, so normalize only the immutable runtime closure before USER bun.
RUN chmod -R a+rX ./contract ./lib ./runner \
    && chmod 0755 ./runner/start.sh

# Provider/module code is untrusted workload input. The reference runner must
# not execute it as container root. Keep only the bounded run/cache directories
# writable by the image's unprivileged Bun account; application and mirror
# content remain root-owned and read-only to that account.
RUN install -d -o bun -g bun -m 0700 \
    /tmp/takosumi-runs \
    /tmp/takosumi-provider-cache \
    /tmp/takosumi-source-build-cache \
    /workspace

ENV PORT=8080
ENV TOFU_WORK_DIR=/workspace
ENV TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR=/tmp/takosumi-provider-cache
ENV TAKOSUMI_SOURCE_BUILD_CACHE_DIR=/tmp/takosumi-source-build-cache
ENV TAKOSUMI_RUNNER_START_SERVER=1

EXPOSE 8080
USER bun
ENTRYPOINT ["/app/runner/start.sh"]
