import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const kitRoot = new URL("../../../mobile-kit/", import.meta.url);

function readKit(path: string): string {
  return readFileSync(new URL(path, kitRoot), "utf8");
}

test("mobile preview primitives expose the shared shell class contract", () => {
  const source = readKit("src/solid-primitives.tsx");
  const exports = readKit("src/solid.ts");
  const css = readKit("src/mobile-shell.css");

  expect(source).toContain('mobileClass("compose-section", props.class)');
  expect(source).toContain('mobileClass("compose-form", props.class)');
  expect(source).toContain('mobileClass("compose-field", props.class)');
  expect(source).toContain('mobileClass("compose-footer", props.class)');
  expect(source).toContain('mobileClass("segmented-control", props.class)');
  expect(source).toContain('mobileClass("preview-section", props.class)');
  expect(source).toContain('class="preview-section-heading"');
  expect(source).toContain('class="preview-section-actions"');
  expect(source).toContain('mobileClass("preview-list", props.class)');
  expect(source).toContain('mobileClass("preview-item", props.class)');
  expect(exports).toContain("MobileComposeSection");
  expect(exports).toContain("MobileComposeForm");
  expect(exports).toContain("MobileComposeField");
  expect(exports).toContain("MobileComposeFooter");
  expect(exports).toContain("MobileSegmentedControl");
  expect(exports).toContain("MobilePreviewSection");
  expect(exports).toContain("MobilePreviewList");
  expect(exports).toContain("MobilePreviewCard");
  expect(css).toContain(".compose-section");
  expect(css).toContain(".compose-field");
  expect(css).toContain(".segmented-control");
  expect(css).toContain(".preview-section-heading");
  expect(css).toContain(".preview-section-actions");
});
