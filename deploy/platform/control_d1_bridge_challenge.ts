import type { D1Database } from "../../worker/src/bindings.ts";
import { readD1OpenTofuBridgeCompatibility } from "../../worker/src/d1_opentofu_store.ts";

export const CONTROL_D1_BRIDGE_CHALLENGE_PATH =
  "/__takosumi/control-d1-schema-compatibility" as const;

const CHALLENGE_NONCE = /^[0-9a-f]{64}$/u;
const WORKER_VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ControlD1BridgeChallengeEnv {
  readonly TAKOSUMI_CONTROL_DB: D1Database;
  readonly TAKOSUMI_CONTROL_D1_SCHEMA_MODE?: unknown;
  readonly TAKOSUMI_ENVIRONMENT?: unknown;
  readonly TAKOSUMI_VERSION_METADATA?: { readonly id?: unknown };
}

/**
 * Return one cache-free, nonce-bound read of the physical D1 ledger from the
 * immutable bridge Version. This route is deliberately unavailable in normal
 * strict predeployed mode; it exists only for the bounded v66/v67 transition.
 */
export async function controlD1BridgeChallengeResponse(
  request: Request,
  env: ControlD1BridgeChallengeEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== CONTROL_D1_BRIDGE_CHALLENGE_PATH) return undefined;
  if (request.method !== "GET") {
    return challengeResponse(
      { status: "not-ready", reason: "method_not_allowed" },
      405,
      { allow: "GET" },
    );
  }
  const queryKeys = [...url.searchParams.keys()];
  const nonce = url.searchParams.get("nonce");
  if (
    queryKeys.length !== 1 ||
    queryKeys[0] !== "nonce" ||
    nonce === null ||
    !CHALLENGE_NONCE.test(nonce)
  ) {
    return challengeResponse(
      { status: "not-ready", reason: "challenge_invalid" },
      400,
    );
  }
  const environment = env.TAKOSUMI_ENVIRONMENT;
  const workerVersionId = env.TAKOSUMI_VERSION_METADATA?.id;
  if (
    env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE !== "predeployed-bridge" ||
    (environment !== "staging" && environment !== "production") ||
    typeof workerVersionId !== "string" ||
    !WORKER_VERSION_ID.test(workerVersionId)
  ) {
    return challengeResponse(
      { status: "not-ready", reason: "bridge_authority_unavailable" },
      503,
    );
  }
  try {
    const compatibility = await readD1OpenTofuBridgeCompatibility(
      env.TAKOSUMI_CONTROL_DB,
    );
    return challengeResponse(
      {
        kind: "takosumi.control-d1-schema-compatibility-challenge@v1",
        status: "ready",
        nonce,
        environment,
        workerVersionId,
        bindingName: "TAKOSUMI_CONTROL_DB",
        schemaMode: "predeployed-bridge",
        ...compatibility,
      },
      200,
      { "x-takosumi-version-id": workerVersionId },
    );
  } catch {
    return challengeResponse(
      { status: "not-ready", reason: "ledger_not_accepted" },
      503,
    );
  }
}

function challengeResponse(
  value: unknown,
  status: number,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
      ...extraHeaders,
    },
  });
}
