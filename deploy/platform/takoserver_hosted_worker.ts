import platformWorker, {
  type CloudflareWorkerEnv,
  type PlatformExecutionContext,
  OpenTofuRunOwnerObject as BaseOpenTofuRunOwnerObject,
} from "./worker.ts";
import {
  executionEvidenceAuthorityFromEnv,
  validateRunnerProfileConfiguration,
} from "../../worker/src/deploy_control_seam.ts";
import {
  OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
  operatorControlMcpEnabled,
} from "../operator-control-mcp.ts";
import { defaultCapsuleInstallConfig } from "../../core/domains/capsules/default_install_config.ts";
import type { InstallConfig } from "takosumi-contract/install-configs";

export {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunnerObject,
} from "./worker.ts";

/**
 * The platform's RunOwner Durable Object is constructed by Wrangler with the
 * raw binding object, before the entrypoint's fetch/scheduled handlers run.
 * Route that constructor through the same hosted composition used by both
 * request paths so the owner dispatches with the release-pinned evidence
 * authority too.  The base class remains the implementation owner; this
 * wrapper only supplies its composed environment.
 */
export class OpenTofuRunOwnerObject extends BaseOpenTofuRunOwnerObject {
  constructor(
    ...args: ConstructorParameters<typeof BaseOpenTofuRunOwnerObject>
  ) {
    const [state, env, deps] = args;
    // The base DO is declared against the deploy-control bindings only while
    // the hosted entrypoint composes the Accounts/deploy intersection.  The
    // wrapper adds no required binding; retain the base constructor's narrow
    // env type after composing the shared runtime object.
    super(
      state,
      composeTakoserverHostedWorkerEnv(
        env as unknown as CloudflareWorkerEnv,
      ),
      deps,
    );
  }
}

const composed = new WeakMap<object, CloudflareWorkerEnv>();
const EMPTY_INSTALL_CONFIGS = Object.freeze([]);

function stagingLocalExecEnabled(env: CloudflareWorkerEnv): boolean {
  return (
    env.TAKOSUMI_ENVIRONMENT === "staging" &&
    env.TAKOSUMI_STAGING_ALLOW_LOCAL_EXEC === "1"
  );
}

function stagingLocalExecInstallConfig(): InstallConfig {
  const defaultConfig = defaultCapsuleInstallConfig();
  return Object.freeze({
    ...defaultConfig,
    policy: Object.freeze({
      ...defaultConfig.policy,
      allowedProvisionerTypes: Object.freeze(["local-exec"]),
    }),
  });
}

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
  const existingComposition = validateRunnerProfileConfiguration(env)
    .hostComposition;
  const executionEvidenceAuthority = executionEvidenceAuthorityFromEnv(env);
  if (executionEvidenceAuthority) {
    const existingAuthority = existingComposition?.executionEvidenceAuthority;
    if (
      existingAuthority &&
      JSON.stringify(existingAuthority) !==
        JSON.stringify(executionEvidenceAuthority)
    ) {
      throw new TypeError(
        "runner host composition execution evidence authority conflicts with release pins",
      );
    }
    Object.defineProperty(value, "TAKOSUMI_RUNNER_HOST_COMPOSITION", {
      configurable: false,
      enumerable: true,
      value: Object.freeze({
        ...(existingComposition ?? { profiles: [] }),
        executionEvidenceAuthority:
          existingAuthority ?? executionEvidenceAuthority,
      }),
      writable: false,
    });
  }
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
  const installConfigEntries: InstallConfig[] = [];
  if (stagingLocalExecEnabled(env)) {
    installConfigEntries.push(stagingLocalExecInstallConfig());
  }
  if (operatorControlMcpEnabled(env)) {
    installConfigEntries.push(operatorInstallConfig);
  }
  const installConfigs =
    installConfigEntries.length > 0
      ? Object.freeze(installConfigEntries)
      : EMPTY_INSTALL_CONFIGS;
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
