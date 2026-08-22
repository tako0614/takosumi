import platformWorker, {
  type CloudflareWorkerEnv,
  type PlatformExecutionContext,
} from "./worker.ts";
import {
  OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
  operatorControlMcpEnabled,
} from "../operator-control-mcp.ts";
import { TAKOSERVER_HOSTED_INSTALL_CONFIGS } from "./takoserver_hosted_install_configs.ts";

export {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
} from "./worker.ts";

const composed = new WeakMap<object, CloudflareWorkerEnv>();

export function composeTakoserverHostedWorkerEnv(
  env: CloudflareWorkerEnv,
): CloudflareWorkerEnv {
  const existing = composed.get(env);
  if (existing) return existing;
  // The platform runtime deliberately builds its string environment from
  // Object.entries(env).  An Object.create(env) wrapper therefore hides every
  // Wrangler variable on the prototype and can make the authenticated control
  // plane fail initialization even though direct D1 binding reads still work.
  // Copy the Worker bindings/variables as own enumerable properties and add
  // only the code-owned install composition.
  const value = { ...env } as CloudflareWorkerEnv;
  const installConfigs = operatorControlMcpEnabled(env)
    ? [
        ...TAKOSERVER_HOSTED_INSTALL_CONFIGS,
        OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
      ]
    : TAKOSERVER_HOSTED_INSTALL_CONFIGS;
  Object.defineProperty(value, "TAKOSUMI_INSTALL_CONFIG_COMPOSITION", {
    configurable: false,
    enumerable: true,
    value: installConfigs,
    writable: false,
  });
  composed.set(env, value);
  return value;
}

export default {
  async fetch(
    request: Request,
    env: CloudflareWorkerEnv,
    context?: PlatformExecutionContext,
  ): Promise<Response> {
    return await platformWorker.fetch(
      request,
      composeTakoserverHostedWorkerEnv(env),
      context,
    );
  },
  async scheduled(
    event: unknown,
    env: CloudflareWorkerEnv,
    context?: PlatformExecutionContext,
  ): Promise<void> {
    await platformWorker.scheduled(
      event,
      composeTakoserverHostedWorkerEnv(env),
      context,
    );
  },
};
