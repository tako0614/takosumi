import { expect, test } from "bun:test";
import { authStagingOwnerTargetBindingDigest, assertAuthStagingOwnerGraphQualification, createAuthStagingOwnerGraphReader, parseAuthStagingOwnerGraphExpectation } from "../../scripts/auth-staging-owner-graph.ts";
import { AUTH_STAGING_ISSUER, AUTH_STAGING_CLIENTS } from "../../deploy/accounts-cloudflare/src/staging-target.ts";

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(12)}`;
function expectation() {
  return parseAuthStagingOwnerGraphExpectation({ kind: "takosumi.auth-owner-graph-expectation@v1", ownerClientId: "fixture-private-hosted-owner",
    issuer: { worker: "fixture-issuer", versionId: id("1"), sourceCommit: "a".repeat(40), sourceCommitBinding: "SOURCE", accountsDatabaseId: id("4"), controlDatabaseId: id("5") },
    owner: { worker: "fixture-owner", versionId: id("2"), sourceCommit: "b".repeat(40), sourceCommitBinding: "SOURCE", binding: "PRIVATE_ACCOUNTS",
      custodyResources: [{ binding: "CUSTODY_DB", type: "d1", resourceId: id("6") }] } });
}
function fixture(options: { third?: boolean; preview?: boolean; mutate?: (worker: string, version: Record<string, any>) => void; drift?: boolean; readError?: boolean } = {}) {
  const expected = expectation();
  const paths: string[] = [];
  const versions: Record<string, Record<string, any>> = {};
  const text = (name: string, value: string) => ({ name, type: "plain_text", text: value });
  for (const [worker, versionId, source] of [[expected.issuer.worker, id("1"), expected.issuer.sourceCommit], [expected.owner.worker, id("2"), expected.owner.sourceCommit], ...(options.third ? [["fixture-third", id("3"), "c".repeat(40)]] : [])]) {
    const issuer = worker === expected.issuer.worker;
    const bindings: Record<string, unknown>[] = [text("TAKOSUMI_ENVIRONMENT", "staging"), text("SOURCE", source!)];
    if (issuer) bindings.push(text("TAKOSUMI_ACCOUNTS_ISSUER", AUTH_STAGING_ISSUER), text("TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE", "predeployed"), text("TAKOSUMI_CONTROL_D1_SCHEMA_MODE", "predeployed"),
      text("TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID", expected.ownerClientId), text("TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST", authStagingOwnerTargetBindingDigest(expected)),
      { name: "TAKOSUMI_ACCOUNTS_DB", type: "d1", id: id("4") }, { name: "TAKOSUMI_CONTROL_DB", type: "d1", id: id("5") });
    else bindings.push({ name: "PRIVATE_ACCOUNTS", type: "service", service: expected.issuer.worker, entrypoint: "AccountsOwnerAdmission" },
      { name: "CUSTODY_DB", type: "d1", id: id("6") });
    versions[worker!] = { id: versionId, resources: { bindings, script: { named_handlers: issuer ? [{ name: "AccountsOwnerAdmission", handlers: ["readOwnerOperation"] }] : [] },
      script_runtime: { exports: issuer ? { AccountsOwnerAdmission: { type: "worker" } } : {} } } };
    options.mutate?.(worker!, versions[worker!]!);
  }
  let lists = 0;
  const provider = { async request(method: "GET", path: string) {
    expect(method).toBe("GET"); paths.push(path);
    if (options.readError) throw new Error("fixture-provider-unavailable");
    if (path === "/workers/scripts") { lists++; return Object.keys(versions).map((worker) => ({ id: worker })); }
    const match = /^\/workers\/scripts\/([^/]+)\/(.+)$/u.exec(path);
    if (!match || !versions[match[1]!]) throw new Error("unexpected fixture read");
    const worker = match[1]!, tail = match[2]!, version = versions[worker]!;
    if (tail === "deployments") return { deployments: [{ versions: [{ version_id: version.id, percentage: 100 }] }] };
    if (tail === "subdomain") return { enabled: false, previews_enabled: options.preview && worker === expected.owner.worker || false };
    if (tail.startsWith("versions?")) {
      const page = Number(new URL("https://fixture/" + tail).searchParams.get("page"));
      return { items: page === 1 ? [{ id: version.id, metadata: { hasPreview: false } }] : page === 2 && options.preview && worker === expected.owner.worker ? [{ id: id("7"), metadata: { hasPreview: true } }] : [] };
    }
    if (tail === `versions/${id("7")}`) return { ...structuredClone(version), id: id("7") };
    if (tail === `versions/${version.id}`) {
      const copy = structuredClone(version);
      if (options.drift && lists > 1 && worker === expected.owner.worker) copy.resources.bindings.push(text("DRIFT", "changed"));
      return copy;
    }
    throw new Error("unexpected fixture path " + path);
  } };
  return { expected, paths, reader: createAuthStagingOwnerGraphReader(provider) };
}

test("closed provider reader exhausts every version page twice and brands only actual stable census", async () => {
  const f = fixture();
  const result = await f.reader.qualify(f.expected);
  expect(result.targetBindingDigest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
  expect(result.graphDigest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
  expect(result.workerCount).toBe(2); expect(result.callableVersionCount).toBe(2);
  expect(f.paths.filter((path) => path.endsWith("page=2&per_page=50"))).toHaveLength(4);
  expect(() => assertAuthStagingOwnerGraphQualification(result, f.expected)).not.toThrow();
  expect(() => assertAuthStagingOwnerGraphQualification(structuredClone(result), f.expected)).toThrow();
  expect(() => assertAuthStagingOwnerGraphQualification({ ...result, ready: true } as typeof result, f.expected)).toThrow();
});

test("stable target excludes observed version/source bookkeeping but includes every owner custody resource", () => {
  const value = expectation(), first = authStagingOwnerTargetBindingDigest(value);
  expect(authStagingOwnerTargetBindingDigest({ ...value, owner: { ...value.owner, sourceCommit: "d".repeat(40), versionId: id("8") }, issuer: { ...value.issuer, versionId: id("9") } })).toBe(first);
  expect(authStagingOwnerTargetBindingDigest({ ...value, owner: { ...value.owner, custodyResources: [{ binding: "CUSTODY_DB", type: "d1", resourceId: id("8") }] } })).not.toBe(first);
  expect(() => parseAuthStagingOwnerGraphExpectation({ ...value, complete: true })).toThrow();
  expect(() => parseAuthStagingOwnerGraphExpectation({ ...value, ownerClientId: AUTH_STAGING_CLIENTS[0].clientId })).toThrow();
  expect(() => parseAuthStagingOwnerGraphExpectation({ ...value, owner: { ...value.owner, custodyResources: [] } })).toThrow();
});

test("any additional serving or preview source edge and changing provider census refuse qualification", async () => {
  for (const options of [{ third: true }, { preview: true }, { drift: true }, { readError: true }]) {
    const f = fixture(options); await expect(f.reader.qualify(f.expected)).rejects.toThrow("readError" in options ? "fixture-provider-unavailable" : "auth_staging_owner_graph_unqualified");
  }
});

test("actual source, version, stateful resource, entrypoint and configuration mismatches refuse without descriptor shortcuts", async () => {
  const changes = [
    (w: string, v: any) => { if (w === "fixture-issuer") v.resources.bindings.find((b: any) => b.name === "SOURCE").text = "f".repeat(40); },
    (w: string, v: any) => { if (w === "fixture-owner") v.resources.bindings.find((b: any) => b.name === "TAKOSUMI_ENVIRONMENT").text = "production"; },
    (w: string, v: any) => { if (w === "fixture-issuer") v.resources.script.named_handlers[0].handlers = ["fetch"]; },
    (w: string, v: any) => { if (w === "fixture-owner") v.resources.bindings[2].entrypoint = "Default"; },
    (w: string, v: any) => { if (w === "fixture-owner") v.resources.bindings[2].props = { owner: "hosted-intents" }; },
    (w: string, v: any) => { if (w === "fixture-owner") v.resources.bindings.push({ name: "OTHER_DB", type: "d1", id: id("8") }); },
    (w: string, v: any) => { if (w === "fixture-owner") v.resources.bindings.push({ name: "UNKNOWN_STORE", type: "kv_namespace", namespace_id: "unknown" }); },
    (w: string, v: any) => { if (w === "fixture-owner") v.resources.bindings.push({ name: "UNKNOWN_OWNER", type: "service", service: "other-custody-worker" }); },
    (w: string, v: any) => { if (w === "fixture-issuer") { const b = v.resources.bindings.find((b: any) => b.name === "TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST"); b.text = b.text.slice(0, -1) + (b.text.endsWith("A") ? "B" : "A"); } },
  ];
  for (const mutate of changes) { const f = fixture({ mutate }); await expect(f.reader.qualify(f.expected)).rejects.toThrow("unqualified"); }
  const f = fixture();
  await expect(f.reader.qualify({ ...f.expected, issuer: { ...f.expected.issuer, versionId: id("9") } })).rejects.toThrow();
});
