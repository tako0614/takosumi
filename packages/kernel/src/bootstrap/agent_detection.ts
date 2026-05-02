/**
 * Bootstrap-time runtime-agent detection.
 *
 * Reads the runtime env to figure out where the runtime-agent lives and which
 * bearer token to use. This is the ONLY thing the kernel needs from the
 * environment for provider registration — credentials live entirely on the
 * agent host.
 *
 * Required env vars:
 *  - `TAKOSUMI_AGENT_URL` — base URL of the runtime-agent (e.g. `http://127.0.0.1:8789`)
 *  - `TAKOSUMI_AGENT_TOKEN` — Bearer token shared between kernel and agent
 *
 * If both are unset, no providers are registered (the kernel still boots and
 * serves apply requests, but they all fail with `provider not found` until an
 * agent is configured).
 */

export interface DetectedAgent {
  readonly agentUrl: string;
  readonly token: string;
}

export function detectRuntimeAgent(
  env: Record<string, string | undefined>,
): DetectedAgent | undefined {
  const agentUrl = env.TAKOSUMI_AGENT_URL;
  const token = env.TAKOSUMI_AGENT_TOKEN;
  if (!agentUrl || !token) return undefined;
  return { agentUrl, token };
}
