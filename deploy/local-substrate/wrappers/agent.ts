/**
 * Boots the takosumi runtime-agent (execution plane) for the local-substrate.
 *
 * This is the execution half split out of `service-with-embedded-agent.ts`. In
 * the redesigned substrate the `cloud` control-plane service runs the composed
 * service + account-plane and dispatches source / lifecycle / capability
 * execution HERE over `TAKOSUMI_AGENT_URL` (+ `TAKOSUMI_AGENT_TOKEN`). Running
 * the agent in its own container:
 *   - mirrors production — a Cloudflare Worker control plane cannot embed a
 *     subprocess agent, so execution is always an external binding;
 *   - isolates docker.sock / subprocess privilege OFF the control plane that
 *     also serves OIDC / billing / dashboard.
 *
 * The local substrate no longer imports a sibling provider package. OpenTofu /
 * provider materialization is operator-owned, so this agent starts with an
 * empty runtime handler registry unless the operator wrapper supplies its own
 * registry implementation.
 */
import { serveRuntimeAgent } from "/workspace/src/runtime-agent/server.ts";
import { LIFECYCLE_AGENT_TOKEN_ENV } from "/workspace/src/contract/runtime-agent-lifecycle.ts";
import { currentRuntime } from "/workspace/src/service/shared/runtime/index.ts";
import { buildLocalSubstrateRegistry } from "/local-substrate-factories/local-substrate-factories.ts";

const agentPort = Number(process.env.TAKOSUMI_AGENT_PORT ?? "8789");
// Bind 0.0.0.0 (NOT 127.0.0.1 like the in-process embed) so the `cloud`
// container reaches the agent across the compose network at http://agent:8789.
const hostname = process.env.TAKOSUMI_AGENT_HOSTNAME ?? "0.0.0.0";

const env = { ...process.env };
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
    `(${registry.size()} runtime handlers)`,
);

const runtime = currentRuntime();
const shutdown = (signal: string) => {
  console.log(`[local-substrate-agent] received ${signal}, draining...`);
  agent.shutdown().finally(() => process.exit(0));
};
runtime.onSignal("SIGINT", () => shutdown("SIGINT"));
runtime.onSignal("SIGTERM", () => shutdown("SIGTERM"));

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
