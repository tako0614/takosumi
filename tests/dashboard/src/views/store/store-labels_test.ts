import { describe, expect, test } from "bun:test";
import {
  tcsBadgeLabel,
  tcsCategoryLabel,
  tcsProviderLabel,
} from "../../../../../dashboard/src/views/store/store-labels.ts";

describe("Store labels", () => {
  test("renders TCS internal category keys as user-facing labels", () => {
    expect(tcsCategoryLabel("building_block", "ja")).toBe("基盤");
    expect(tcsCategoryLabel("example", "ja")).toBe("サンプル");
    expect(tcsCategoryLabel("service", "ja")).toBe("サービス");
    expect(tcsCategoryLabel("productivity", "ja")).toBe("仕事・文書");
    expect(tcsCategoryLabel("templates", "ja")).toBe("テンプレート");
    expect(tcsCategoryLabel("workspace", "ja")).toBe("ワークスペース");

    expect(tcsCategoryLabel("building_block", "en")).toBe("Building blocks");
    expect(tcsCategoryLabel("custom_provider", "en")).toBe("Custom Provider");
  });

  test("renders provider and badge values without raw internal tokens", () => {
    expect(tcsProviderLabel("takosumi")).toBe("Takosumi");
    expect(tcsProviderLabel("cloudflare")).toBe("Cloudflare");
    expect(tcsProviderLabel("aws")).toBe("AWS");
    expect(tcsBadgeLabel("official", "ja")).toBe("公式");
  });
});
