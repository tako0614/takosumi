import { expect, test } from "bun:test";

import {
  firstParagraphText,
  joinsWithoutSpace,
  joinWrappedLines,
  removeWideSoftBreaks,
} from "../../docs/.vitepress/wrapped-lines.ts";

test("joins Japanese wraps without a space and keeps spaces next to Latin words", () => {
  expect(joinsWithoutSpace("を", "あ")).toBe(true);
  expect(joinsWithoutSpace("。", "T")).toBe(true);
  expect(joinsWithoutSpace("、", "s")).toBe(true);
  expect(joinsWithoutSpace("た", "c")).toBe(false);
  expect(joinsWithoutSpace("t", "あ")).toBe(false);
  expect(joinsWithoutSpace("s", "t")).toBe(false);
  expect(joinsWithoutSpace("e", "（")).toBe(true);
  expect(joinsWithoutSpace("証", "・")).toBe(true);
  expect(joinsWithoutSpace("々", "p")).toBe(false);
  expect(joinsWithoutSpace("s", "—")).toBe(false);
  expect(joinsWithoutSpace("", "あ")).toBe(false);

  expect(joinWrappedLines(["実行者を", "あとから追える", "commit と", "state"])).toBe(
    "実行者をあとから追える commit と state",
  );
});

test("removes soft breaks between wide characters, looking through inline markup", () => {
  const tokens = [
    { type: "text", content: "計画" },
    { type: "strong_close", content: "" },
    { type: "softbreak", content: "" },
    { type: "text", content: "の順で" },
    { type: "softbreak", content: "" },
    { type: "code_inline", content: "plan" },
    { type: "softbreak", content: "" },
    { type: "text", content: "と" },
    { type: "softbreak", content: "" },
    { type: "html_inline", content: "<br>" },
  ];

  removeWideSoftBreaks(tokens);

  expect(tokens.map(({ type }) => type)).toEqual([
    "text",
    "strong_close",
    "text",
    "softbreak",
    "code_inline",
    "softbreak",
    "text",
    "softbreak",
    "html_inline",
  ]);
});

test("describes a page with its whole first paragraph", () => {
  const markdown = [
    "---",
    "title: x",
    "---",
    "# Takosumi",
    "",
    "Takosumi は、Git に置いた module を、**計画 → 確認 → 反映**の",
    "順で実行します。実行者を",
    "[あとから](./a.md)追える形で保存します。",
    "",
    "次の段落。",
  ].join("\n");

  expect(firstParagraphText(markdown)).toBe(
    "Takosumi は、Git に置いた module を、計画 → 確認 → 反映の順で実行します。実行者をあとから追える形で保存します。",
  );
  expect(firstParagraphText("Runs modules through\na plan workflow.")).toBe(
    "Runs modules through a plan workflow.",
  );
  expect(firstParagraphText("# Only a heading\n")).toBeUndefined();
});

test("drops block markers and stops at the next block", () => {
  expect(
    firstParagraphText("> Takosumi OSS は現在、Git\n> の module を扱います。\n\n本文"),
  ).toBe("Takosumi OSS は現在、Git の module を扱います。");
  expect(firstParagraphText("説明します。\n- 一つ目\n- 二つ目")).toBe(
    "説明します。",
  );
  expect(firstParagraphText("```bash\nnpm i\n```\n\nlocal_compose を使います。")).toBe(
    "local_compose を使います。",
  );
});

test("ends a long description at the last full sentence that fits", () => {
  const sentence = "あ".repeat(90) + "。";
  expect(firstParagraphText(sentence.repeat(3))).toBe(sentence.repeat(2));
  expect(firstParagraphText("い".repeat(250))).toBe(`${"い".repeat(199)}…`);
  expect(firstParagraphText(`短い。${"う".repeat(250)}`)).toBe(
    `短い。${"う".repeat(196)}…`,
  );

  const english = `${"word ".repeat(39)}ends. Next ${"word ".repeat(20)}`;
  expect(firstParagraphText(english)).toBe(`${"word ".repeat(39)}ends.`);
  const abbreviated = `Use e.g. the dashboard /install?git=... ${"word ".repeat(45)}`;
  expect(firstParagraphText(abbreviated)).toBe(
    `Use e.g. the dashboard /install?git=... ${"word ".repeat(31)}word…`,
  );
});
