import { isRunCredentialToken, type RunCredentialTokenPayload } from "./run_credential_tokens.ts";

export type RunnerMutationAction = "apply" | "destroy";

export interface VerifiedMutationCredential {
  readonly payload: RunCredentialTokenPayload;
  /** Digest of the trusted signer, not the signer secret. */
  readonly signingAuthorityDigest: string;
}

export interface RenewableMutationProjection {
  readonly manifestDigest: string;
  readonly descriptors: readonly { readonly sourceEnvName: string }[];
}

export interface RunnerMutationSemanticPorts {
  /** Must cryptographically verify the token, including expiry, on every call. */
  readonly verifyCredentialToken?: (token: string) => Promise<VerifiedMutationCredential>;
  /** Only the DO's separately validated renewable claim may populate this. */
  readonly renewableProjection?: RenewableMutationProjection;
  /** Legacy DO compatibility only; future callers must fail closed. */
  readonly allowMalformedRunCredentialAsOpaque?: boolean;
}

export interface RunnerMutationIdentity {
  readonly semanticDigest: string;
  /** Private per-delivery evidence; never persist or expose alongside Run records. */
  readonly privateMaterialDigest: string;
}

const MUTABLE_RUN_EVIDENCE_FIELDS = new Set([
  "auditEvents", "createdAt", "diagnostics", "finishedAt", "heartbeatAt",
  "startedAt", "status", "updatedAt",
]);

/** Pure projection plus trusted verification port; returns digests, never values or claims. */
export async function runnerMutationIdentity(
  runId: string,
  action: RunnerMutationAction,
  requestPayload: unknown,
  ports: RunnerMutationSemanticPorts = {},
): Promise<RunnerMutationIdentity> {
  if (!isRecord(requestPayload)) throw new Error("runner mutation request must be an object");
  const request: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(requestPayload)) {
    if (key === "credentials") continue;
    request[key] = key === "applyRun" || key === "planRun"
      ? stableMutationRunEvidence(value, key)
      : value;
  }
  request.credentials = await credentialSemantics(requestPayload.credentials, requestPayload, action, ports);
  const semanticDigest = await digestText(canonicalRunnerMutationJson({
    kind: "takosumi.runner-mutation-semantics@v2", runId, action, request,
  }));
  // Deliberately retain exact delivery material here: unlike semantic identity,
  // a new signed issuance or refreshed Run evidence is a distinct attempt.
  // This digest is private only.
  const privateMaterialDigest = await digestText(canonicalRunnerMutationJson({
    kind: "takosumi.runner-mutation-material@v1", runId, action, request: requestPayload,
  }));
  return { semanticDigest, privateMaterialDigest };
}

function stableMutationRunEvidence(value: unknown, label: string): unknown {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const stable: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (MUTABLE_RUN_EVIDENCE_FIELDS.has(key)) continue;
    if (key === "stateLock" && isRecord(entry)) {
      stable.stateLock = {
        ...(stringField(entry, "backendRef") ? { backendRef: stringField(entry, "backendRef")! } : {}),
        ...(stringField(entry, "lockRef") ? { lockRef: stringField(entry, "lockRef")! } : {}),
      };
      continue;
    }
    stable[key] = entry;
  }
  return stable;
}

async function credentialSemantics(
  value: unknown,
  requestPayload: Readonly<Record<string, unknown>>,
  action: RunnerMutationAction,
  ports: RunnerMutationSemanticPorts,
): Promise<unknown> {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error("runner mutation credentials must be an object");
  const rawEnv = recordField(value, "env") ?? {};
  const envNames = Object.keys(rawEnv).sort();
  if (Object.values(rawEnv).some((entry) => typeof entry !== "string")) {
    throw new Error("runner mutation credential env must contain strings");
  }
  const rawFiles = value.files;
  if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
    throw new Error("runner mutation credential files must be an array");
  }
  const files = (Array.isArray(rawFiles) ? rawFiles : []).map((entry) => {
    if (!isRecord(entry)) throw new Error("runner mutation credential file must be an object");
    const path = stringField(entry, "path");
    const content = stringField(entry, "content");
    const mode = entry.mode;
    if (!path || content === undefined || typeof mode !== "number") {
      throw new Error("runner mutation credential file requires path, mode, and content");
    }
    return { path, mode, ...(stringField(entry, "envName") ? { envName: stringField(entry, "envName")! } : {}) };
  });
  const runtimeInputs = runtimeInputSemantics(value.runtimeInputs);
  const manifest = recordField(value, "manifest");
  const renewableBindings = isRecord(manifest) && Array.isArray(manifest.bindings)
    ? manifest.bindings.filter((binding) => isRecord(binding) && recordField(binding, "renewableEnv") !== undefined)
    : [];
  const renewableClaim = ports.renewableProjection;
  if (renewableBindings.length > 0 &&
    (!renewableClaim || renewableClaim.descriptors.length !== renewableBindings.length)) {
    throw new Error("renewable credential projection is incomplete");
  }
  const renewableSourceNames = new Set(renewableClaim?.descriptors.map((descriptor) => descriptor.sourceEnvName) ?? []);
  const secretEntries = [
    ...Object.entries(rawEnv).map(([name, entry]) => ({ delivery: `env:${name}`, value: entry as string })),
    ...(Array.isArray(rawFiles) ? rawFiles.flatMap((entry) =>
      isRecord(entry) && typeof entry.path === "string" && typeof entry.content === "string"
        ? [{ delivery: `file:${entry.path}`, value: entry.content }]
        : []) : []),
    ...runtimeInputs.secretEntries,
  ];
  const signedTokenDeliveries = new Map<string, Set<string>>();
  for (const entry of secretEntries) {
    if (entry.value.startsWith("takrct_") && !isRunCredentialToken(entry.value) &&
      !ports.allowMalformedRunCredentialAsOpaque) {
      throw new Error("malformed Run credential token");
    }
    if (!isRunCredentialToken(entry.value)) continue;
    const deliveries = signedTokenDeliveries.get(entry.value) ?? new Set<string>();
    deliveries.add(entry.delivery);
    signedTokenDeliveries.set(entry.value, deliveries);
  }
  const staticMaterialDigests = await Promise.all(secretEntries
    .filter((entry) => !isRunCredentialToken(entry.value) &&
      !(entry.delivery.startsWith("env:") && renewableSourceNames.has(entry.delivery.slice(4))))
    .map(async (entry) => ({ delivery: entry.delivery, digest: await digestText(entry.value) })));
  const authorities = await verifiedAuthorities(signedTokenDeliveries, requestPayload, action, value, ports);
  return {
    envNames,
    files: files.sort((left, right) => canonicalRunnerMutationJson(left).localeCompare(canonicalRunnerMutationJson(right))),
    manifest: value.manifest ?? null,
    ...(renewableClaim ? { renewableCredentials: {
      kind: "takosumi.runner-renewable-credential-projection@v1",
      manifestDigest: renewableClaim.manifestDigest,
      expiryClass: "finite-expiry",
      descriptors: [...renewableClaim.descriptors].sort((left, right) =>
        canonicalRunnerMutationJson(left).localeCompare(canonicalRunnerMutationJson(right))),
    } } : {}),
    authorities,
    ...(runtimeInputs.semantics.length > 0 ? { runtimeInputs: runtimeInputs.semantics } : {}),
    staticMaterialDigests: staticMaterialDigests.sort((left, right) => left.delivery.localeCompare(right.delivery)),
  };
}

function runtimeInputSemantics(value: unknown): {
  readonly semantics: readonly { readonly variableName: string; readonly names: readonly string[] }[];
  readonly secretEntries: readonly { readonly delivery: string; readonly value: string }[];
} {
  if (value === undefined) return { semantics: [], secretEntries: [] };
  if (!Array.isArray(value)) throw new Error("runner mutation credential runtimeInputs must be an array");
  const semantics: { readonly variableName: string; readonly names: readonly string[] }[] = [];
  const secretEntries: { readonly delivery: string; readonly value: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error("runner mutation credential runtimeInputs entry must be an object");
    const variableName = stringField(entry, "variableName");
    const names = entry.names;
    const values = entry.values;
    if (!variableName || !Array.isArray(names) || names.some((name) => typeof name !== "string") ||
      !isRecord(values) || Object.values(values).some((item) => typeof item !== "string")) {
      throw new Error("runner mutation credential runtimeInputs entry is malformed");
    }
    semantics.push({ variableName, names: [...(names as string[])].sort() });
    for (const [name, item] of Object.entries(values)) {
      secretEntries.push({ delivery: `runtime-input:${variableName}:${name}`, value: item as string });
    }
  }
  return {
    semantics: semantics.sort((left, right) => left.variableName.localeCompare(right.variableName)),
    secretEntries,
  };
}

async function verifiedAuthorities(
  tokenDeliveries: ReadonlyMap<string, ReadonlySet<string>>,
  requestPayload: Readonly<Record<string, unknown>>,
  action: RunnerMutationAction,
  credentials: Readonly<Record<string, unknown>>,
  ports: RunnerMutationSemanticPorts,
): Promise<readonly unknown[]> {
  if (tokenDeliveries.size === 0) return [];
  if (!ports.verifyCredentialToken) throw new Error("Run credential verification authority is unavailable");
  const context = mutationCredentialExpectedContext(requestPayload, action);
  const bindings = mutationCredentialManifestBindings(credentials);
  const authorities = [];
  for (const [token, deliveries] of tokenDeliveries) {
    const { payload, signingAuthorityDigest } = await ports.verifyCredentialToken(token);
    assertMutationCredentialAuthority(payload, context, bindings);
    authorities.push({
      kind: "takosumi.run-credential-authority@v1",
      tokenType: payload.typ,
      tokenVersion: payload.v,
      signingAuthorityDigest,
      audience: payload.aud,
      subject: payload.sub,
      workspaceId: payload.workspaceId,
      capsuleId: payload.capsuleId,
      runId: payload.runId,
      installingPrincipalId: payload.installingPrincipalId,
      connectionId: payload.connectionId,
      provider: payload.provider,
      phase: action,
      scopes: [...payload.scopes].sort(),
      deliveries: [...deliveries].sort(),
    });
  }
  return authorities.sort((left, right) => canonicalRunnerMutationJson(left).localeCompare(canonicalRunnerMutationJson(right)));
}

function mutationCredentialExpectedContext(requestPayload: Readonly<Record<string, unknown>>, action: RunnerMutationAction) {
  const applyRun = recordField(requestPayload, "applyRun");
  const planRun = recordField(requestPayload, "planRun");
  const workspaceId = applyRun && stringField(applyRun, "workspaceId");
  const capsuleId = (applyRun && stringField(applyRun, "capsuleId")) ?? (planRun && stringField(planRun, "capsuleId"));
  const runId = applyRun && stringField(applyRun, "id");
  if (!workspaceId || !capsuleId || !runId) {
    throw new Error("signed Run credentials require exact ApplyRun Workspace and Capsule context");
  }
  if (planRun && ((stringField(planRun, "workspaceId") !== undefined &&
    stringField(planRun, "workspaceId") !== workspaceId) ||
    (stringField(planRun, "capsuleId") !== undefined && stringField(planRun, "capsuleId") !== capsuleId))) {
    throw new Error("signed Run credential context mismatches the PlanRun");
  }
  return { workspaceId, capsuleId, runId, action };
}

function mutationCredentialManifestBindings(credentials: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] {
  const manifest = recordField(credentials, "manifest");
  const bindings = manifest?.bindings;
  if (!Array.isArray(bindings)) throw new Error("signed Run credentials require a credential manifest");
  return bindings.map((binding) => {
    if (!isRecord(binding)) throw new Error("credential manifest binding must be an object");
    return binding;
  });
}

function assertMutationCredentialAuthority(
  payload: RunCredentialTokenPayload,
  context: ReturnType<typeof mutationCredentialExpectedContext>,
  bindings: readonly Readonly<Record<string, unknown>>[],
): void {
  if (payload.workspaceId !== context.workspaceId || payload.capsuleId !== context.capsuleId ||
    payload.runId !== context.runId || payload.phase !== context.action || payload.sub !== payload.installingPrincipalId) {
    throw new Error("signed Run credential authority mismatches the mutation");
  }
  if (!bindings.some((binding) => stringField(binding, "connectionId") === payload.connectionId &&
    stringField(binding, "providerSource") === payload.provider)) {
    throw new Error("signed Run credential authority mismatches the credential manifest");
  }
}

function canonicalRunnerMutationJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalRunnerMutationJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalRunnerMutationJson(value[key])}`).join(",")}}`;
  throw new Error("runner mutation identity must be canonical JSON");
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function digestText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
