// H9 / Phase 18.2 — descriptor closure version compatibility tests.
//
// The retained closure on `Deployment.resolution.descriptor_closure` pins
// every descriptor (alias + raw digest) the deployment was resolved against.
// Apply re-uses the closure verbatim and never re-fetches descriptor URLs.
// Between resolve and apply, an operator might upgrade a provider plugin
// from `provider.aws.rds@v1` to `provider.aws.rds@v2` — the closure still
// pins v1 but the live plugin now consumes v2. We MUST detect this and
// fail-closed at the apply preflight rather than silently apply with a
// stale pin.

import assert from "node:assert/strict";
import {
  type LiveDescriptorState,
  verifyClosureVersionCompatibility,
  verifyDescriptorClosureCompatibility,
} from "./descriptor_closure.ts";
import type {
  DeploymentDescriptorClosure,
  IsoTimestamp,
} from "takosumi-contract";

const RESOLVED_AT = "2026-04-30T00:00:00.000Z" as IsoTimestamp;

function buildClosure(
  resolutions: ReadonlyArray<{
    readonly alias: string;
    readonly id?: string;
    readonly rawDigest: string;
  }>,
): DeploymentDescriptorClosure {
  return {
    resolutions: resolutions.map((entry) => ({
      id: entry.id ?? `https://takosumi.com/contracts/${entry.alias}`,
      alias: entry.alias,
      documentUrl: entry.id ?? `https://takosumi.com/contracts/${entry.alias}`,
      mediaType: "application/ld+json",
      rawDigest: entry.rawDigest,
      expandedDigest: `sha256:expanded-${entry.alias}`,
      canonicalization: {
        algorithm: "json-stable-stringify",
        version: "takosumi-v1",
      },
      resolvedAt: RESOLVED_AT,
    })),
    closureDigest: "sha256:closure-test",
    createdAt: RESOLVED_AT,
  };
}

function liveMap(
  entries: ReadonlyArray<readonly [string, LiveDescriptorState]>,
): ReadonlyMap<string, LiveDescriptorState> {
  return new Map(entries);
}

Deno.test("H9: closure compatible when every alias matches live registry exactly", () => {
  const closure = buildClosure([
    { alias: "provider.aws.rds@v1", rawDigest: "sha256:aws-rds-v1" },
    {
      alias: "provider.cloudflare.kv@v1",
      rawDigest: "sha256:cf-kv-v1",
    },
  ]);
  const live = liveMap([
    [
      "provider.aws.rds@v1",
      {
        alias: "provider.aws.rds@v1",
        rawDigest: "sha256:aws-rds-v1",
      },
    ],
    [
      "provider.cloudflare.kv@v1",
      {
        alias: "provider.cloudflare.kv@v1",
        rawDigest: "sha256:cf-kv-v1",
      },
    ],
  ]);

  const report = verifyClosureVersionCompatibility(closure, live);
  assert.equal(report.compatible, true);
  assert.equal(report.mismatches.length, 0);

  // The throwing wrapper must succeed silently.
  verifyDescriptorClosureCompatibility(closure, live);
});

Deno.test("H9: closure incompatible on major version mismatch (v1 pinned, v2 live)", () => {
  const closure = buildClosure([
    { alias: "provider.aws.rds@v1", rawDigest: "sha256:aws-rds-v1" },
  ]);
  // The live plugin upgraded to v2 between resolve and apply.
  const live = liveMap([
    [
      "provider.aws.rds@v1",
      {
        alias: "provider.aws.rds@v2",
        rawDigest: "sha256:aws-rds-v2",
      },
    ],
  ]);

  const report = verifyClosureVersionCompatibility(closure, live);
  assert.equal(report.compatible, false);
  assert.equal(report.mismatches.length, 1);
  const [mismatch] = report.mismatches;
  assert.equal(mismatch.kind, "major-version-mismatch");
  assert.equal(mismatch.alias, "provider.aws.rds@v1");
  assert.equal(mismatch.liveAlias, "provider.aws.rds@v2");
  assert.match(mismatch.upgradeGuide, /takos deploy plan --refresh/);

  // Throwing wrapper surfaces a TypeError naming the mismatch + the
  // upgrade guide so apply preflight fails closed with an actionable
  // signal for the operator.
  assert.throws(
    () => verifyDescriptorClosureCompatibility(closure, live),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      const message = (error as Error).message;
      assert.match(message, /major-version-mismatch/);
      assert.match(message, /provider\.aws\.rds@v1/);
      assert.match(message, /v1.*v2|v2.*v1/);
      return true;
    },
  );
});

Deno.test("H9: closure incompatible when alias exists but raw digest changed (apiVersion bump on same v1)", () => {
  const closure = buildClosure([
    { alias: "provider.gcp.cloud-run@v1", rawDigest: "sha256:gcp-cr-v1-a" },
  ]);
  // Same v1 alias, but the descriptor body apiVersion changed.
  const live = liveMap([
    [
      "provider.gcp.cloud-run@v1",
      {
        alias: "provider.gcp.cloud-run@v1",
        rawDigest: "sha256:gcp-cr-v1-b",
      },
    ],
  ]);

  const report = verifyClosureVersionCompatibility(closure, live);
  assert.equal(report.compatible, false);
  assert.equal(report.mismatches.length, 1);
  assert.equal(report.mismatches[0].kind, "digest-mismatch");
});

Deno.test("H9: closure incompatible when pinned alias not present in live registry (plugin disabled)", () => {
  const closure = buildClosure([
    {
      alias: "provider.cloudflare.workers@v1",
      rawDigest: "sha256:cf-w-v1",
    },
  ]);
  // Cloudflare plugin disabled between resolve and apply → empty registry.
  const live = liveMap([]);

  const report = verifyClosureVersionCompatibility(closure, live);
  assert.equal(report.compatible, false);
  assert.equal(report.mismatches.length, 1);
  assert.equal(report.mismatches[0].kind, "alias-not-loaded");
  assert.equal(
    report.mismatches[0].alias,
    "provider.cloudflare.workers@v1",
  );
  assert.match(
    report.mismatches[0].upgradeGuide,
    /re-enable the plugin/,
  );
});
