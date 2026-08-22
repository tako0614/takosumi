import { WorkerEntrypoint } from "cloudflare:workers";

import platformWorker, {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
  materializePlatformCapsuleRuntimeBindings,
  rollbackPlatformCapsuleRuntimeBindings,
  type PlatformHostRuntimeBindingMaterializationInput,
  type PlatformHostRuntimeBindingMaterializationResult,
  type PlatformHostRuntimeMaterializerEnv,
  type PlatformExecutionContext,
} from "./worker.ts";
import {
  type PlatformWorkerVersionMetadata,
  withPlatformWorkerVersion,
} from "./version_metadata_response.ts";
import { composeTakoserverHostedWorkerEnv } from "./takoserver_hosted_worker.ts";

export {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
};

/**
 * Private RPC entrypoint used by a selected host while publishing one exact
 * Capsule runtime. It is intentionally absent from the public Takosumi HTTP
 * router; a Cloudflare Service Binding is the capability to call it.
 */
export class TakosumiHostRuntimeMaterializerEntrypoint extends WorkerEntrypoint<PlatformHostRuntimeMaterializerEnv> {
  materializeRuntimeBindings(
    input: PlatformHostRuntimeBindingMaterializationInput,
  ): Promise<PlatformHostRuntimeBindingMaterializationResult> {
    return materializePlatformCapsuleRuntimeBindings(this.env, input);
  }

  rollbackRuntimeBindings(input: {
    readonly request: PlatformHostRuntimeBindingMaterializationInput["request"];
    readonly rollbackReceipt: string;
  }): Promise<void> {
    return rollbackPlatformCapsuleRuntimeBindings(this.env, input);
  }
}

type VersionedPlatformEnv = PlatformHostRuntimeMaterializerEnv & {
  readonly TAKOSUMI_VERSION_METADATA?: PlatformWorkerVersionMetadata;
};

export default {
  async fetch(
    request: Request,
    env: VersionedPlatformEnv,
    context?: PlatformExecutionContext,
  ): Promise<Response> {
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
