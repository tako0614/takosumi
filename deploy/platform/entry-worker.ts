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
  type RuntimeBindingMaterializerCloudflareEnv,
} from "./runtime_binding_materializer.ts";

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
  materializeRuntimeBindings(input: {
    readonly request: unknown;
    readonly resourceName: string;
    readonly scriptName: string;
    readonly publicOrigin: string;
    readonly bindings: readonly string[];
  }) {
    return createCloudflareTakosumiRuntimeBindingMaterializer(
      this.env,
    ).materializeRuntimeBindings(input);
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

type VersionedPlatformEnv = CloudflareWorkerEnv & {
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
