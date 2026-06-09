import { expect, test } from "bun:test";

import {
  driftCheckEnabled,
  evaluateProductionHardeningGates,
  handleSourceWebhookRequest,
  pollAutoSyncSources,
  type SourcePollOperations,
  type SourceWebhookOperations,
} from "./worker.ts";

function makeWebhookOps(overrides: {
  valid?: boolean;
  throwOnVerify?: boolean;
} = {}): {
  ops: SourceWebhookOperations;
  syncCalls: { sourceId: string; dedupe?: boolean }[];
  verifyCalls: { sourceId: string; secret: string }[];
} {
  const syncCalls: { sourceId: string; dedupe?: boolean }[] = [];
  const verifyCalls: { sourceId: string; secret: string }[] = [];
  const ops: SourceWebhookOperations = {
    verifySourceHookSecret: (sourceId, secret) => {
      verifyCalls.push({ sourceId, secret });
      if (overrides.throwOnVerify) return Promise.reject(new Error("boom"));
      return Promise.resolve(overrides.valid ?? true);
    },
    createSourceSync: (sourceId, options) => {
      syncCalls.push({ sourceId, dedupe: options?.dedupe });
      return Promise.resolve({ run: { id: "ssr_1" } });
    },
  };
  return { ops, syncCalls, verifyCalls };
}

const SOURCE_ID = "src_route0000000001";

function webhookRequest(
  body: unknown,
  init: { method?: string; bearer?: string } = {},
): { request: Request; url: URL } {
  const url = new URL(`https://app.takosumi.com/hooks/sources/${SOURCE_ID}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
  const request = new Request(url, {
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { request, url };
}

test("webhook rejects a missing bearer (401)", async () => {
  const { ops, syncCalls } = makeWebhookOps();
  const { request, url } = webhookRequest({ junk: true });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(401);
  expect(syncCalls).toHaveLength(0);
});

test("webhook rejects a wrong bearer (401) and does not trigger a sync", async () => {
  const { ops, syncCalls } = makeWebhookOps({ valid: false });
  const { request, url } = webhookRequest({}, { bearer: "wrong" });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(401);
  expect(syncCalls).toHaveLength(0);
});

test("webhook with a verify error is treated as unauthenticated (401)", async () => {
  const { ops, syncCalls } = makeWebhookOps({ throwOnVerify: true });
  const { request, url } = webhookRequest({}, { bearer: "x" });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(401);
  expect(syncCalls).toHaveLength(0);
});

test("webhook with a good bearer triggers a deduped sync and IGNORES the payload (202)", async () => {
  const { ops, syncCalls, verifyCalls } = makeWebhookOps({ valid: true });
  // An attacker-controlled payload claiming a different source must be ignored:
  // the effect is keyed off the URL source id, not the body.
  const { request, url } = webhookRequest(
    { sourceId: "src_attacker", ref: "evil" },
    { bearer: "good-secret" },
  );
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(202);
  expect((await response.json()).runId).toBe("ssr_1");
  expect(verifyCalls).toEqual([{ sourceId: SOURCE_ID, secret: "good-secret" }]);
  expect(syncCalls).toEqual([{ sourceId: SOURCE_ID, dedupe: true }]);
});

test("webhook rejects a non-POST method (405)", async () => {
  const { ops } = makeWebhookOps();
  const { request, url } = webhookRequest({}, { method: "GET", bearer: "x" });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(405);
});

test("webhook rejects an unsupported source id shape (404)", async () => {
  const { ops } = makeWebhookOps();
  const url = new URL("https://app.takosumi.com/hooks/sources/not-a-source");
  const request = new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer x" },
  });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(404);
});

test("scheduled poll enqueues a deduped sync per autoSync source, capped", async () => {
  const syncCalls: string[] = [];
  const ops: SourcePollOperations = {
    verifySourceHookSecret: () => Promise.resolve(true),
    createSourceSync: (sourceId) => {
      syncCalls.push(sourceId);
      return Promise.resolve({ run: { id: `ssr_${sourceId}` } });
    },
    controller: {
      listAutoSyncSources: (limit) =>
        Promise.resolve(
          [{ id: "src_a" }, { id: "src_b" }].slice(0, limit),
        ),
    },
  };
  await pollAutoSyncSources(ops, 50);
  expect(syncCalls).toEqual(["src_a", "src_b"]);
});

test("drift sweep is OFF by default and only enabled by the =1 flag", () => {
  // Default OFF: the scheduled() handler skips the drift sweep unless the flag is
  // explicitly set to "1" (spec §28 / Phase 8 opt-in).
  const base = { TAKOSUMI_ACCOUNTS_DB: {} } as never;
  expect(driftCheckEnabled(base)).toBe(false);
  expect(
    driftCheckEnabled({ ...base, TAKOSUMI_DRIFT_CHECK_ENABLED: "0" } as never),
  ).toBe(false);
  expect(
    driftCheckEnabled({ ...base, TAKOSUMI_DRIFT_CHECK_ENABLED: "true" } as never),
  ).toBe(false);
  expect(
    driftCheckEnabled({ ...base, TAKOSUMI_DRIFT_CHECK_ENABLED: "1" } as never),
  ).toBe(true);
});

test("production hardening gates require container smoke, egress, provider templates, and secret-boundary evidence", () => {
  const missing = evaluateProductionHardeningGates({
    TAKOSUMI_PRODUCTION_HARDENING_GATE: "enforce",
  } as never);
  expect(missing.ok).toBe(false);
  expect(missing.enforced).toBe(true);
  expect(missing.checks.containerSmoke.reason).toBe("missing_evidence_ref");
  expect(missing.checks.egressEnforcement.reason).toBe("missing_evidence_ref");
  expect(missing.checks.providerTemplates.reason).toBe("missing_evidence_ref");
  expect(missing.checks.secretBoundary.reason).toBe("missing_evidence_ref");

  const invalidDigest = evaluateProductionHardeningGates({
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#container.md",
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST: "not-a-digest",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#egress.md",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#providers.md",
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#secrets.md",
    TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  } as never);
  expect(invalidDigest.ok).toBe(false);
  expect(invalidDigest.checks.containerSmoke.reason).toBe(
    "evidence_digest_must_be_sha256",
  );

  const mutableRef = evaluateProductionHardeningGates({
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git#container.md",
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  } as never);
  expect(mutableRef.ok).toBe(false);
  expect(mutableRef.checks.containerSmoke.reason).toBe(
    "evidence_ref_must_be_commit_pinned",
  );

  const ok = evaluateProductionHardeningGates({
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#container.md",
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#egress.md",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#providers.md",
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#secrets.md",
    TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  } as never);
  expect(ok.ok).toBe(true);
});

test("hardening gates route is operator bearer gated and returns 503 when enforced evidence is missing", async () => {
  const worker = (await import("./worker.ts")).default;
  const env = {
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret",
    TAKOSUMI_PRODUCTION_HARDENING_GATE: "enforce",
  } as never;

  expect(
    (
      await worker.fetch(
        new Request(
          "https://app.takosumi.com/internal/platform/hardening-gates",
        ),
        env,
      )
    ).status,
  ).toBe(401);

  const response = await worker.fetch(
    new Request("https://app.takosumi.com/internal/platform/hardening-gates", {
      headers: { authorization: "Bearer operator-secret" },
    }),
    env,
  );
  expect(response.status).toBe(503);
  expect((await response.json()).ok).toBe(false);
});

test("scheduled poll continues past a failing source", async () => {
  const syncCalls: string[] = [];
  const ops: SourcePollOperations = {
    verifySourceHookSecret: () => Promise.resolve(true),
    createSourceSync: (sourceId) => {
      syncCalls.push(sourceId);
      if (sourceId === "src_a") return Promise.reject(new Error("nope"));
      return Promise.resolve({ run: { id: "ssr" } });
    },
    controller: {
      listAutoSyncSources: () =>
        Promise.resolve([{ id: "src_a" }, { id: "src_b" }]),
    },
  };
  await pollAutoSyncSources(ops, 50);
  expect(syncCalls).toEqual(["src_a", "src_b"]);
});
