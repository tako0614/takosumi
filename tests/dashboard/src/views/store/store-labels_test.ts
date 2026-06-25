import { describe, expect, test } from "bun:test";
import {
  tcsBadgeLabel,
  tcsCategoryLabel,
  tcsKindLabel,
  tcsProviderLabel,
} from "../../../../../dashboard/src/views/store/store-labels.ts";

describe("Store labels", () => {
  test("renders TCS internal category keys as user-facing labels", () => {
    expect(tcsCategoryLabel("building_block", "ja")).toBe("基盤");
    expect(tcsCategoryLabel("example", "ja")).toBe("サンプル");
    expect(tcsCategoryLabel("service", "ja")).toBe("アプリ");
    expect(tcsCategoryLabel("productivity", "ja")).toBe("仕事・文書");

    expect(tcsCategoryLabel("building_block", "en")).toBe("Building blocks");
    expect(tcsCategoryLabel("custom_provider", "en")).toBe("Custom Provider");
  });

  test("renders provider, kind, and badge values without raw catalog tokens", () => {
    expect(tcsKindLabel("worker", "ja")).toBe("Webアプリ");
    expect(tcsKindLabel("site", "en")).toBe("Website");
    expect(tcsProviderLabel("cloudflare")).toBe("Cloudflare");
    expect(tcsProviderLabel("aws")).toBe("AWS");
    expect(tcsBadgeLabel("official", "ja")).toBe("公式");
  });
});
