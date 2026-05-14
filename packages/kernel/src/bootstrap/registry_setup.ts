import { registerProvider, registerShape } from "takosumi-contract";
import { TAKOSUMI_BUNDLED_SHAPES } from "@takos/takosumi-plugins/shapes";
import { createTakosumiProductionProviders } from "@takos/takosumi-plugins/shape-providers/factories";
import { registerBundledArtifactKinds } from "@takos/takosumi-plugins/shape-providers";
import { detectRuntimeAgent } from "./agent_detection.ts";
import { log } from "../shared/log.ts";

let bundledShapesRegistered = false;

/**
 * Idempotently registers all bundled shapes and runtime-agent-backed providers
 * into the global contract registry. Called once per
 * `createPaaSApp` invocation; safe to call repeatedly.
 *
 * Provider registration only fires when `TAKOSUMI_AGENT_URL` and
 * `TAKOSUMI_AGENT_TOKEN` are set — otherwise the kernel boots without
 * providers (apply requests will fail with `provider not registered` until
 * an agent is configured).
 */
export function registerBundledShapesAndProviders(
  runtimeEnv: Record<string, string | undefined> = Deno.env.toObject(),
): void {
  if (!bundledShapesRegistered) {
    for (const shape of TAKOSUMI_BUNDLED_SHAPES) registerShape(shape);
    registerBundledArtifactKinds();
    bundledShapesRegistered = true;
  }
  const agent = detectRuntimeAgent(runtimeEnv);
  if (!agent) {
    log.warn("kernel.boot.providers_not_registered", {
      reason: "agent_unconfigured",
      hint:
        "TAKOSUMI_AGENT_URL / TAKOSUMI_AGENT_TOKEN not set; apply requests " +
        "will return provider_not_registered until an agent is configured.",
    });
    return;
  }
  const artifactStore = detectArtifactStore(runtimeEnv);
  const enableDenoDeploy = parseBoolean(
    runtimeEnv.TAKOSUMI_ENABLE_DENO_DEPLOY_PROVIDER ??
      runtimeEnv.TAKOSUMI_ENABLE_DENO_DEPLOY,
    false,
  );
  const providers = createTakosumiProductionProviders({
    agentUrl: agent.agentUrl,
    token: agent.token,
    ...(artifactStore ? { artifactStore } : {}),
    ...(enableDenoDeploy ? { enableDenoDeploy } : {}),
  });
  for (const provider of providers) {
    registerProvider(provider, { allowOverride: true });
  }
  log.info("kernel.boot.providers_registered", {
    count: providers.length,
    agentUrl: agent.agentUrl,
    ...(artifactStore
      ? { artifactStoreBaseUrl: artifactStore.baseUrl }
      : { artifactStoreBaseUrl: null }),
  });
}

/**
 * Resolves the URL the runtime-agent's connectors should use to fetch
 * uploaded artifacts (e.g. JS bundles for cloudflare-workers). The kernel
 * exposes `POST/GET /v1/artifacts` itself, so the agent simply needs the
 * kernel's externally-reachable base URL plus a token that the artifact
 * routes will accept on GET / HEAD.
 *
 * Token preference: when `TAKOSUMI_ARTIFACT_FETCH_TOKEN` is set we hand
 * the agent the read-only fetch token instead of the deploy token. The
 * artifact routes accept either on read paths but only the deploy token
 * on POST / DELETE / GC, so a compromised agent host gets read-only
 * artifact access rather than full upload / delete / GC power.
 *
 * Returns `undefined` when either the public URL or both tokens are
 * missing — connectors that don't need uploaded artifacts (the OCI-image
 * set) keep working; connectors that do (cloudflare-workers, future
 * lambda-zip / static-bundle) will fail their apply with a clear error
 * that surfaces back to the operator.
 */
function detectArtifactStore(
  runtimeEnv: Record<string, string | undefined>,
):
  | { readonly baseUrl: string; readonly token: string }
  | undefined {
  const publicBaseUrl = runtimeEnv.TAKOSUMI_PUBLIC_BASE_URL;
  const deployToken = runtimeEnv.TAKOSUMI_DEPLOY_TOKEN;
  const fetchToken = runtimeEnv.TAKOSUMI_ARTIFACT_FETCH_TOKEN;
  // The artifact-store locator must point at a token the routes accept
  // on GET. Both the deploy token and the read-only fetch token work; we
  // prefer the read-only one so the agent host never holds upload /
  // delete / GC power.
  const token = fetchToken ?? deployToken;
  if (!publicBaseUrl || !token) return undefined;
  const trimmed = publicBaseUrl.endsWith("/")
    ? publicBaseUrl.slice(0, -1)
    : publicBaseUrl;
  return {
    baseUrl: `${trimmed}/v1/artifacts`,
    token,
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return fallback;
}
