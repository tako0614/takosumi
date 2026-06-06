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

RUN curl -fsSL \
    "https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}/tofu_${OPENTOFU_VERSION}_linux_amd64.zip" \
    -o /tmp/tofu.zip \
    && unzip /tmp/tofu.zip -d /usr/local/bin \
    && rm /tmp/tofu.zip \
    && tofu version

# ---------------------------------------------------------------------------
# Provider mirror (baked, offline plan/apply).
#
# Pre-mirror the provider set the official templates need into a filesystem
# mirror so `tofu init` resolves providers from disk with NO network round-trip
# to registry.opentofu.org. The baked tofu.rc (TF_CLI_CONFIG_FILE) wires a
# plugin_cache_dir + a provider_installation block whose filesystem_mirror is
# authoritative for the mirrored providers and `direct { exclude=[...] }`
# forbids reaching the network for exactly those providers.
#
# Mirror list is intentionally MINIMAL (cloudflare + random + tls). aws/google
# mirrors are large and come later; until then those providers fall through to
# `direct` (network) install, which is fine for raw-module installs but the
# official Cloudflare templates only need this set.
# ---------------------------------------------------------------------------
ENV OPENTOFU_PROVIDER_MIRROR=/opt/opentofu/provider-mirror
ENV OPENTOFU_PROVIDER_CACHE=/opt/opentofu/provider-cache
ENV TF_CLI_CONFIG_FILE=/opt/opentofu/tofu.rc

# The baked CLI config. plugin_cache_dir speeds warm re-inits; the
# provider_installation filesystem_mirror serves the mirrored providers from
# disk and `direct { exclude }` keeps tofu from going to the network for them.
COPY runner-image/tofu.rc ${TF_CLI_CONFIG_FILE}

# Minimal build-time config that pins the provider set to mirror. Lives in its
# own dir so `tofu providers mirror` resolves only this config.
COPY runner-image/mirror-providers.tf /opt/opentofu/mirror-build/providers.tf

RUN set -eux; \
    mkdir -p "${OPENTOFU_PROVIDER_MIRROR}" "${OPENTOFU_PROVIDER_CACHE}"; \
    # `tofu providers mirror` must NOT use the baked filesystem-mirror config
    # (it is what populates that mirror); run it with an empty CLI config so it
    # talks to the registry directly.
    env -u TF_CLI_CONFIG_FILE tofu -chdir=/opt/opentofu/mirror-build \
        providers mirror "${OPENTOFU_PROVIDER_MIRROR}"; \
    rm -rf /opt/opentofu/mirror-build; \
    ls -R "${OPENTOFU_PROVIDER_MIRROR}" | head -40

# Official template modules baked from the repo-root catalog (templates/<id>/
# module + template.ts metadata; the .ts files are inert in the image). The
# `template.localModulePath` points at a directory under here (e.g.
# /app/templates/cloudflare-r2-bucket/module); the runner copies it to
# /work/generated-root/template-module at plan/apply time. Raw-module installs
# never touch this directory.
WORKDIR /app
COPY opentofu-modules/ ./templates/

# The runner server imports the dependency-free shared provider->env-name table
# from src/contract via a relative path. The build context is the repo root
# (image_build_context = "../.."), so we copy both files preserving the
# entrypoint.ts -> ../packages/schema/src/provider-env-rules.ts relative layout. No
# other repo source (or the Worker browser bundle) is copied into the image.
COPY packages/schema/src/provider-env-rules.ts ./packages/schema/src/provider-env-rules.ts
COPY runner-image/entrypoint.ts ./runner-image/entrypoint.ts

ENV PORT=8080
ENV TOFU_WORK_DIR=/workspace

EXPOSE 8080
CMD ["bun", "run", "./runner-image/entrypoint.ts"]
