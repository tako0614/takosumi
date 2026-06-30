/**
 * Unit tests for the first-party Capsule module catalog data
 * (`module-files.ts` plus each per-template `template.ts`).
 *
 * These modules are authored as TypeScript catalog data because the service
 * cannot read the filesystem in Workers, and every `template.ts` doc comment
 * warns "keep this object in sync with `module/main.tf`". The bundled HCL also
 * lives inline in `module-files.ts`. These tests assert the cross-references
 * that keep those copies honest:
 *
 *   - every catalog template has bundled, non-empty `main.tf` files;
 *   - every projected output (`outputs.public.*.from`) names an `output` block
 *     that exists in the bundled HCL;
 *   - every required input names a `variable` block in the bundled HCL;
 *   - declared `allowedProviders` appear in the HCL `required_providers` (or the
 *     provider list is empty, like `core`).
 *
 * Pure data assertions — no network, no container, no OpenTofu execution.
 */

import { test, expect } from "bun:test";
import { firstPartyModuleFilesByTemplateId } from "../../opentofu-modules/module-files.ts";
import { cloudflareHelloWorkerTemplate } from "../../providers/cloudflare/modules/cloudflare-hello-worker/template.ts";
import { cloudflareStaticSiteTemplate } from "../../providers/cloudflare/modules/cloudflare-static-site/template.ts";
import { cloudflareWorkerServiceTemplate } from "../../providers/cloudflare/modules/cloudflare-worker-service/template.ts";
import { coreTemplate } from "../../opentofu-modules/core/template.ts";

const TEMPLATES = [
  coreTemplate,
  cloudflareWorkerServiceTemplate,
  cloudflareStaticSiteTemplate,
  cloudflareHelloWorkerTemplate,
];

const PLANNER_MODULE_IDS = [
  "cloudflare-r2-bucket",
  "cloudflare-kv-store",
  "cloudflare-queue",
  "cloudflare-sql-database",
  "takosumi-service-shape",
  "takosumi-container-service",
] as const;

function mainTfFor(id: string): string {
  const files = firstPartyModuleFilesByTemplateId[id];
  expect(files, `bundled module files for ${id}`).toBeDefined();
  const mainTf = files!.find((f) => f.path === "main.tf");
  expect(mainTf, `main.tf for ${id}`).toBeDefined();
  return mainTf!.text;
}

function hasHclBlock(hcl: string, kind: string, label: string): boolean {
  // Matches `output "name" {` / `variable "name" {` allowing arbitrary spacing.
  const pattern = new RegExp(
    `${kind}\\s+"${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\{`,
  );
  return pattern.test(hcl);
}

test("the bundled-file map covers install templates and planner modules", () => {
  const templateIds = new Set([
    ...TEMPLATES.map((t) => t.id),
    ...PLANNER_MODULE_IDS,
  ]);
  const fileIds = new Set(Object.keys(firstPartyModuleFilesByTemplateId));
  expect(fileIds).toEqual(templateIds);
});

test("firstPartyModuleFilesByTemplateId is frozen and immutable", () => {
  expect(Object.isFrozen(firstPartyModuleFilesByTemplateId)).toBe(true);
});

test("every template ships at least one non-empty main.tf", () => {
  for (const template of TEMPLATES) {
    const mainTf = mainTfFor(template.id);
    expect(
      mainTf.length,
      `${template.id} main.tf is non-empty`,
    ).toBeGreaterThan(0);
    expect(mainTf, `${template.id} main.tf has HCL content`).toContain(
      "variable",
    );
  }
});

test("every projected public output references an output block in the bundled HCL", () => {
  for (const template of TEMPLATES) {
    const mainTf = mainTfFor(template.id);
    const projected = template.outputs?.public ?? {};
    for (const [key, spec] of Object.entries(projected)) {
      const from = (spec as { from: string }).from;
      expect(
        hasHclBlock(mainTf, "output", from),
        `${template.id}: projected output "${key}" -> output "${from}" must exist in main.tf`,
      ).toBe(true);
    }
  }
});

test("every required input references a variable block in the bundled HCL", () => {
  for (const template of TEMPLATES) {
    const mainTf = mainTfFor(template.id);
    const inputs = template.inputs ?? {};
    for (const [name, spec] of Object.entries(inputs)) {
      if (!(spec as { required?: boolean }).required) continue;
      expect(
        hasHclBlock(mainTf, "variable", name),
        `${template.id}: required input "${name}" must have a variable block in main.tf`,
      ).toBe(true);
    }
  }
});

test("declared allowedProviders appear in the bundled HCL required_providers", () => {
  for (const template of TEMPLATES) {
    const mainTf = mainTfFor(template.id);
    const providers = template.policy?.allowedProviders ?? [];
    for (const source of providers) {
      // policy uses `<namespace>/<name>`; the HCL declares `source = "<...>"`.
      expect(
        mainTf,
        `${template.id}: provider "${source}" must be declared in main.tf required_providers`,
      ).toContain(source);
    }
  }
});

test("declared allowed resource types appear in the bundled HCL", () => {
  for (const template of TEMPLATES) {
    const mainTf = mainTfFor(template.id);
    for (const resourceType of template.policy?.allowedResourceTypes ?? []) {
      expect(
        mainTf,
        `${template.id}: resource "${resourceType}" must be present in bundled main.tf`,
      ).toContain(`resource "${resourceType}"`);
    }
  }
});

test("core declares no providers and no provider source in its HCL", () => {
  expect(coreTemplate.policy?.allowedProviders).toEqual([]);
  const mainTf = mainTfFor("core");
  expect(mainTf).not.toContain("required_providers");
});

test("each template id+version pair is unique across the catalog", () => {
  const keys = TEMPLATES.map((t) => `${t.id}@${t.version}`);
  expect(new Set(keys).size).toBe(keys.length);
});
