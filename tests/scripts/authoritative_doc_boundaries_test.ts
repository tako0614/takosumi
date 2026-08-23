import { expect, test } from "bun:test";
import { findAuthoritativeDocViolations } from "../../scripts/lib/authoritative-doc-boundaries";

const COMPLETE_BASELINE = [
  {
    path: "docs/index.md",
    content:
      "Takosumi は first-party Terraform/OpenTofu provider を同梱しません。",
  },
  {
    path: "docs/en/index.md",
    content:
      "Takosumi does not ship a first-party Terraform/OpenTofu provider.",
  },
  {
    path: "docs/concepts/boundaries.md",
    content:
      "provider 側の resource は必ずしも\nTakosumi の Resource 台帳には入りません。",
  },
  {
    path: "docs/en/concepts/boundaries.md",
    content:
      "Provider-side objects do not\nnecessarily enter Takosumi's Resource ledger.",
  },
  {
    path: "docs/concepts/interfaces.md",
    content:
      "provider credential、account id、native resource id、bearer token は\n渡しません。",
  },
  {
    path: "docs/en/concepts/interfaces.md",
    content:
      "The runtime does not receive provider credentials, account ids, native resource ids, or bearer\ntokens.",
  },
  {
    path: "docs/reference/repository-manifest.md",
    content:
      "将来 metadata\nsection を追加するときは新しい `apiVersion` を定義し、未知 field は\nfail closed のままです。",
  },
  {
    path: "docs/en/reference/repository-manifest.md",
    content:
      "A future metadata\nsection requires a new `apiVersion`; unknown fields continue to fail closed.",
  },
  {
    path: "docs/reference/api.md",
    content:
      "Cloudflare 固有の import/deploy compatibility profile は廃止済みです。",
  },
  {
    path: "docs/en/reference/api.md",
    content:
      "The Cloudflare-specific import/deploy compatibility profile is retired.",
  },
  {
    path: "docs/internal/final-plan.md",
    content:
      "Takosumi ships no first-party Terraform/OpenTofu provider.",
  },
  {
    path: "docs/internal/core-spec.md",
    content: "Takosumi ships no first-party Terraform/OpenTofu provider.",
  },
  {
    path: "docs/internal/core-conformance.md",
    content:
      "No first-party provider source, release, custody, or public mirror lane exists.",
  },
  {
    path: "app-docs/index.md",
    content:
      "認証済み Takosumi catalog の `available` が現在の提供状態です。",
  },
  {
    path: "app-docs/en/index.md",
    content:
      "The authenticated Takosumi catalog exposes the current `available` state.",
  },
] as const;

test("authoritative docs keep first-party provider implementation external", () => {
  expect(findAuthoritativeDocViolations(COMPLETE_BASELINE)).toEqual([]);
});

test("authoritative docs reject retired Cloudflare compatibility identities and pins", () => {
  const additions = [
    ["route", "POST /compat/cloudflare/scripts"],
    ["capability", "compat.cloudflare.workers.v1"],
    ["provider pin", "cloudflare/cloudflare 5.19.1"],
  ] as const;

  for (const [name, content] of additions) {
    const violations = findAuthoritativeDocViolations([
      ...COMPLETE_BASELINE,
      { path: `docs/reference/${name}.md`, content },
    ]);
    expect(
      violations.some(({ ruleId }) => ruleId.startsWith("retired-cloudflare")),
    ).toBe(true);
  }
});

test("authoritative docs require matching Japanese and English retirement claims", () => {
  const violations = findAuthoritativeDocViolations(
    COMPLETE_BASELINE.filter(({ path }) => path !== "docs/en/reference/api.md"),
  );

  expect(violations).toContainEqual(
    expect.objectContaining({
      ruleId: "missing-authoritative-doc",
      path: "docs/en/reference/api.md",
    }),
  );
});

test("authoritative docs reject a split Cloud GA availability contract", () => {
  const staleFinalPlan = [
    "Takosumi ships no first-party Terraform/OpenTofu provider.",
    "## 11. Takosumi hosted service Public Offering",
    "Stable:\n  EdgeWorker",
    "Preview:\n  VectorIndex",
    "## 12. Billing Boundary",
    "## 14. GA Contract",
    "The ten-form Service Form Stable set is all-or-nothing:",
    "EdgeWorker ObjectBucket KVStore SQLDatabase Queue VectorIndex DurableWorkflow ContainerService StatefulActorNamespace Schedule AI Gateway VerifiedDomain",
    "## 15. Immediate Build Order",
  ].join("\n\n");
  const violations = findAuthoritativeDocViolations(
    COMPLETE_BASELINE.map((source) =>
      source.path === "docs/internal/final-plan.md"
        ? { ...source, content: staleFinalPlan }
        : source,
    ),
  );

  expect(violations).toContainEqual(
    expect.objectContaining({ ruleId: "cloud-ga-split-contract" }),
  );
  expect(violations).toContainEqual(
    expect.objectContaining({
      ruleId: "cloud-ga-form-maturity-conflation",
    }),
  );
});

test("hosted docs use the authenticated catalog instead of a hard-coded service matrix", () => {
  const violations = findAuthoritativeDocViolations(
    COMPLETE_BASELINE.map((source) =>
      source.path === "app-docs/en/index.md"
        ? { ...source, content: "Every service is always available." }
        : source,
    ),
  );

  expect(violations).toContainEqual(
    expect.objectContaining({
      ruleId: "hosted-docs-catalog-authority-missing",
      path: "app-docs/en/index.md",
    }),
  );
});

test("current Core Spec owns the boundary and Final Plan is only historical", async () => {
  const coreSpec = await Bun.file(
    new URL("../../docs/internal/core-spec.md", import.meta.url),
  ).text();
  const finalPlan = await Bun.file(
    new URL("../../docs/internal/final-plan.md", import.meta.url),
  ).text();

  expect(coreSpec).toMatch(/present Takosumi OSS contract/);
  expect(coreSpec).toMatch(/one supported\s+Git\/OpenTofu\/Terraform deployment flow/);
  expect(coreSpec).toMatch(/Retired Resource\/Form HTTP surfaces/);
  expect(coreSpec).toMatch(/unconditional `404`/);
  expect(coreSpec).toMatch(/does not host a Form Registry/);
  expect(finalPlan).toMatch(/historical planning record|superseded/);
  expect(finalPlan).toMatch(/present Takosumi OSS contract is \[Core Spec\]/);
  expect(finalPlan).not.toMatch(/authoritative Takosumi product direction/);
});
