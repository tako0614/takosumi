import { createHash } from "node:crypto";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_ISSUER } from "../deploy/accounts-cloudflare/src/staging-target.ts";
import { OWNER_OPERATION_ENTRYPOINT } from "../accounts/service/src/owner-operation-contract.ts";

type NodePin = Readonly<{ worker: string; versionId: string; sourceCommit: string; sourceCommitBinding: string }>;
type CustodyResource = Readonly<{ binding: string; type: "d1" | "durable_object_namespace" | "r2_bucket"; resourceId: string }>;
export interface AuthStagingOwnerGraphExpectation {
  readonly kind: "takosumi.auth-owner-graph-expectation@v1";
  readonly ownerClientId: string;
  readonly issuer: NodePin & { readonly accountsDatabaseId: string; readonly controlDatabaseId: string };
  readonly owner: NodePin & { readonly binding: string; readonly custodyResources: readonly CustodyResource[] };
}
export interface AuthStagingOwnerGraphProvider {
  request(method: "GET", path: string): Promise<unknown>;
}
export interface AuthStagingOwnerGraphQualification {
  readonly scope: "topology-and-metadata";
  readonly targetBindingDigest: string;
  readonly graphDigest: string;
  readonly observedAt: number;
  readonly workerCount: number;
  readonly callableVersionCount: number;
}
const qualifications = new WeakMap<AuthStagingOwnerGraphQualification, string>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
function fail(): never { throw new Error("auth_staging_owner_graph_unqualified"); }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;

/** This is a private expectation parser, never a readiness/proof parser. */
export function parseAuthStagingOwnerGraphExpectation(value: unknown): AuthStagingOwnerGraphExpectation {
  if (!record(value) || Object.keys(value).sort().join(",") !== "issuer,kind,owner,ownerClientId" ||
    value.kind !== "takosumi.auth-owner-graph-expectation@v1" || typeof value.ownerClientId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.ownerClientId) || AUTH_STAGING_CLIENTS.some((client) => client.clientId === value.ownerClientId)) fail();
  const node = (input: unknown, extra: readonly string[]) => {
    if (!record(input) || Object.keys(input).sort().join(",") !== ["worker", "versionId", "sourceCommit", "sourceCommitBinding", ...extra].sort().join(",") ||
      typeof input.worker !== "string" || !identifier.test(input.worker) || typeof input.versionId !== "string" || !uuid.test(input.versionId) ||
      typeof input.sourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(input.sourceCommit) ||
      typeof input.sourceCommitBinding !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(input.sourceCommitBinding)) fail();
    return input;
  };
  const issuer = node(value.issuer, ["accountsDatabaseId", "controlDatabaseId"]);
  const owner = node(value.owner, ["binding", "custodyResources"]);
  if (typeof issuer.accountsDatabaseId !== "string" || !uuid.test(issuer.accountsDatabaseId) ||
    typeof issuer.controlDatabaseId !== "string" || !uuid.test(issuer.controlDatabaseId) || issuer.accountsDatabaseId === issuer.controlDatabaseId ||
    typeof owner.binding !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(owner.binding) || owner.worker === issuer.worker ||
    !Array.isArray(owner.custodyResources) || owner.custodyResources.length === 0 || owner.custodyResources.length > 32) fail();
  const custodyResources = owner.custodyResources.map((resource: unknown): CustodyResource => {
    if (!record(resource) || Object.keys(resource).sort().join(",") !== "binding,resourceId,type" ||
      typeof resource.binding !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(resource.binding) ||
      !["d1", "durable_object_namespace", "r2_bucket"].includes(String(resource.type)) || typeof resource.resourceId !== "string" ||
      (resource.type === "d1" ? !uuid.test(resource.resourceId) : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resource.resourceId))) fail();
    return Object.freeze({ binding: resource.binding, type: resource.type as CustodyResource["type"], resourceId: resource.resourceId });
  }).sort((a, b) => a.binding.localeCompare(b.binding));
  if (new Set(custodyResources.map((resource) => resource.binding)).size !== custodyResources.length) fail();
  return Object.freeze({ kind: value.kind, ownerClientId: value.ownerClientId,
    issuer: Object.freeze({ worker: String(issuer.worker), versionId: String(issuer.versionId), sourceCommit: String(issuer.sourceCommit),
      sourceCommitBinding: String(issuer.sourceCommitBinding), accountsDatabaseId: issuer.accountsDatabaseId, controlDatabaseId: issuer.controlDatabaseId }),
    owner: Object.freeze({ worker: String(owner.worker), versionId: String(owner.versionId), sourceCommit: String(owner.sourceCommit),
      sourceCommitBinding: String(owner.sourceCommitBinding), binding: owner.binding, custodyResources: Object.freeze(custodyResources) }) });
}

type CallableVersion = { worker: string; versionId: string; serving: boolean; preview: boolean; bindings: readonly Record<string, unknown>[]; named: unknown; exports: unknown };
type Census = { workers: readonly string[]; versions: readonly CallableVersion[]; versionInventory: readonly unknown[] };

/** Stable operation target. Observed versions, source commits and the digest
 * binding itself belong to graph qualification, not this immutable identity. */
export function authStagingOwnerTargetBindingDigest(input: unknown): string {
  const expected = parseAuthStagingOwnerGraphExpectation(input);
  return digest({ protocol: "takosumi.auth-owner-target@v1", ownerKind: "hosted-intents", ownerClientId: expected.ownerClientId,
    issuer: { worker: expected.issuer.worker, accountsDatabaseId: expected.issuer.accountsDatabaseId, controlDatabaseId: expected.issuer.controlDatabaseId },
    owner: { worker: expected.owner.worker, binding: expected.owner.binding, entrypoint: OWNER_OPERATION_ENTRYPOINT, custodyResources: expected.owner.custodyResources } });
}

/** Captures only the provider read capability. Callers cannot submit a census,
 * complete/ready flag, serialized proof, caller props or replacement transport. */
export function createAuthStagingOwnerGraphReader(provider: AuthStagingOwnerGraphProvider) {
  const request = provider.request.bind(provider);
  const get = (path: string) => request("GET", path);
  async function census(): Promise<Census> {
    // Worker script-list is a full, unfiltered account array. Versions use
    // page/per_page; deployable=true ignores pagination and is never requested.
    const listed = await get("/workers/scripts");
    if (!Array.isArray(listed) || listed.length === 0 || listed.length > 1000) fail();
    const workers = listed.map((item) => {
      if (!record(item) || typeof item.id !== "string" || !identifier.test(item.id)) fail();
      return item.id;
    }).sort();
    if (new Set(workers).size !== workers.length) fail();
    const versions: CallableVersion[] = [], versionInventory: unknown[] = [];
    for (const worker of workers) {
      const prefix = `/workers/scripts/${encodeURIComponent(worker)}`;
      const deployments = await get(`${prefix}/deployments`), subdomain = await get(`${prefix}/subdomain`);
      if (!record(deployments) || !Array.isArray(deployments.deployments) || !record(subdomain) ||
        typeof subdomain.enabled !== "boolean" || typeof subdomain.previews_enabled !== "boolean") fail();
      const current = deployments.deployments[0];
      if (!record(current) || !Array.isArray(current.versions) || current.versions.length === 0) fail();
      const active = new Set<string>(); let percentage = 0;
      for (const version of current.versions) {
        if (!record(version) || typeof version.version_id !== "string" || !uuid.test(version.version_id) ||
          typeof version.percentage !== "number" || version.percentage <= 0 || version.percentage > 100 || active.has(version.version_id)) fail();
        active.add(version.version_id); percentage += version.percentage;
      }
      if (percentage !== 100) fail();
      const seen = new Set<string>(), inventory: { id: string; preview: boolean }[] = [];
      let exhausted = false;
      for (let page = 1; page <= 1000; page++) {
        const response = await get(`${prefix}/versions?page=${page}&per_page=50`);
        if (!record(response) || !Array.isArray(response.items) || response.items.length > 50) fail();
        if (response.items.length === 0) { exhausted = true; break; }
        for (const item of response.items) {
          if (!record(item) || typeof item.id !== "string" || !uuid.test(item.id) || seen.has(item.id) ||
            !record(item.metadata) || (subdomain.previews_enabled && typeof item.metadata.hasPreview !== "boolean")) fail();
          seen.add(item.id);
          inventory.push({ id: item.id, preview: subdomain.previews_enabled && item.metadata.hasPreview === true });
        }
      }
      if (!exhausted || [...active].some((id) => !seen.has(id))) fail();
      inventory.sort((a, b) => a.id.localeCompare(b.id));
      versionInventory.push({ worker, active: [...active].sort(), previewsEnabled: subdomain.previews_enabled, inventory });
      for (const item of inventory.filter((version) => active.has(version.id) || version.preview)) {
        const version = await get(`${prefix}/versions/${item.id}`);
        if (!record(version) || version.id !== item.id || !record(version.resources) || !record(version.resources.bindings) ||
          !Array.isArray(version.resources.bindings.bindings) || !record(version.resources.script) || !record(version.resources.script_runtime)) fail();
        const bindings = version.resources.bindings.bindings;
        if (!bindings.every((binding) => record(binding) && typeof binding.name === "string" && typeof binding.type === "string") ||
          new Set(bindings.map((binding) => binding.name)).size !== bindings.length) fail();
        // Secret text is never retained in the graph or its public summary.
        versions.push({ worker, versionId: item.id, serving: active.has(item.id), preview: item.preview,
          bindings: bindings.map((binding) => binding.type === "secret_text" ? { name: binding.name, type: binding.type } : binding),
          named: version.resources.script.named_handlers, exports: version.resources.script_runtime.exports });
      }
    }
    return { workers, versions, versionInventory };
  }
  return Object.freeze({ async qualify(input: unknown): Promise<AuthStagingOwnerGraphQualification> {
    const expected = parseAuthStagingOwnerGraphExpectation(input);
    const first = await census(), second = await census();
    if (digest(first) !== digest(second)) fail();
    const exact = (pin: NodePin) => {
      const serving = second.versions.filter((version) => version.worker === pin.worker && version.serving);
      if (serving.length !== 1 || serving[0]!.versionId !== pin.versionId || serving[0]!.preview) fail();
      const version = serving[0]!;
      const text = (name: string) => version.bindings.find((binding) => binding.name === name && binding.type === "plain_text")?.text;
      if (text("TAKOSUMI_ENVIRONMENT") !== "staging" || text(pin.sourceCommitBinding) !== pin.sourceCommit) fail();
      return { version, text };
    };
    const issuer = exact(expected.issuer), owner = exact(expected.owner);
    const stateful = ["d1", "durable_object_namespace", "r2_bucket"];
    if (owner.version.bindings.some((binding) => ![...stateful, "service", "plain_text", "secret_text", "version_metadata"].includes(String(binding.type)))) fail();
    // An undeclared outbound service may own additional custody. No generic
    // non-custody assertion is accepted for a service capability here.
    if (owner.version.bindings.filter((binding) => binding.type === "service").some((binding) =>
      binding.name !== expected.owner.binding || binding.service !== expected.issuer.worker || binding.entrypoint !== OWNER_OPERATION_ENTRYPOINT)) fail();
    const actualCustody = owner.version.bindings.filter((binding) => stateful.includes(String(binding.type))).map((binding) => ({
      binding: binding.name, type: binding.type,
      resourceId: binding.type === "d1" ? binding.id : binding.type === "durable_object_namespace" ? binding.namespace_id : binding.bucket_name,
    })).sort((a, b) => String(a.binding).localeCompare(String(b.binding)));
    if (JSON.stringify(actualCustody) !== JSON.stringify(expected.owner.custodyResources)) fail();
    const targetBindingDigest = authStagingOwnerTargetBindingDigest(expected);
    if (issuer.text("TAKOSUMI_ACCOUNTS_ISSUER") !== AUTH_STAGING_ISSUER ||
      issuer.text("TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE") !== "predeployed" || issuer.text("TAKOSUMI_CONTROL_D1_SCHEMA_MODE") !== "predeployed" ||
      issuer.text("TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID") !== expected.ownerClientId ||
      issuer.text("TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST") !== targetBindingDigest) fail();
    for (const [name, id] of [["TAKOSUMI_ACCOUNTS_DB", expected.issuer.accountsDatabaseId], ["TAKOSUMI_CONTROL_DB", expected.issuer.controlDatabaseId]]) {
      if (!issuer.version.bindings.some((binding) => binding.name === name && binding.type === "d1" && binding.id === id)) fail();
    }
    if (!Array.isArray(issuer.version.named) || issuer.version.named.filter((entry) => record(entry) && entry.name === OWNER_OPERATION_ENTRYPOINT &&
      (entry.handlers === undefined || Array.isArray(entry.handlers) && entry.handlers.length === 0)).length !== 1 ||
      !record(issuer.version.exports) || !record(issuer.version.exports[OWNER_OPERATION_ENTRYPOINT]) ||
      issuer.version.exports[OWNER_OPERATION_ENTRYPOINT].type !== "worker") fail();
    const incoming = second.versions.flatMap((version) => version.bindings.filter((binding) => binding.type === "service" &&
      binding.service === expected.issuer.worker && binding.entrypoint === OWNER_OPERATION_ENTRYPOINT).map((binding) => ({ version, binding })));
    if (incoming.length !== 1) fail();
    const edge = incoming[0]!;
    if (edge.version !== owner.version || edge.binding.name !== expected.owner.binding || edge.binding.props !== undefined ||
      edge.binding.environment !== undefined && edge.binding.environment !== "production") fail();
    const result = Object.freeze({ scope: "topology-and-metadata" as const, targetBindingDigest, graphDigest: digest({ protocol: "takosumi.auth-owner-binding@v1", expected, census: second }),
      observedAt: Date.now(), workerCount: second.workers.length, callableVersionCount: second.versions.length });
    qualifications.set(result, digest(expected));
    return result;
  } });
}

/** Only process-local topology/metadata evidence from the closed provider
 * reader. Source text bindings do not prove reviewed source/build/upload
 * custody. This cannot replace owning release custody, schema or owner proofs
 * and is never consumed as a readiness authority by the runtime bundle. */
export function assertAuthStagingOwnerGraphQualification(value: AuthStagingOwnerGraphQualification, expected: unknown): void {
  if (qualifications.get(value) !== digest(parseAuthStagingOwnerGraphExpectation(expected)) ||
    Date.now() - value.observedAt > 60_000 || value.observedAt > Date.now()) fail();
}
