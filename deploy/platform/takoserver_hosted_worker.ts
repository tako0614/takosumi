import platformWorker, {
  type CloudflareWorkerEnv,
  type PlatformExecutionContext,
} from "./worker.ts";
import { TAKOSERVER_HOSTED_INSTALL_CONFIGS } from "./takoserver_hosted_install_configs.ts";

export {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
} from "./worker.ts";

const composed = new WeakMap<object, CloudflareWorkerEnv>();

function hostedEnv(env: CloudflareWorkerEnv): CloudflareWorkerEnv {
  const existing = composed.get(env);
  if (existing) return existing;
  const value = Object.create(env) as CloudflareWorkerEnv;
  Object.defineProperty(value, "TAKOSUMI_INSTALL_CONFIG_COMPOSITION", {
    configurable: false,
    enumerable: true,
    value: TAKOSERVER_HOSTED_INSTALL_CONFIGS,
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
    return await platformWorker.fetch(request, hostedEnv(env), context);
  },
  async scheduled(
    event: unknown,
    env: CloudflareWorkerEnv,
    context?: PlatformExecutionContext,
  ): Promise<void> {
    await platformWorker.scheduled(event, hostedEnv(env), context);
  },
};
