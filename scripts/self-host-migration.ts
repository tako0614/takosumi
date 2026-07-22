#!/usr/bin/env bun
/**
 * Encrypted, provider-neutral self-host migration rehearsal.
 *
 * This intentionally uses the same account/session and Workspace/Source/Capsule/
 * Run/Output APIs as the dashboard.  It does not copy retired Installation rows,
 * runner credentials, ProviderConnections, secret variables, or opaque state
 * storage handles.  A target re-syncs the Git Source and creates a reviewed plan
 * before apply, preserving the normal Takosumi authority boundary.
 */
import {
  Decrypter,
  Encrypter,
  generateIdentity,
  identityToRecipient,
} from "age-encryption";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const BUNDLE_KIND = "takosumi.self-host-migration-bundle@v1" as const;
const EXPORT_KIND = "takosumi.self-host-migration-export@v1" as const;
const APPLY_KIND = "takosumi.self-host-migration-apply-result@v1" as const;
const LOGIN_KIND = "takosumi.self-host-migration-login@v1" as const;
const SAMPLE_KIND = "takosumi.self-host-migration-sample@v1" as const;
const REDACTED = "[REDACTED]";
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectJson = { [key: string]: Json };

interface Session {
  readonly subject: string;
  readonly primaryAccountId: string;
  readonly expiresAt: number;
}

interface MigrationBundle {
  readonly kind: typeof BUNDLE_KIND;
  readonly generatedAt: string;
  readonly exportId: string;
  readonly sourceIssuer: string;
  readonly sourceAccountId: string;
  readonly account: { readonly subject: string };
  readonly workspace: ObjectJson;
  readonly source: ObjectJson;
  readonly sourceSnapshot: ObjectJson;
  readonly capsule: ObjectJson;
  readonly installConfig: ObjectJson;
  readonly stateVersion: ObjectJson;
  readonly applyRun: ObjectJson;
  readonly output: ObjectJson | null;
}

interface ExportEvidence {
  readonly kind: typeof EXPORT_KIND;
  readonly generatedAt: string;
  readonly exportId: string;
  readonly sourceIssuer: string;
  readonly sourceAccountId: string;
  readonly archiveDigest: string;
  readonly ageRecipient: string;
}

interface Options {
  readonly [name: string]: string | boolean | undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number`);
  }
  return value;
}

function asJson(value: unknown, label: string): Json {
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    fail(`${label} must be JSON serializable`);
  }
}

function parseOptions(argv: readonly string[]): Options {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) fail(`unexpected argument: ${item}`);
    const name = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return options;
}

function required(options: Options, name: string): string {
  return string(options[name], `--${name}`);
}

function optional(options: Options, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

async function writePrivate(path: string, data: string | Uint8Array) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  await writeFile(absolute, data, { mode: 0o600 });
  await chmod(absolute, 0o600);
}

async function writeJson(path: string, value: unknown) {
  await writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

function issuer(raw: string): string {
  const url = new URL(raw);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

class Api {
  readonly base: string;
  readonly token: string;
  readonly ca?: string;

  constructor(base: string, token: string, ca?: string) {
    this.base = issuer(base);
    this.token = token;
    this.ca = ca;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    const init = {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(this.ca ? { tls: { ca: this.ca } } : {}),
    } as RequestInit;
    const response = await fetch(`${this.base}${path}`, init);
    const text = await response.text();
    let parsed: unknown = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        fail(`${method} ${path} returned non-JSON (${response.status})`);
      }
    }
    if (!response.ok) {
      const error = isObject(parsed) ? parsed.error : undefined;
      const message = isObject(error) ? error.message : undefined;
      fail(
        `${method} ${path} failed (${response.status}): ${String(message ?? text)}`,
      );
    }
    return object(parsed, `${method} ${path} response`);
  }

  get(path: string) {
    return this.request("GET", path);
  }

  post(path: string, body: unknown = {}) {
    return this.request("POST", path, body);
  }

  patch(path: string, body: unknown) {
    return this.request("PATCH", path, body);
  }
}

async function session(api: Api): Promise<Session> {
  const body = await api.get("/v1/account/session/me");
  if (body.session === null) fail("target session is not authenticated");
  return {
    subject: string(body.subject, "session.subject"),
    primaryAccountId: string(
      body.primaryAccountId ?? body.subject,
      "session.primaryAccountId",
    ),
    expiresAt: number(body.expiresAt, "session.expiresAt"),
  };
}

async function waitRun(api: Api, runId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await api.get(`/api/v1/runs/${encodeURIComponent(runId)}`);
    const run = object(body.run, "run");
    const status = string(run.status, "run.status");
    if (TERMINAL.has(status) || status === "waiting_approval") return run;
    await Bun.sleep(500);
  }
  fail(`run ${runId} did not become terminal within ${timeoutMs}ms`);
}

function proofPath(directory: string, name: string) {
  return resolve(directory, `${name}.json`);
}

function safeVariables(config: Record<string, unknown>): ObjectJson {
  const mapping = object(
    config.variableMapping ?? {},
    "installConfig.variableMapping",
  );
  return Object.fromEntries(
    Object.entries(mapping)
      .filter(([, value]) => value !== REDACTED)
      .map(([name, value]) => [name, asJson(value, `variable ${name}`)]),
  );
}

function assertPortableInstallConfig(config: Record<string, unknown>) {
  if (config.installContextVariableMapping !== undefined) {
    fail(
      "installContextVariableMapping is service-local and cannot be replayed portably",
    );
  }
  if (config.backup !== undefined) {
    fail(
      "backup configuration is target-owned and requires an explicit target configuration",
    );
  }
  if (config.managedPublicHostname !== undefined) {
    fail(
      "managedPublicHostname is target-owned and cannot be replayed implicitly",
    );
  }
  const policy = object(config.policy ?? {}, "installConfig.policy");
  const { lifecycleActions: _lifecycleActions, ...unsupportedPolicy } = policy;
  if (Object.keys(unsupportedPolicy).length > 0) {
    fail(
      `InstallConfig policy requires explicit target configuration: ${Object.keys(unsupportedPolicy).sort().join(", ")}`,
    );
  }
}

async function apiFrom(options: Options, prefix = ""): Promise<Api> {
  const label = prefix ? `${prefix}-` : "";
  const base = required(options, `${label}issuer`);
  const tokenFile = required(options, `${label}token-file`);
  const token = (await readFile(resolve(tokenFile), "utf8")).trim();
  if (!token) fail(`${tokenFile} is empty`);
  const caFile = optional(options, `${label}ca-file`);
  const ca = caFile ? await readFile(resolve(caFile), "utf8") : undefined;
  return new Api(base, token, ca);
}

async function exportBundle(options: Options): Promise<ExportEvidence> {
  const api = await apiFrom(options, "source");
  const workspaceId = required(options, "workspace-id");
  const capsuleId = required(options, "capsule-id");
  const recipient = required(options, "age-recipient");
  const archiveFile = required(options, "archive-file");
  const evidenceFile = required(options, "export-evidence-file");
  const who = await session(api);

  const workspaceBody = await api.get(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  const workspace = object(workspaceBody.workspace, "workspace");
  const capsuleBody = await api.get(
    `/api/v1/capsules/${encodeURIComponent(capsuleId)}`,
  );
  const capsule = object(capsuleBody.capsule, "capsule");
  if (string(capsule.workspaceId, "capsule.workspaceId") !== workspaceId) {
    fail("capsule does not belong to --workspace-id");
  }
  const sourceId = string(capsule.sourceId, "capsule.sourceId");
  const sourceBody = await api.get(
    `/api/v1/sources/${encodeURIComponent(sourceId)}`,
  );
  const source = object(sourceBody.source, "source");
  if (source.authConnectionId !== undefined) {
    fail(
      "credentialed Git Sources are not portable; create a target Source Connection and re-register the Source",
    );
  }
  const stateVersionId = string(
    capsule.currentStateVersionId,
    "capsule.currentStateVersionId",
  );
  const stateVersionBody = await api.get(
    `/api/v1/state-versions/${encodeURIComponent(stateVersionId)}`,
  );
  const stateVersion = object(stateVersionBody.stateVersion, "stateVersion");
  const applyRunId = string(
    stateVersion.createdByRunId,
    "stateVersion.createdByRunId",
  );
  const applyRunBody = await api.get(
    `/api/v1/runs/${encodeURIComponent(applyRunId)}`,
  );
  const applyRun = object(applyRunBody.run, "applyRun");
  if (applyRun.status !== "succeeded" || applyRun.type !== "apply") {
    fail("current StateVersion was not created by a succeeded apply Run");
  }
  const sourceSnapshotId = string(
    applyRun.sourceSnapshotId,
    "applyRun.sourceSnapshotId",
  );
  let cursor: string | undefined;
  let sourceSnapshot: Record<string, unknown> | undefined;
  do {
    const snapshotsBody = await api.get(
      `/api/v1/sources/${encodeURIComponent(sourceId)}/snapshots?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    const snapshots = snapshotsBody.snapshots;
    if (!Array.isArray(snapshots)) fail("source snapshots response is invalid");
    const match = snapshots.find(
      (candidate) => isObject(candidate) && candidate.id === sourceSnapshotId,
    );
    if (match) sourceSnapshot = match;
    cursor =
      typeof snapshotsBody.nextCursor === "string"
        ? snapshotsBody.nextCursor
        : undefined;
  } while (!sourceSnapshot && cursor);
  if (!sourceSnapshot) {
    fail("current apply Run SourceSnapshot was not found in the Source ledger");
  }
  string(sourceSnapshot.resolvedCommit, "sourceSnapshot.resolvedCommit");
  const configId = string(capsule.installConfigId, "capsule.installConfigId");
  const configBody = await api.get(
    `/api/v1/capsule-configs/${encodeURIComponent(configId)}`,
  );
  const installConfig = object(configBody.installConfig, "installConfig");
  const outputBody = await api.get(
    `/api/v1/capsules/${encodeURIComponent(capsuleId)}/outputs`,
  );
  const output =
    outputBody.output === null ? null : object(outputBody.output, "output");

  const generatedAt = new Date().toISOString();
  const exportId = optional(options, "export-id") ?? id("export");
  const bundle: MigrationBundle = {
    kind: BUNDLE_KIND,
    generatedAt,
    exportId,
    sourceIssuer: api.base,
    sourceAccountId: who.primaryAccountId,
    account: { subject: who.subject },
    workspace: asJson(workspace, "workspace") as ObjectJson,
    source: asJson(source, "source") as ObjectJson,
    sourceSnapshot: asJson(sourceSnapshot, "sourceSnapshot") as ObjectJson,
    capsule: asJson(capsule, "capsule") as ObjectJson,
    installConfig: asJson(installConfig, "installConfig") as ObjectJson,
    stateVersion: asJson(stateVersion, "stateVersion") as ObjectJson,
    applyRun: asJson(applyRun, "applyRun") as ObjectJson,
    output: output === null ? null : (asJson(output, "output") as ObjectJson),
  };
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const encrypted = await encrypter.encrypt(`${JSON.stringify(bundle)}\n`);
  await writePrivate(archiveFile, encrypted);
  const evidence: ExportEvidence = {
    kind: EXPORT_KIND,
    generatedAt,
    exportId,
    sourceIssuer: api.base,
    sourceAccountId: who.primaryAccountId,
    archiveDigest: await sha256(encrypted),
    ageRecipient: recipient,
  };
  await writeJson(evidenceFile, evidence);
  return evidence;
}

async function readBundle(
  archiveFile: string,
  identityFile: string,
): Promise<{ bundle: MigrationBundle; archiveDigest: string }> {
  const encrypted = new Uint8Array(await readFile(resolve(archiveFile)));
  const decrypter = new Decrypter();
  decrypter.addIdentity((await readFile(resolve(identityFile), "utf8")).trim());
  const plaintext = await decrypter.decrypt(encrypted, "text");
  const raw = object(JSON.parse(plaintext), "migration bundle");
  if (raw.kind !== BUNDLE_KIND)
    fail(`unsupported migration bundle kind: ${String(raw.kind)}`);
  const bundle = raw as unknown as MigrationBundle;
  string(bundle.exportId, "bundle.exportId");
  string(bundle.sourceAccountId, "bundle.sourceAccountId");
  object(bundle.workspace, "bundle.workspace");
  object(bundle.source, "bundle.source");
  object(bundle.sourceSnapshot, "bundle.sourceSnapshot");
  object(bundle.capsule, "bundle.capsule");
  object(bundle.installConfig, "bundle.installConfig");
  object(bundle.stateVersion, "bundle.stateVersion");
  object(bundle.applyRun, "bundle.applyRun");
  return { bundle, archiveDigest: await sha256(encrypted) };
}

function outputProjection(
  output: ObjectJson | null,
  label: string,
): ObjectJson {
  if (!output) fail(`${label} must be non-null after a successful apply`);
  return {
    publicOutputs: asJson(
      object(output.publicOutputs ?? {}, `${label}.publicOutputs`),
      `${label}.publicOutputs`,
    ),
    workspaceOutputs: asJson(
      object(output.workspaceOutputs ?? {}, `${label}.workspaceOutputs`),
      `${label}.workspaceOutputs`,
    ),
  };
}

function stable(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => `${JSON.stringify(name)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function importBundle(options: Options) {
  const api = await apiFrom(options, "target");
  const archiveFile = required(options, "archive-file");
  const identityFile = required(options, "identity-file");
  const proofDirectory = required(options, "proof-directory");
  const { bundle, archiveDigest } = await readBundle(archiveFile, identityFile);
  const expectedDigest = optional(options, "expected-archive-digest");
  if (expectedDigest && expectedDigest !== archiveDigest) {
    fail(
      `archive digest mismatch: expected ${expectedDigest}, got ${archiveDigest}`,
    );
  }
  const who = await session(api);
  const migrationId = optional(options, "migration-id") ?? id("migration");
  const sourceWorkspace = object(bundle.workspace, "bundle.workspace");
  const sourceSource = object(bundle.source, "bundle.source");
  const sourceSnapshot = object(bundle.sourceSnapshot, "bundle.sourceSnapshot");
  const sourceCapsule = object(bundle.capsule, "bundle.capsule");
  const sourceConfig = object(bundle.installConfig, "bundle.installConfig");
  assertPortableInstallConfig(sourceConfig);
  const suffix = optional(options, "name-suffix") ?? "";

  const workspaceBody = await api.post("/api/v1/workspaces", {
    handle: `${string(sourceWorkspace.handle, "workspace.handle")}${suffix}`,
    displayName: `${string(sourceWorkspace.displayName, "workspace.displayName")}${suffix}`,
    type: sourceWorkspace.type ?? "personal",
  });
  const workspace = object(workspaceBody.workspace, "created workspace");
  const workspaceId = string(workspace.id, "created workspace.id");
  const sourceBody = await api.post("/api/v1/sources", {
    workspaceId,
    name: `${string(sourceSource.name, "source.name")}${suffix}`,
    url: string(sourceSource.url, "source.url"),
    defaultRef: string(
      sourceSnapshot.resolvedCommit,
      "sourceSnapshot.resolvedCommit",
    ),
    defaultPath: string(sourceSource.defaultPath, "source.defaultPath"),
    autoSync: sourceSource.autoSync === true,
  });
  const source = object(sourceBody.source, "created source");
  const sourceId = string(source.id, "created source.id");
  const syncBody = await api.post(
    `/api/v1/sources/${encodeURIComponent(sourceId)}/sync`,
    { intent: "manual_plan" },
  );
  const syncRun = object(syncBody.run, "source sync run");
  const terminalSync = await waitRun(
    api,
    string(syncRun.id, "source sync run.id"),
  );
  if (terminalSync.status !== "succeeded") {
    fail(`source sync failed with status ${String(terminalSync.status)}`);
  }

  const capsuleBody = await api.post(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/capsules`,
    {
      name: `${string(sourceCapsule.name, "capsule.name")}${suffix}`,
      environment: string(sourceCapsule.environment, "capsule.environment"),
      sourceId,
      installConfigId:
        optional(options, "target-install-config-id") ??
        "cfg-default-opentofu-capsule",
      runnerProfileId:
        optional(options, "runner-profile-id") ?? "opentofu-default",
      vars: safeVariables(sourceConfig),
      outputAllowlist: sourceConfig.outputAllowlist ?? {},
      ...(sourceConfig.modulePath === undefined
        ? {}
        : { modulePath: sourceConfig.modulePath }),
      ...(sourceConfig.sourceBuild === undefined
        ? {}
        : { sourceBuild: sourceConfig.sourceBuild }),
      ...(sourceConfig.interfaceBlueprints === undefined
        ? {}
        : { interfaceBlueprints: sourceConfig.interfaceBlueprints }),
      ...(sourceConfig.store === undefined
        ? {}
        : { store: sourceConfig.store }),
      autoUpdate: sourceCapsule.autoUpdate === true,
    },
  );
  const capsule = object(capsuleBody.capsule, "created capsule");
  const capsuleId = string(capsule.id, "created capsule.id");
  const targetInstallConfigId = string(
    capsule.installConfigId,
    "created capsule.installConfigId",
  );
  const sourcePolicy = object(
    sourceConfig.policy ?? {},
    "installConfig.policy",
  );
  await api.patch(
    `/api/v1/capsule-configs/${encodeURIComponent(targetInstallConfigId)}`,
    {
      ...(sourceConfig.variablePresentation === undefined
        ? {}
        : { variablePresentation: sourceConfig.variablePresentation }),
      ...(sourceConfig.installExperience === undefined
        ? {}
        : { installExperience: sourceConfig.installExperience }),
      outputAllowlist: sourceConfig.outputAllowlist ?? {},
      ...(sourceConfig.interfaceBlueprints === undefined
        ? {}
        : { interfaceBlueprints: sourceConfig.interfaceBlueprints }),
      ...(sourceConfig.lifecycleActions === undefined
        ? {}
        : { lifecycleActions: sourceConfig.lifecycleActions }),
      ...(sourcePolicy.lifecycleActions === undefined
        ? {}
        : { lifecycleActionPolicy: sourcePolicy.lifecycleActions }),
    },
  );
  const planBody = await api.post(
    `/api/v1/capsules/${encodeURIComponent(capsuleId)}/plan`,
  );
  let planRun = object(planBody.run, "plan run");
  const planRunId = string(planRun.id, "plan run.id");
  if (
    !TERMINAL.has(String(planRun.status)) &&
    planRun.status !== "waiting_approval"
  ) {
    planRun = await waitRun(api, planRunId);
  }
  if (planRun.status === "waiting_approval") {
    await api.post(`/api/v1/runs/${encodeURIComponent(planRunId)}/approve`, {
      reason: "self-host migration rehearsal",
    });
    planRun = await waitRun(api, planRunId);
  }
  if (planRun.status !== "succeeded") {
    fail(`plan failed with status ${String(planRun.status)}`);
  }
  const applyBody = await api.post(
    `/api/v1/runs/${encodeURIComponent(planRunId)}/apply`,
  );
  let applyRun = object(applyBody.run, "apply run");
  const applyRunId = string(applyRun.id, "apply run.id");
  if (!TERMINAL.has(String(applyRun.status))) {
    applyRun = await waitRun(api, applyRunId);
  }
  if (applyRun.status !== "succeeded") {
    fail(`apply failed with status ${String(applyRun.status)}`);
  }
  await api.patch(`/api/v1/sources/${encodeURIComponent(sourceId)}`, {
    defaultRef: string(sourceSource.defaultRef, "source.defaultRef"),
  });

  const verifiedWorkspace = object(
    (await api.get(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`))
      .workspace,
    "verified workspace",
  );
  const verifiedCapsule = object(
    (await api.get(`/api/v1/capsules/${encodeURIComponent(capsuleId)}`))
      .capsule,
    "verified capsule",
  );
  if (verifiedCapsule.status !== "active") {
    fail(`target Capsule is not active: ${String(verifiedCapsule.status)}`);
  }
  string(
    verifiedCapsule.currentStateVersionId,
    "verified capsule.currentStateVersionId",
  );
  const targetOutputBody = await api.get(
    `/api/v1/capsules/${encodeURIComponent(capsuleId)}/outputs`,
  );
  const targetOutput =
    targetOutputBody.output === null
      ? null
      : (asJson(
          object(targetOutputBody.output, "target output"),
          "target output",
        ) as ObjectJson);
  const sourceProjection = outputProjection(bundle.output, "source output");
  const targetProjection = outputProjection(targetOutput, "target output");
  if (stable(sourceProjection) !== stable(targetProjection)) {
    fail("Output projection mismatch between source and target");
  }
  const sourceKeys = Object.keys(
    object(sourceProjection.workspaceOutputs, "source workspace outputs"),
  ).sort();
  const targetKeys = Object.keys(
    object(targetProjection.workspaceOutputs, "target workspace outputs"),
  ).sort();

  const generatedAt = new Date().toISOString();
  const common = {
    generatedAt,
    migrationId,
    exportId: bundle.exportId,
    targetIssuer: api.base,
    targetHost: new URL(api.base).host,
  };
  const applyEvidence = {
    kind: APPLY_KIND,
    ...common,
    target: {
      accountId: who.primaryAccountId,
      workspaceId,
      sourceId,
      capsuleId,
    },
    planRunId,
    applyRunId,
    status: "succeeded",
  };
  const loginEvidence = {
    kind: LOGIN_KIND,
    ...common,
    targetAccountId: who.primaryAccountId,
    subject: who.subject,
    expiresAt: new Date(who.expiresAt).toISOString(),
    status: "passed",
  };
  const sampleEvidence = {
    kind: SAMPLE_KIND,
    ...common,
    targetAccountId: who.primaryAccountId,
    workspaceId: string(verifiedWorkspace.id, "verified workspace.id"),
    capsuleId: string(verifiedCapsule.id, "verified capsule.id"),
    verificationRunId: applyRunId,
    planRunId,
    applyRunId,
    dataClasses: ["account", "workspace", "capsule", "run", "output"],
    sourceOutputKeys: sourceKeys,
    targetOutputKeys: targetKeys,
    status: "passed",
  };
  await Promise.all([
    writeJson(proofPath(proofDirectory, "migration-apply"), applyEvidence),
    writeJson(proofPath(proofDirectory, "post-migration-login"), loginEvidence),
    writeJson(
      proofPath(proofDirectory, "sample-data-verification"),
      sampleEvidence,
    ),
  ]);
  return { applyEvidence, loginEvidence, sampleEvidence };
}

async function keygen(options: Options) {
  const identityFile = required(options, "identity-file");
  const recipientFile = required(options, "recipient-file");
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  await writePrivate(identityFile, `${identity}\n`);
  await writePrivate(recipientFile, `${recipient}\n`);
  return { recipient };
}

async function sealFile(options: Options) {
  const sourceFile = required(options, "source-file");
  const archiveFile = required(options, "archive-file");
  const recipient = required(options, "age-recipient");
  const plaintext = new Uint8Array(await readFile(resolve(sourceFile)));
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const encrypted = await encrypter.encrypt(plaintext);
  await writePrivate(archiveFile, encrypted);
  return {
    archiveDigest: await sha256(encrypted),
    sourceDigest: await sha256(plaintext),
    ageRecipient: recipient,
  };
}

/** Creates a provider-free synthetic Capsule for a destructive scratch drill. */
async function seedFixture(options: Options) {
  const api = await apiFrom(options);
  const who = await session(api);
  const suffix = optional(options, "name-suffix") ?? Date.now().toString(36);
  const workspaceBody = await api.post("/api/v1/workspaces", {
    handle: `migration-${suffix}`.slice(0, 39),
    displayName: `Migration rehearsal ${suffix}`,
    type: "personal",
  });
  const workspaceId = string(
    object(workspaceBody.workspace, "created workspace").id,
    "created workspace.id",
  );
  const sourceBody = await api.post("/api/v1/sources", {
    workspaceId,
    name: "provider-free-fixture",
    url: required(options, "git-url"),
    defaultRef: required(options, "git-ref"),
    defaultPath:
      optional(options, "module-path") ?? "opentofu-modules/core/module",
    autoSync: false,
  });
  const sourceId = string(
    object(sourceBody.source, "created source").id,
    "created source.id",
  );
  const syncBody = await api.post(
    `/api/v1/sources/${encodeURIComponent(sourceId)}/sync`,
    { intent: "manual_plan" },
  );
  const syncRun = object(syncBody.run, "source sync run");
  const terminalSync = await waitRun(
    api,
    string(syncRun.id, "source sync run.id"),
  );
  if (terminalSync.status !== "succeeded") {
    fail(
      `fixture source sync failed with status ${String(terminalSync.status)}`,
    );
  }
  const baseDomain =
    optional(options, "base-domain") ?? "migration-fixture.example.test";
  const capsuleBody = await api.post(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/capsules`,
    {
      name: "provider-free-fixture",
      environment: "preview",
      sourceId,
      installConfigId: "cfg-default-opentofu-capsule",
      runnerProfileId:
        optional(options, "runner-profile-id") ?? "opentofu-default",
      vars: { base_domain: baseDomain },
      outputAllowlist: {
        base_domain: {
          from: "base_domain",
          type: "hostname",
          required: true,
        },
        public_origin: {
          from: "public_origin",
          type: "url",
          required: true,
        },
      },
    },
  );
  const capsuleId = string(
    object(capsuleBody.capsule, "created capsule").id,
    "created capsule.id",
  );
  const planBody = await api.post(
    `/api/v1/capsules/${encodeURIComponent(capsuleId)}/plan`,
  );
  let planRun = object(planBody.run, "plan run");
  const planRunId = string(planRun.id, "plan run.id");
  if (
    !TERMINAL.has(String(planRun.status)) &&
    planRun.status !== "waiting_approval"
  ) {
    planRun = await waitRun(api, planRunId);
  }
  if (planRun.status === "waiting_approval") {
    await api.post(`/api/v1/runs/${encodeURIComponent(planRunId)}/approve`, {
      reason: "synthetic self-host migration fixture",
    });
    planRun = await waitRun(api, planRunId);
  }
  if (planRun.status !== "succeeded") {
    fail(`fixture plan failed with status ${String(planRun.status)}`);
  }
  const applyBody = await api.post(
    `/api/v1/runs/${encodeURIComponent(planRunId)}/apply`,
  );
  let applyRun = object(applyBody.run, "apply run");
  const applyRunId = string(applyRun.id, "apply run.id");
  if (!TERMINAL.has(String(applyRun.status))) {
    applyRun = await waitRun(api, applyRunId);
  }
  if (applyRun.status !== "succeeded") {
    fail(`fixture apply failed with status ${String(applyRun.status)}`);
  }
  const outputBody = await api.get(
    `/api/v1/capsules/${encodeURIComponent(capsuleId)}/outputs`,
  );
  const projection = outputProjection(
    outputBody.output === null
      ? null
      : (asJson(
          object(outputBody.output, "fixture output"),
          "fixture output",
        ) as ObjectJson),
    "fixture output",
  );
  const result = {
    kind: "takosumi.self-host-migration-fixture@v1",
    generatedAt: new Date().toISOString(),
    issuer: api.base,
    accountId: who.primaryAccountId,
    workspaceId,
    sourceId,
    capsuleId,
    planRunId,
    applyRunId,
    output: projection,
  };
  const outFile = optional(options, "out-file");
  if (outFile) await writeJson(outFile, result);
  return result;
}

function response(value: unknown, status = 200) {
  return Response.json(value, { status });
}

async function selfTest() {
  const directory = await mkdtemp(resolve(tmpdir(), "takosumi-migration-"));
  const sourceOutput = {
    id: "out_source",
    workspaceId: "ws_source",
    capsuleId: "cap_source",
    stateGeneration: 1,
    publicOutputs: { endpoint: "https://source.example.test" },
    workspaceOutputs: {
      endpoint: "https://source.example.test",
      revision: "one",
    },
    outputDigest: "sha256:source",
    createdAt: new Date().toISOString(),
  };
  const targetOutput = {
    ...sourceOutput,
    id: "out_target",
    workspaceId: "ws_target",
    capsuleId: "cap_target",
    publicOutputs: { endpoint: "https://source.example.test" },
    workspaceOutputs: {
      endpoint: "https://source.example.test",
      revision: "one",
    },
    outputDigest: "sha256:target",
  };
  let targetOutputValue: ObjectJson = targetOutput;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const token = request.headers
        .get("authorization")
        ?.replace("Bearer ", "");
      const target = token === "target-token";
      const path = url.pathname;
      if (path === "/v1/account/session/me") {
        return response({
          subject: target ? "acct_target" : "acct_source",
          primaryAccountId: target ? "acct_target" : "acct_source",
          expiresAt: Date.now() + 60_000,
        });
      }
      if (!target) {
        if (path === "/api/v1/workspaces/ws_source") {
          return response({
            workspace: {
              id: "ws_source",
              handle: "migrate-source",
              displayName: "Migration source",
              type: "personal",
              ownerUserId: "acct_source",
            },
          });
        }
        if (path === "/api/v1/capsules/cap_source") {
          return response({
            capsule: {
              id: "cap_source",
              workspaceId: "ws_source",
              name: "fixture",
              environment: "preview",
              sourceId: "src_source",
              installConfigId: "cfg_source",
              currentStateVersionId: "sv_source",
              status: "active",
            },
          });
        }
        if (path === "/api/v1/sources/src_source") {
          return response({
            source: {
              id: "src_source",
              workspaceId: "ws_source",
              name: "fixture-source",
              url: "https://example.test/fixture.git",
              defaultRef: "main",
              defaultPath: ".",
              autoSync: false,
            },
          });
        }
        if (path === "/api/v1/sources/src_source/snapshots") {
          return response({
            snapshots: [
              {
                id: "snap_source",
                sourceId: "src_source",
                resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
              },
            ],
          });
        }
        if (path === "/api/v1/state-versions/sv_source") {
          return response({
            stateVersion: {
              id: "sv_source",
              createdByRunId: "run_source_apply",
            },
          });
        }
        if (path === "/api/v1/runs/run_source_apply") {
          return response({
            run: {
              id: "run_source_apply",
              type: "apply",
              status: "succeeded",
              sourceSnapshotId: "snap_source",
            },
          });
        }
        if (path === "/api/v1/capsule-configs/cfg_source") {
          return response({
            installConfig: {
              id: "cfg_source",
              variableMapping: {
                base_domain: "fixture.example.test",
                token: REDACTED,
              },
              outputAllowlist: { endpoint: { from: "endpoint", type: "url" } },
              policy: {},
            },
          });
        }
        if (path === "/api/v1/capsules/cap_source/outputs") {
          return response({ output: sourceOutput });
        }
      }
      if (target) {
        if (request.method === "POST" && path === "/api/v1/workspaces") {
          return response(
            {
              workspace: {
                id: "ws_target",
                handle: "migrate-source-target",
                displayName: "Migration source-target",
                type: "personal",
                ownerUserId: "acct_target",
              },
            },
            201,
          );
        }
        if (request.method === "POST" && path === "/api/v1/sources") {
          return response({ source: { id: "src_target" } }, 201);
        }
        if (
          request.method === "POST" &&
          path === "/api/v1/sources/src_target/sync"
        ) {
          return response(
            { run: { id: "run_sync", status: "succeeded" } },
            201,
          );
        }
        if (
          request.method === "PATCH" &&
          path === "/api/v1/sources/src_target"
        ) {
          return response({ source: { id: "src_target", defaultRef: "main" } });
        }
        if (
          request.method === "POST" &&
          path === "/api/v1/workspaces/ws_target/capsules"
        ) {
          const body = object(await request.json(), "capsule request");
          const vars = object(body.vars, "capsule vars");
          if (vars.token !== undefined)
            return response({ error: { message: "secret replayed" } }, 400);
          return response(
            { capsule: { id: "cap_target", installConfigId: "cfg_target" } },
            201,
          );
        }
        if (
          request.method === "PATCH" &&
          path === "/api/v1/capsule-configs/cfg_target"
        ) {
          return response({ installConfig: { id: "cfg_target" } });
        }
        if (
          request.method === "POST" &&
          path === "/api/v1/capsules/cap_target/plan"
        ) {
          return response(
            { run: { id: "run_plan", status: "succeeded" } },
            201,
          );
        }
        if (
          request.method === "POST" &&
          path === "/api/v1/runs/run_plan/apply"
        ) {
          return response(
            { run: { id: "run_apply", status: "succeeded" } },
            201,
          );
        }
        if (path === "/api/v1/runs/run_sync") {
          return response({ run: { id: "run_sync", status: "succeeded" } });
        }
        if (path === "/api/v1/runs/run_plan") {
          return response({ run: { id: "run_plan", status: "succeeded" } });
        }
        if (path === "/api/v1/runs/run_apply") {
          return response({ run: { id: "run_apply", status: "succeeded" } });
        }
        if (path === "/api/v1/workspaces/ws_target") {
          return response({ workspace: { id: "ws_target" } });
        }
        if (path === "/api/v1/capsules/cap_target") {
          return response({
            capsule: {
              id: "cap_target",
              status: "active",
              currentStateVersionId: "sv_target",
            },
          });
        }
        if (path === "/api/v1/capsules/cap_target/outputs") {
          return response({ output: targetOutputValue });
        }
      }
      return response(
        { error: { message: `not found: ${request.method} ${path}` } },
        404,
      );
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const identityFile = resolve(directory, "identity.txt");
    const recipientFile = resolve(directory, "recipient.txt");
    const sourceTokenFile = resolve(directory, "source-token.txt");
    const targetTokenFile = resolve(directory, "target-token.txt");
    const archiveFile = resolve(directory, "migration.age");
    const exportEvidenceFile = resolve(directory, "export.json");
    const proofDirectory = resolve(directory, "proofs");
    await Promise.all([
      writePrivate(sourceTokenFile, "source-token\n"),
      writePrivate(targetTokenFile, "target-token\n"),
    ]);
    const generated = await keygen({
      "identity-file": identityFile,
      "recipient-file": recipientFile,
    });
    const exported = await exportBundle({
      "source-issuer": base,
      "source-token-file": sourceTokenFile,
      "workspace-id": "ws_source",
      "capsule-id": "cap_source",
      "age-recipient": generated.recipient,
      "archive-file": archiveFile,
      "export-evidence-file": exportEvidenceFile,
      "export-id": "export_self_test",
    });
    const imported = await importBundle({
      "target-issuer": base,
      "target-token-file": targetTokenFile,
      "archive-file": archiveFile,
      "identity-file": identityFile,
      "expected-archive-digest": exported.archiveDigest,
      "proof-directory": proofDirectory,
      "migration-id": "migration_self_test",
      "name-suffix": "-target",
    });
    if (imported.sampleEvidence.status !== "passed")
      fail("sample proof did not pass");
    targetOutputValue = {
      ...targetOutput,
      workspaceOutputs: { endpoint: "https://target.example.test" },
    };
    let mismatchFailed = false;
    try {
      await importBundle({
        "target-issuer": base,
        "target-token-file": targetTokenFile,
        "archive-file": archiveFile,
        "identity-file": identityFile,
        "expected-archive-digest": exported.archiveDigest,
        "proof-directory": resolve(directory, "bad-proofs"),
        "migration-id": "migration_mismatch",
        "name-suffix": "-mismatch",
      });
    } catch (error) {
      mismatchFailed =
        error instanceof Error &&
        error.message.includes("Output projection mismatch");
    }
    if (!mismatchFailed)
      fail("self-test expected mismatched output keys to fail closed");
    return { status: "passed", exportId: exported.exportId };
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

function usage(): never {
  fail(`usage:
  bun scripts/self-host-migration.ts keygen --identity-file FILE --recipient-file FILE
  bun scripts/self-host-migration.ts seal-file --source-file FILE --age-recipient AGE1... --archive-file FILE
  bun scripts/self-host-migration.ts seed-fixture --issuer URL --token-file FILE --git-url URL --git-ref COMMIT [--ca-file FILE --out-file FILE]
  bun scripts/self-host-migration.ts export --source-issuer URL --source-token-file FILE --workspace-id ID --capsule-id ID --age-recipient AGE1... --archive-file FILE --export-evidence-file FILE [--source-ca-file FILE] [--export-id ID]
  bun scripts/self-host-migration.ts import --target-issuer URL --target-token-file FILE --archive-file FILE --identity-file FILE --proof-directory DIR [--target-ca-file FILE] [--expected-archive-digest SHA256] [--migration-id ID]
  bun scripts/self-host-migration.ts self-test`);
}

export { exportBundle, importBundle, keygen, sealFile, seedFixture, selfTest };

if (import.meta.main) {
  try {
    const [command, ...argv] = Bun.argv.slice(2);
    const options = parseOptions(argv);
    const result =
      command === "keygen"
        ? await keygen(options)
        : command === "seal-file"
          ? await sealFile(options)
          : command === "seed-fixture"
            ? await seedFixture(options)
            : command === "export"
              ? await exportBundle(options)
              : command === "import"
                ? await importBundle(options)
                : command === "self-test"
                  ? await selfTest()
                  : usage();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `self-host migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
