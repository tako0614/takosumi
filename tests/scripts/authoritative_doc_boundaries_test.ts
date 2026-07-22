import { expect, test } from "bun:test";
import { findAuthoritativeDocViolations } from "../../scripts/lib/authoritative-doc-boundaries";

const COMPLETE_BASELINE = [
  {
    path: "docs/index.md",
    content: "`takosumi/takosumi` provider は廃止済みです。",
  },
  {
    path: "docs/en/index.md",
    content: "The `takosumi/takosumi` provider is discontinued.",
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
      "No corrected or replacement Takosumi provider version will be built or published.",
  },
  {
    path: "docs/internal/core-spec.md",
    content: "No new Takosumi-provider state is authored.",
  },
  {
    path: "docs/internal/core-conformance.md",
    content:
      "No provider release or default mirror lane exists. Historical custody is retained.",
  },
] as const;

test("authoritative docs accept only retired Takosumi provider custody", () => {
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

test("authoritative docs reject active Takosumi provider wording", () => {
  for (const content of [
    "The Takosumi provider will publish the next admin resources.",
    "Add new `takosumi_*` resources to the current provider.",
  ]) {
    const violations = findAuthoritativeDocViolations([
      ...COMPLETE_BASELINE,
      { path: "docs/reference/provider.md", content },
    ]);

    expect(violations).toContainEqual(
      expect.objectContaining({ ruleId: "active-takosumi-provider-doc" }),
    );
  }
});

test("authoritative docs reject active provider claims masked by generic negative context", () => {
  for (const content of [
    "The Takosumi provider will publish new resources. It is not required for plain stacks.",
    "The Takosumi provider publishes new resources alongside existing state.",
    "The Takosumi provider will add an admin resource. Takosumi does not depend on it.",
    "Add new `takosumi_*` resources to the provider. The provider is retired.",
    "Takosumi provider は今後新規 resource を公開します。他の Stack は依存しません。",
    "The discontinued Takosumi provider is still used to author new resources.",
    "The retired terraform-provider-takosumi remains the default provider.",
    "The discontinued Takosumi provider is used for current deployments.",
    "The retired Takosumi provider continues as the authoring surface.",
    "The retired Takosumi provider acts as the default client.",
  ]) {
    const violations = findAuthoritativeDocViolations([
      ...COMPLETE_BASELINE,
      { path: "docs/reference/provider-mixed-claim.md", content },
    ]);

    expect(violations).toContainEqual(
      expect.objectContaining({ ruleId: "active-takosumi-provider-doc" }),
    );
  }
});

test("authoritative docs allow explicit historical-only use and old-state support", () => {
  for (const content of [
    "The discontinued Takosumi provider is used only for historical migration/rollback custody.",
    "The discontinued provider's `takosumi_*` old state remains supported throughout v1 migration custody.",
  ]) {
    const violations = findAuthoritativeDocViolations([
      ...COMPLETE_BASELINE,
      { path: "docs/reference/provider-custody.md", content },
    ]);

    expect(violations).toEqual([]);
  }
});

test("authoritative docs reject generic negatives without explicit retirement custody", () => {
  for (const content of [
    "The Takosumi provider is not required for plain stacks.",
    "Takosumi does not depend on the Takosumi provider.",
    "The `takosumi_*` resources have existing state.",
  ]) {
    const violations = findAuthoritativeDocViolations([
      ...COMPLETE_BASELINE,
      { path: "docs/reference/provider-generic-negative.md", content },
    ]);

    expect(violations).toContainEqual(
      expect.objectContaining({ ruleId: "active-takosumi-provider-doc" }),
    );
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
    "No corrected or replacement Takosumi provider version will be built or published.",
    "## 11. Takosumi Cloud Public Offering",
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
});
