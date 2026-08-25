import platformWorker, {
  type CloudflareWorkerEnv,
  type PlatformExecutionContext,
} from "./worker.ts";
import {
  OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
  operatorControlMcpEnabled,
} from "../operator-control-mcp.ts";
import { composeTakosInstallConfig } from "./takos_install_config.ts";
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
  const operatorOrigin =
    typeof env.TAKOSUMI_ACCOUNTS_ISSUER === "string"
      ? new URL(env.TAKOSUMI_ACCOUNTS_ISSUER).origin
      : undefined;
  const operatorInstallConfig = operatorOrigin
    ? {
        ...OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
        variableMapping: { takosumi_origin: operatorOrigin },
      }
    : OPERATOR_CONTROL_MCP_INSTALL_CONFIG;
  const takosInstallConfig = composeTakosInstallConfig(env);
  const installConfigs = operatorControlMcpEnabled(env)
    ? [
        ...TAKOSERVER_HOSTED_INSTALL_CONFIGS,
        ...(takosInstallConfig ? [takosInstallConfig] : []),
        operatorInstallConfig,
      ]
    : takosInstallConfig
      ? [...TAKOSERVER_HOSTED_INSTALL_CONFIGS, takosInstallConfig]
      : TAKOSERVER_HOSTED_INSTALL_CONFIGS;
  Object.defineProperty(value, "TAKOSUMI_INSTALL_CONFIG_COMPOSITION", {
    configurable: false,
    enumerable: true,
    value: installConfigs,
    writable: false,
  });
  const hosted = (env as CloudflareWorkerEnv & {
    readonly HOSTED?: {
      authorizeInterfaceOAuth2Resource?(input: {
        readonly workspaceId: string;
        readonly capsuleId: string;
        readonly resource: string;
      }): Promise<boolean>;
    };
  }).HOSTED;
  if (typeof hosted?.authorizeInterfaceOAuth2Resource === "function") {
    Object.defineProperty(
      value,
      "TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER",
      {
        configurable: false,
        enumerable: true,
        value: async (input: {
          readonly workspaceId: string;
          readonly ownerRef: { readonly kind: string; readonly id: string };
          readonly resource: string;
        }): Promise<boolean> => {
          if (input.ownerRef.kind !== "Capsule") return false;
          try {
            return (
              (await hosted.authorizeInterfaceOAuth2Resource?.({
                workspaceId: input.workspaceId,
                capsuleId: input.ownerRef.id,
                resource: input.resource,
              })) === true
            );
          } catch {
            return false;
          }
        },
        writable: false,
      },
    );
  }
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
