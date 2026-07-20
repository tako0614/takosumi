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
