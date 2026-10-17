import { expect, test } from "bun:test";

import { slugify } from "../../docs/.vitepress/slugify.ts";

test("keeps voiced kana composed, so source links match the heading id", () => {
  const id = slugify("ローカルで安全に起動して確認する");
  expect(id).toBe("ローカルで安全に起動して確認する");
  expect(id).toBe(id.normalize("NFC"));
  expect(slugify("構成を選ぶ")).toBe("構成を選ぶ");
  expect(slugify("CLI が読むもの")).toBe("cli-が読むもの");
  expect(slugify("パスワード")).toBe("パスワード");
});

test("matches VitePress for headings without voiced kana", () => {
  expect(slugify("Putting it on Cloudflare")).toBe("putting-it-on-cloudflare");
  expect(slugify("Cloudflare に置く")).toBe("cloudflare-に置く");
  expect(slugify("SourceSnapshot: ref と commit は別物")).toBe("sourcesnapshot-ref-と-commit-は別物");
  expect(slugify("Café (beta)")).toBe("cafe-beta");
  expect(slugify("2. Deploy")).toBe("_2-deploy");
  expect(slugify("Ａ　Ｂ")).toBe("a-b");
});
