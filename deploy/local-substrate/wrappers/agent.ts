/**
 * Boots the takosumi runtime-agent (execution plane) for the local-substrate.
 *
 * This is the execution half split out of `kernel-with-embedded-agent.ts`. In
 * the redesigned substrate the `cloud` control-plane service runs the composed
 * kernel + account-plane and dispatches source / lifecycle / capability
 * execution HERE over `TAKOSUMI_AGENT_URL` (+ `TAKOSUMI_AGENT_TOKEN`). Running
 * the agent in its own container:
 *   - mirrors production — a Cloudflare Worker control plane cannot embed a
 *     subprocess agent, so execution is always an external binding;
 *   - isolates docker.sock / subprocess privilege OFF the control plane that
 *     also serves OIDC / billing / dashboard.
 *
 * Like the old kernel wrapper this imports the runtime-agent + native
 * connectors from local /workspace + /plugins (under active development) rather
 * than the JSR/npm-pinned cli, and uses `buildLocalSubstrateRegistry` so
 * public-DNS providers (route53 / cloud-dns / cloudflare-dns) are import-time
 * denied — see /local-substrate-factories/local-substrate-factories.ts.
 *
 * Runs with `--config /workspace/deno.json` (takosumi root) — the same config /
 * mounts the proven kernel wrapper used, so /plugins specifier resolution is
 * unchanged.
 */
import { serveRuntimeAgent } from "/workspace/src/runtime-agent/server.ts";
import { LIFECYCLE_AGENT_TOKEN_ENV } from "/workspace/src/contract/runtime-agent-lifecycle.ts";
import { currentRuntime } from "/workspace/src/kernel/shared/runtime/index.ts";
import { buildLocalSubstrateRegistry } from "/local-substrate-factories/local-substrate-factories.ts";

const agentPort = Number(Deno.env.get("TAKOSUMI_AGENT_PORT") ?? "8789");
// Bind 0.0.0.0 (NOT 127.0.0.1 like the in-process embed) so the `cloud`
// container reaches the agent across the compose network at http://agent:8789.
const hostname = Deno.env.get("TAKOSUMI_AGENT_HOSTNAME") ?? "0.0.0.0";

const env = Deno.env.toObject();
const registry = buildLocalSubstrateRegistry(env);
// The token MUST match the `cloud` service's TAKOSUMI_AGENT_TOKEN; both env
// files set the same fixture value. The random fallback only guards a missing
// env (which would fail auth against the control plane — intentionally loud).
const token = env[LIFECYCLE_AGENT_TOKEN_ENV] ?? randomToken();

const agent = serveRuntimeAgent({
  registry,
  token,
  port: agentPort,
  hostname,
});

console.log(
  `[local-substrate-agent] runtime-agent at ${agent.url} ` +
    `(${registry.size()} connectors, public DNS providers denied at import time)`,
);

const runtime = currentRuntime();
const shutdown = (signal: string) => {
  console.log(`[local-substrate-agent] received ${signal}, draining...`);
  agent.shutdown().finally(() => Deno.exit(0));
};
runtime.onSignal("SIGINT", () => shutdown("SIGINT"));
runtime.onSignal("SIGTERM", () => shutdown("SIGTERM"));

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
