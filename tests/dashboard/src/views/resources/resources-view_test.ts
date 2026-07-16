import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (path: string) =>
  readFileSync(
    new URL(`../../../../../dashboard/src/${path}`, import.meta.url),
    "utf8",
  );

const index = src("index.tsx");
const nav = src("views/account/components/shell/nav.ts");
const editor = src("views/resources/ResourceEditor.tsx");
const serviceForm = src("lib/resource-service-form.ts");
const en = src("i18n/en.ts");
const ja = src("i18n/ja.ts");
const detail = src("views/resources/ResourceDetailView.tsx");
const inventory = src("views/resources/ResourcesView.tsx");

describe("Resource Shape dashboard surface", () => {
  test("is reachable through Settings > Manage with list and detail routes", () => {
    expect(nav).toContain('href: "/resources"');
    expect(nav).toContain('labelKey: "nav.resources"');
    expect(index).toContain(
      '<Route path="/resources" component={ResourcesView} />',
    );
    expect(index).toContain('path="/resources/:kind/:name"');
  });

  test("requires a current preview and explicit confirmation before apply/import", () => {
    expect(editor).toContain("previewResourceShape");
    expect(editor).toContain("previewFingerprint");
    expect(editor).toContain("resourceShapeInputFingerprint");
    expect(editor).toContain("if (!previewIsCurrent())");
    expect(editor).toContain("await confirm({");
    expect(editor).toContain("applyResourceShape");
    expect(editor).toContain("importResourceShape");
    expect(editor).toContain("planDigest: reviewedPreview.planDigest");
    expect(editor).toContain("quoteId: reviewedPreview.quote.quoteId");
    expect(editor).toContain("quoteDigest: reviewedPreview.quote.quoteDigest");
  });

  test("defaults to service-first guided forms before price, preview, and deploy", () => {
    const service = editor.indexOf('data-step="service"');
    const inputs = editor.indexOf('data-step="inputs"');
    const preview = editor.indexOf('data-step="preview"');
    const price = editor.indexOf('class="rs-price-review"');
    const deploy = editor.indexOf('data-step="deploy"');
    expect(service).toBeGreaterThan(-1);
    expect(inputs).toBeGreaterThan(service);
    expect(preview).toBeGreaterThan(inputs);
    expect(price).toBeGreaterThan(preview);
    expect(deploy).toBeGreaterThan(price);
    expect(editor).toContain('<option value="EdgeWorker">');
    expect(editor).toContain('<option value="ObjectBucket">');
    expect(editor).toContain('value="custom"');
    expect(editor).toContain("buildGuidedResourceServiceSpec");
    expect(editor).toContain("readGuidedResourceServiceForm");
    expect(editor).toContain('value="infrequent_access"');
    expect(detail).toContain("objectBucketStorageClass(item())");
  });

  test("offers every bundled shape through the same guided and raw authoring paths", () => {
    for (const kind of [
      "EdgeWorker",
      "ObjectBucket",
      "KVStore",
      "SQLDatabase",
      "Queue",
      "VectorIndex",
      "DurableWorkflow",
      "ContainerService",
      "StatefulActorNamespace",
      "Schedule",
    ]) {
      expect(serviceForm).toContain(`"${kind}"`);
      expect(editor).toContain(`<option value="${kind}">`);
      expect(editor).toContain(`case "${kind}":`);
    }
    expect(editor).toContain("<For each={BUNDLED_KINDS}>");
    expect(editor).toContain(
      'type ServiceSelection = GuidedResourceServiceKind | "custom";',
    );
    expect(serviceForm).toContain("draftGuidedResourceServiceSpec");
  });

  test("labels the bundled set Stable without inventing AI or domain Resource kinds", () => {
    expect(editor).toContain('t("resources.editor.stable")');
    expect(en).toContain("All ten bundled Resource Shapes");
    expect(ja).toContain("10 個の組み込み Resource Shape");
    expect(serviceForm).not.toContain('"AIGateway"');
    expect(serviceForm).not.toContain('"VerifiedDomain"');
    expect(editor).not.toContain('<option value="AIGateway">');
    expect(editor).not.toContain('<option value="VerifiedDomain">');
  });

  test("keeps raw/custom and placement controls in advanced disclosure", () => {
    const advanced = editor.indexOf('<details class="rs-advanced"');
    expect(advanced).toBeGreaterThan(-1);
    expect(editor.indexOf('t("resources.editor.project")')).toBeGreaterThan(
      advanced,
    );
    expect(editor.indexOf('t("resources.editor.targetPool")')).toBeGreaterThan(
      advanced,
    );
    expect(editor.indexOf('t("resources.editor.spec")')).toBeGreaterThan(
      advanced,
    );
    expect(editor).toContain("setGuidedMode(false)");
    expect(editor).toContain('setError(t("resources.editor.rawCannotGuide"))');
    expect(serviceForm).toContain(
      "the Deploy API remains the schema/capability authority",
    );
    expect(serviceForm).not.toMatch(
      /ServiceOffering|PriceCatalog|cloudflare/iu,
    );
  });

  test("keeps break-glass deletion out of the dashboard and hides Output values", () => {
    expect(detail).toContain("deleteResourceShape");
    expect(detail).not.toContain("force:");
    expect(detail).toContain("resourceOutputKeys(item())");
    expect(detail).not.toContain("Object.entries(item().status?.outputs");
  });

  test("makes SpacePolicy records discoverable, editable, and deletable", () => {
    expect(inventory).toContain("listResourceSpacePolicies");
    expect(inventory).toContain("editSpacePolicy");
    expect(inventory).toContain("deleteResourceSpacePolicy");
    expect(inventory).toContain("rows={spacePolicies()}");
  });
});
