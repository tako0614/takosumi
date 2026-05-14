FROM docker.io/denoland/deno:alpine-2.5.6

WORKDIR /workspace

# Build this Dockerfile from the takosumi repository root:
#   docker build -f deploy/cloudflare/Dockerfile .
COPY . ./takosumi

WORKDIR /workspace/takosumi

# Create a non-root user (uid 10001) and grant ownership of the workspace and
# Deno cache so the kernel can read its sources / cache modules without root.
RUN addgroup -g 10001 -S takosumi \
  && adduser -S -D -H -u 10001 -G takosumi takosumi \
  && mkdir -p /home/takosumi /deno-dir \
  && chown -R takosumi:takosumi /workspace /home/takosumi /deno-dir

ENV TAKOSUMI_PROCESS_ROLE=takosumi-api
ENV PORT=8080
ENV DENO_DIR=/deno-dir
ENV HOME=/home/takosumi

USER takosumi

EXPOSE 8080

# Scoped permissions: the kernel needs
#   --allow-net          : HTTP server, npm:pg pool, audit replication sinks
#   --allow-read         : config files, migrations, plugin sources, heartbeat dir
#   --allow-write        : heartbeat file under TAKOSUMI_PAAS_WORKER_HEARTBEAT_FILE
#   --allow-env          : Deno.env.toObject() is called at boot (index.ts:35)
#                          so the env allowlist must be broad; scoping per-var
#                          is not viable without changing kernel boot code
#   --allow-sys          : npm:pg uses Node compat (os.hostname, cpus, etc.)
#   --allow-import       : Deno 2 requires this for dynamic npm: imports
# No --allow-run / --allow-ffi: kernel does not spawn subprocesses or load
# native libraries (verified: no Deno.Command / Deno.run / Deno.dlopen in
# packages/kernel/src).
CMD ["deno", "run", \
  "--config", "deno.json", \
  "--allow-net", \
  "--allow-read", \
  "--allow-write", \
  "--allow-env", \
  "--allow-sys", \
  "--allow-import", \
  "packages/kernel/src/index.ts"]
