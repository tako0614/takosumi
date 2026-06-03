/**
 * Embedded runtime-agent.
 *
 * Allows operator wrappers to spawn an in-process runtime-agent for
 * single-VM development. Operators pass the handler registry they want to
 * expose; the runtime-agent package itself does not auto-load backend
 * handlers. A random bearer token is generated and exported via
 * `TAKOSUMI_AGENT_TOKEN` when requested so internal compatibility clients can
 * discover it.
 *
 * For multi-host production, operators run their own distribution wrapper and
 * set `TAKOSUMI_AGENT_URL` + `TAKOSUMI_AGENT_TOKEN` explicitly —
 * `startEmbeddedAgent` is bypassed.
 */

import {
  LIFECYCLE_AGENT_TOKEN_ENV,
  LIFECYCLE_AGENT_URL_ENV,
} from "takosumi-contract/reference/runtime-agent-lifecycle";
import { RuntimeHandlerRegistry } from "./handlers.ts";
import { setRuntimeEnv } from "./runtime.ts";
import { type ServeHandle, serveRuntimeAgent } from "./server.ts";

export interface EmbedOptions {
  readonly port?: number;
  readonly hostname?: string;
  /** Optional explicit handler registry. Defaults to an empty registry. */
  readonly registry?: RuntimeHandlerRegistry;
  /**
   * Deprecated compatibility field. RuntimeHandler discovery is operator-owned;
   * this value is no longer inspected by the generic runtime-agent package.
   */
  readonly env?: Record<string, string | undefined>;
  /** Override token (default: random hex). */
  readonly token?: string;
  /** When true, export agentUrl/token to the current process env. */
  readonly exportToProcessEnv?: boolean;
}

export interface EmbeddedAgentHandle extends ServeHandle {
  readonly token: string;
}

export function startEmbeddedAgent(
  options: EmbedOptions = {},
): EmbeddedAgentHandle {
  const token = options.token ?? randomToken();
  const registry = options.registry ?? new RuntimeHandlerRegistry();
  const handle = serveRuntimeAgent({
    port: options.port,
    hostname: options.hostname,
    registry,
    token,
  });
  if (options.exportToProcessEnv !== false) {
    setRuntimeEnv(LIFECYCLE_AGENT_URL_ENV, handle.url);
    setRuntimeEnv(LIFECYCLE_AGENT_TOKEN_ENV, token);
  }
  return Object.freeze({ ...handle, token });
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
