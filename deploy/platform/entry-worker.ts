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

export {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
};

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
