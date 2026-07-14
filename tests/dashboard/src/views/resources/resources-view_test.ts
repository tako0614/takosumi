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
