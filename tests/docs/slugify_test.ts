import { expect, test } from "bun:test";

import { slugify } from "../../docs/.vitepress/slugify.ts";

test("keeps voiced kana composed, so source links match the heading id", () => {
  const id = slugify("ローカルで安全に起動して確認する");
  expect(id).toBe("ローカルで安全に起動して確認する");
  expect(id).toBe(id.normalize("NFC"));
  expect(slugify("構成を選ぶ")).toBe("構成を選ぶ");
  expect(slugify("CLI が読むもの")).toBe("cli-が読むもの");
  expect(slugify("パスワード")).toBe("パスワード");
  // NFC also recomposes Hangul, which VitePress leaves as jamo.
  expect(slugify("\uac01")).toBe("\uac01");
});

// Expected values are the output of VitePress's own slugify (vitepress
// dist/node chunk, `const slugify = (str) => ...`) for titles that do not
// recompose.
test("matches VitePress for headings that do not recompose", () => {
  const cases: [string, string][] = [
    ["Putting it on Cloudflare", "putting-it-on-cloudflare"],
    ["Cloudflare に置く", "cloudflare-に置く"],
    ["SourceSnapshot: ref と commit は別物", "sourcesnapshot-ref-と-commit-は別物"],
    ["Café (beta)", "cafe-beta"],
    ["2. Deploy", "_2-deploy"],
    ["\uff21\u3000\uff22", "a-b"],
    ["a\\b", "a-b"],
    ["TAKOSUMI_ENV — 値", "takosumi-env-—-値"],
    ["\u201cquoted\u201d \u2018x\u2019", "quoted-x"],
  ];
  for (const [title, id] of cases) {
    expect(slugify(title)).toBe(id);
  }
});
