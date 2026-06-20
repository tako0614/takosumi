import { describe, expect, test } from "bun:test";
import { isLikelyStaleAssetError } from "../../../../dashboard/src/lib/chunk-reload.ts";

describe("stale asset reload detection", () => {
  test("detects Vite dynamic import failures", () => {
    expect(
      isLikelyStaleAssetError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://app.takosumi.com/assets/NewAppView-old.js",
        ),
      ),
    ).toBe(true);
  });

  test("detects stale module responses served as HTML", () => {
    expect(
      isLikelyStaleAssetError(
        'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".',
      ),
    ).toBe(true);
  });

  test("ignores ordinary application errors", () => {
    expect(isLikelyStaleAssetError(new Error("Select a Workspace."))).toBe(
      false,
    );
  });
});
