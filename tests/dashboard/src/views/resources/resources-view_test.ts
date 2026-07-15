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
    expect(editor).toContain("buildEdgeWorkerServiceSpec");
    expect(editor).toContain("buildObjectBucketServiceSpec");
  });

  test("offers every bundled shape through raw authoring without expanding guided forms", () => {
    const bundledKinds = editor.slice(
      editor.indexOf("const BUNDLED_KINDS"),
      editor.indexOf("] as const;", editor.indexOf("const BUNDLED_KINDS")),
    );
    for (const kind of [
      "EdgeWorker",
      "ObjectBucket",
      "KVStore",
      "Queue",
      "SQLDatabase",
      "ContainerService",
      "VectorIndex",
      "DurableWorkflow",
      "StatefulActorNamespace",
      "Schedule",
    ]) {
      expect(bundledKinds).toContain(`"${kind}"`);
    }
    expect(editor).toContain("<For each={BUNDLED_KINDS}>");
    expect(editor).toContain(
      'type ServiceSelection = "EdgeWorker" | "ObjectBucket" | "custom";',
    );
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
