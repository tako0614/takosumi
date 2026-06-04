import type {
  ApplyExpectedGuard,
  OpenTofuModuleSource,
  PlanRun,
} from "takosumi-contract/deploy-control-api";
import {
  APPLY_RUNS_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_PATH,
  PLAN_RUNS_PATH,
} from "takosumi-contract/deploy-control-api";
import { loadConfig, resolveMode } from "./config.ts";
import { readNestedRecord, readNestedString } from "./json.ts";
import { callTakosumiService } from "./remote_client.ts";

export interface RemoteDeployControlTarget {
  readonly url: string;
  readonly token?: string;
}

export interface ExpectedPlanOptions {
  readonly expectedPlanDigest?: string;
  readonly expectedPlanArtifactDigest?: string;
  readonly expectedSourceCommit?: string;
  readonly expectedProviderLockDigest?: string;
}

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function parseSourceRef(ref: string): OpenTofuModuleSource {
  if (ref.startsWith("git:")) {
    const rest = ref.slice("git:".length);
    const hash = rest.lastIndexOf("#");
    if (hash > 0 && hash < rest.length - 1) {
      return {
        kind: "git",
        url: rest.slice(0, hash),
        ref: rest.slice(hash + 1),
      };
    }
    return { kind: "git", url: rest };
  }
  if (ref.startsWith("catalog:") || ref.startsWith("bundle:")) {
    throw new Error(
      "catalog: and bundle: are retired; Takosumi deploys plain OpenTofu module sources",
    );
  }
  if (ref.startsWith("prepared:")) {
    const rest = ref.slice("prepared:".length);
    const hash = rest.lastIndexOf("#");
    if (hash > 0 && hash < rest.length - 1) {
      const digest = rest.slice(hash + 1);
      if (!SHA256_DIGEST_RE.test(digest)) {
        throw new Error(
          "prepared source digest must be sha256:<64 lowercase hex>",
        );
      }
      return {
        kind: "prepared",
        url: rest.slice(0, hash),
        digest,
      };
    }
    throw new Error("prepared source requires prepared:<url>#sha256:<hex>");
  }
  return { kind: "local", path: ref };
}

export function expectedGuardFromOptions(
  options: ExpectedPlanOptions,
): Partial<ApplyExpectedGuard> | undefined {
  const planDigest = options.expectedPlanDigest;
  const planArtifactDigest = options.expectedPlanArtifactDigest;
  const sourceCommit = options.expectedSourceCommit;
  const providerLockDigest = options.expectedProviderLockDigest;
  if (
    planDigest === undefined &&
    planArtifactDigest === undefined &&
    sourceCommit === undefined &&
    providerLockDigest === undefined
  ) {
    return undefined;
  }
  return {
    ...(planDigest ? { planDigest } : {}),
    ...(planArtifactDigest ? { planArtifactDigest } : {}),
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(providerLockDigest ? { providerLockDigest } : {}),
  };
}

export function expectedGuardFromPlanRun(
  planRun: PlanRun | Record<string, unknown>,
  options: ExpectedPlanOptions = {},
): ApplyExpectedGuard {
  const planRunId = requiredPlanRunString(planRun, "id");
  const runnerProfileId = requiredPlanRunString(planRun, "runnerProfileId");
  const sourceDigest = requiredPlanRunString(planRun, "sourceDigest");
  const variablesDigest = requiredPlanRunString(planRun, "variablesDigest");
  const policyDecisionDigest = requiredPlanRunString(
    planRun,
    "policyDecisionDigest",
  );
  const planDigest = options.expectedPlanDigest ??
    requiredPlanRunString(planRun, "planDigest");
  const planArtifactDigest = options.expectedPlanArtifactDigest ??
    requiredPlanArtifactDigest(planRun);
  const sourceCommit = options.expectedSourceCommit ??
    optionalPlanRunString(planRun, "sourceCommit");
  const providerLockDigest = options.expectedProviderLockDigest ??
    optionalPlanRunString(planRun, "providerLockDigest");
  return {
    planRunId,
    runnerProfileId,
    sourceDigest,
    variablesDigest,
    policyDecisionDigest,
    planDigest,
    planArtifactDigest,
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(providerLockDigest ? { providerLockDigest } : {}),
  };
}

export function resolveSourceArg(input: {
  readonly argument?: string;
  readonly flag?: string;
}): string {
  if (input.argument && input.flag && input.argument !== input.flag) {
    throw new Error(
      "pass the source either as an argument or with --source, not both",
    );
  }
  const source = input.flag ?? input.argument;
  if (!source) {
    throw new Error("source is required; pass <source> or --source <source>");
  }
  return source;
}

export async function requireRemoteDeployControl(
  remote?: string,
  token?: string,
): Promise<RemoteDeployControlTarget> {
  const target = resolveMode(
    { remote, token },
    await loadConfig(),
  );
  if (target.mode !== "remote") {
    throw new Error(
      "deploy control commands require a remote Takosumi service: pass --remote or set TAKOSUMI_REMOTE_URL",
    );
  }
  return { url: target.url, token: target.token };
}

export async function callDeployControl(
  target: RemoteDeployControlTarget,
  input: {
    readonly path: string;
    readonly method?: string;
    readonly body: unknown;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  return await callTakosumiService({
    url: target.url,
    token: target.token,
    path: input.path,
    ...(input.method ? { method: input.method } : {}),
    body: input.body,
  });
}

export async function readInstallationSource(
  target: RemoteDeployControlTarget,
  installationId: string,
): Promise<OpenTofuModuleSource> {
  const body = await readInstallationBody(target, installationId);
  const source = readNestedRecord(body, ["installation", "source"]);
  if (!source) {
    throw new Error(`installation ${installationId} does not expose source`);
  }
  if (typeof source.kind !== "string") {
    throw new Error(`installation ${installationId} source.kind is missing`);
  }
  return source as unknown as OpenTofuModuleSource;
}

export async function readInstallationSpace(
  target: RemoteDeployControlTarget,
  installationId: string,
): Promise<string> {
  const body = await readInstallationBody(target, installationId);
  const spaceId = readNestedString(body, ["installation", "spaceId"]);
  if (!spaceId) {
    throw new Error(`installation ${installationId} does not expose spaceId`);
  }
  return spaceId;
}

export {
  APPLY_RUNS_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_PATH,
  PLAN_RUNS_PATH,
};

function requiredPlanRunString(
  value: PlanRun | Record<string, unknown>,
  key: string,
): string {
  const found = optionalPlanRunString(value, key);
  if (!found) {
    throw new Error(`PlanRun is missing ${key}; cannot build apply guard`);
  }
  return found;
}

function optionalPlanRunString(
  value: PlanRun | Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function requiredPlanArtifactDigest(
  value: PlanRun | Record<string, unknown>,
): string {
  const artifact = (value as Record<string, unknown>).planArtifact;
  if (typeof artifact === "object" && artifact !== null && !Array.isArray(artifact)) {
    const digest = (artifact as Record<string, unknown>).digest;
    if (typeof digest === "string" && digest.length > 0) return digest;
  }
  throw new Error("PlanRun is missing planArtifact.digest; cannot build apply guard");
}

async function readInstallationBody(
  target: RemoteDeployControlTarget,
  installationId: string,
): Promise<unknown> {
  const { status, body } = await callDeployControl(target, {
    path: INSTALLATION_PATH(installationId),
    method: "GET",
    body: undefined,
  });
  if (status >= 400) {
    throw new Error(`Takosumi service returned ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function normalizeProviders(
  values: readonly string[] | undefined,
): readonly string[] {
  return Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  );
}
