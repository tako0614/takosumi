import platformWorker, {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
  type CloudflareWorkerEnv,
  type PlatformExecutionContext,
} from "./worker.ts";
import {
  type PlatformWorkerVersionMetadata,
  withPlatformWorkerVersion,
} from "./version_metadata_response.ts";
import { composeTakoserverHostedWorkerEnv } from "./takoserver_hosted_worker.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createCloudflareTakosumiRuntimeBindingMaterializer,
  type RuntimeBindingMaterializerInput,
  type RuntimeBindingMaterializerCloudflareEnv,
} from "./runtime_binding_materializer.ts";
import { controlD1BridgeChallengeResponse } from "./control_d1_bridge_challenge.ts";

export {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
};

/** Private RPC target used only by Takoserver's service binding. */
export class TakosumiRuntimeBindingMaterializerEntrypoint extends WorkerEntrypoint<
  VersionedPlatformEnv & RuntimeBindingMaterializerCloudflareEnv
> {
  async materializeRuntimeBindings(input: RuntimeBindingMaterializerInput) {
    try {
      return await createCloudflareTakosumiRuntimeBindingMaterializer(
        this.env,
      ).materializeRuntimeBindings(input);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "takosumi.runtime_binding_materialization_failed",
          reason: runtimeBindingFailureReason(error),
        }),
      );
      throw error;
    }
  }

  async commitRuntimeBindings(
    input: RuntimeBindingMaterializerInput,
  ): Promise<void> {
    try {
      await createCloudflareTakosumiRuntimeBindingMaterializer(
        this.env,
      ).commitRuntimeBindings(input);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "takosumi.runtime_binding_commit_failed",
          reason: runtimeBindingFailureReason(error),
        }),
      );
      throw error;
    }
  }

  rollbackRuntimeBindings(input: {
    readonly request: unknown;
    readonly rollbackReceipt: string;
  }) {
    return createCloudflareTakosumiRuntimeBindingMaterializer(
      this.env,
    ).rollbackRuntimeBindings(input);
  }
}

const RUNTIME_BINDING_FAILURE_REASONS = new Set([
  "Capsule is already bound to another OIDC client",
  "HTTPS origin is invalid",
  "OIDC binding profile is invalid",
  "OIDC activation authority is invalid",
  "OIDC activation profile is unavailable",
  "OIDC callback path is invalid",
  "OIDC client is already bound to another Capsule",
  "OIDC client activation authority is invalid",
  "clock is invalid",
  "current Accounts OIDC client indexes drifted",
  "current Accounts OIDC client metadata drift is not allowed",
  "generated secret profile is invalid",
  "runtime binding Capsule is not current",
  "runtime binding Capsule execution authority is not current",
  "runtime binding InstallConfig is not current",
  "runtime binding authority contract is invalid",
  "runtime binding authority is invalid",
  "runtime binding authority is not current",
  "runtime binding commit authority changed during confirmation",
  "runtime binding commit requires Apply phase",
  "runtime binding name is invalid",
  "runtime binding phase is invalid",
  "runtime binding profile is invalid",
  "runtime binding profile is missing",
  "runtime binding OIDC grant differs from the DB-owned profile",
  "runtime binding request differs from the DB-owned profile",
  "runtime binding Accounts registration differs from derived values",
  "runtime binding set contains duplicates",
  "runtime binding set is invalid",
  "runtime materialization did not produce the exact binding set",
  "runtime materialization object is not closed",
]);

function runtimeBindingFailureReason(error: unknown): string {
  if (
    error instanceof TypeError &&
    (RUNTIME_BINDING_FAILURE_REASONS.has(error.message) ||
      /^(?:resourceName|scriptName|pairwiseSubjectSecret|derivationKey) is invalid$/u.test(
        error.message,
      ))
  ) {
    return error.message;
  }
  return "dependency_unavailable";
}

type VersionedPlatformEnv = CloudflareWorkerEnv & {
  readonly TAKOSUMI_VERSION_METADATA?: PlatformWorkerVersionMetadata;
};

export default {
  async fetch(
    request: Request,
    env: VersionedPlatformEnv,
    context?: PlatformExecutionContext,
  ): Promise<Response> {
    const bridgeChallenge = await controlD1BridgeChallengeResponse(request, env);
    if (bridgeChallenge) return bridgeChallenge;
    const composed = composeTakoserverHostedWorkerEnv(env);
    return withPlatformWorkerVersion(
      await platformWorker.fetch(request, composed, context),
      env.TAKOSUMI_VERSION_METADATA,
    );
  },
  scheduled(
    event: unknown,
    env: VersionedPlatformEnv,
    context?: PlatformExecutionContext,
  ): Promise<void> {
    return platformWorker.scheduled(
      event,
      composeTakoserverHostedWorkerEnv(env),
      context,
    );
  },
};
