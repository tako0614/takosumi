import { expect, test } from "bun:test";
import { findAuthoritativeDocViolations } from "../../scripts/lib/authoritative-doc-boundaries";

const COMPLETE_BASELINE = [
  {
    path: "docs/index.md",
    content: `Takosumi は first-party Terraform/OpenTofu provider を同梱しません。
通常の BYOC では Workspace/customer が vendor account と credential、作成される resource を所有します。
ProviderConnection → CredentialRecipe → ProviderBinding → run-scoped runner materialization → standard OpenTofu provider → customer-owned resource
旧 Generic Offering は implementation conformance gap の migration surface です。
Takosumi Cloud は退役した historical identity です。
Takoserver は WfP namespace と managed Offering を所有します。`,
  },
  {
    path: "docs/en/index.md",
    content: `Takosumi does not ship a first-party Terraform/OpenTofu provider.
In ordinary BYOC the Workspace/customer owns the vendor account, credential, and customer-owned resource.
ProviderConnection -> CredentialRecipe -> ProviderBinding -> run-scoped runner materialization -> standard OpenTofu provider -> customer-owned resource
Generic Offering is an implementation conformance gap and migration surface.
Takosumi Cloud is a retired historical identity.
Takoserver owns the WfP namespace and managed Offering.`,
  },
  {
    path: "docs/concepts/boundaries.md",
    content: `provider 側の resource は必ずしも
Takosumi の Resource 台帳には入りません。
Takosumi Hosted owns retail, commerce, and client composition.
Takoserver owns managed supply, capacity, and the Workers for Platforms WfP namespace.
Takosumi Cloud は退役した historical identity です。`,
  },
  {
    path: "docs/en/concepts/boundaries.md",
    content: `Provider-side objects do not
necessarily enter Takosumi's Resource ledger.
Takosumi Hosted owns retail, commerce, and client composition.
Takoserver owns managed supply, capacity, and the Workers for Platforms WfP namespace.
Takosumi Cloud is a retired historical identity.`,
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
      "将来 metadata\nsection を追加するときは新しい `apiVersion` を定義し、未知 field は\n安全側に停止したままにします。",
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
    content: `Takosumi OSS is the customer BYOC control plane.
ProviderConnection -> CredentialRecipe -> ProviderBinding -> run-scoped materialization.
Takosumi ships no first-party Terraform/OpenTofu provider.
Generic Offering is not a Takosumi Core authority. Existing source code may still contain routes; their presence is an implementation conformance gap and deletion/migration custody.
Resource Shape and Form Host are migration internals, not a supported OSS authoring flow.
Takosumi Cloud is a retired historical identity.
A managed customer \`ModuleWorker\` and Workers for Platforms namespace belongs to Takoserver.`,
  },
  {
    path: "docs/internal/core-conformance.md",
    content: `Takosumi has no parent Host credential, provider installation, backend, capacity, WfP namespace/dispatcher, or native identity.
Customer BYOC uses ProviderConnection -> CredentialRecipe -> ProviderBinding -> run-scoped materialization.
Generic Offering has no Offering catalog authority; its routes are an implementation conformance gap.
Resource/Form lifecycle is migration-only.
Deploy boundary: managed customer \`ModuleWorker\` belongs to Takoserver.`,
  },
  {
    path: "app-docs/index.md",
    content: `> **歴史資料（アーカイブ）— 現行の正本ではありません。**
Takosumi Cloud は退役した historical identity で、availability/pricing/SLA/support は current authority ではありません。
Takosumi Hosted owns current retail, commerce, and client docs.
Takoserver owns managed supply, capacity, provider credentials, and Offerings.`,
  },
  {
    path: "app-docs/en/index.md",
    content: `> **Historical archive — not current authority.**
Takosumi Cloud is a retired historical identity; availability, pricing, SLA, and support are not current authority.
Takosumi Hosted owns current retail, commerce, and client docs.
Takoserver owns managed supply, capacity, provider credentials, and Offerings.`,
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

test("authoritative docs reject an unmarked app-docs Cloud claim", () => {
  const violations = findAuthoritativeDocViolations(
    COMPLETE_BASELINE.map((source) =>
      source.path === "app-docs/en/index.md"
        ? { ...source, content: "# Takosumi Cloud\nEvery service is available." }
        : source,
    ),
  );

  expect(violations).toContainEqual(
    expect.objectContaining({
      ruleId: "app-docs-archive-notice-missing",
      path: "app-docs/en/index.md",
    }),
  );
});

test("authoritative docs require Generic Offering and Form Host gaps to stay explicit", () => {
  const violations = findAuthoritativeDocViolations(
    COMPLETE_BASELINE.map((source) =>
      source.path === "docs/internal/core-spec.md"
        ? {
            ...source,
            content:
              "Takosumi OSS is the customer BYOC control plane.\nTakosumi ships no first-party Terraform/OpenTofu provider.",
          }
        : source,
    ),
  );

  expect(violations).toContainEqual(
    expect.objectContaining({
      ruleId: "missing-retirement-claim",
      path: "docs/internal/core-spec.md",
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

  expect(coreSpec).toMatch(/This document is the present Takosumi OSS contract/);
  expect(coreSpec).toMatch(/customer BYOC control plane/);
  expect(coreSpec).toMatch(/one supported\s+Git\/OpenTofu\/Terraform deployment\s+flow/);
  expect(coreSpec).toMatch(/TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1/);
  expect(coreSpec).toMatch(/does not host a Form Registry/);
  expect(coreSpec).toMatch(/Generic Offering is not a Takosumi Core authority/);
  expect(coreSpec).toMatch(/implementation conformance gap/);
  expect(coreSpec).toMatch(/Takosumi Cloud is a retired historical identity/);
  expect(coreSpec).toMatch(/managed customer `ModuleWorker`/);
  expect(coreSpec).toMatch(/Takoserver/);
  expect(finalPlan).toMatch(/historical planning record|superseded/);
  expect(finalPlan).toMatch(/present contract is \[Core Spec\]|current Takosumi OSS contract/);
  expect(finalPlan).toMatch(/customer BYOC control plane/);
  expect(finalPlan).toMatch(/Takosumi Hosted[\s\S]{0,120}retail/);
  expect(finalPlan).toMatch(/Takosumi\s+Cloud[\s\S]{0,80}retired\s+historical identity/);
  expect(finalPlan).not.toMatch(/authoritative Takosumi product direction/);
});
