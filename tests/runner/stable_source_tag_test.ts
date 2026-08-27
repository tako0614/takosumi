import { expect, test } from "bun:test";

import { resolveHighestStableSemverTag } from "../../runner/entrypoint.ts";

test("stable tag resolver chooses the highest release and peels annotated tags", () => {
  const tag = resolveHighestStableSemverTag(`
1111111111111111111111111111111111111111 refs/tags/v1.2.3
2222222222222222222222222222222222222222 refs/tags/v1.2.3^{}
3333333333333333333333333333333333333333 refs/tags/2.0.0-rc.1
4444444444444444444444444444444444444444 refs/tags/1.12.0
`);
  expect(tag).toEqual({
    tag: "1.12.0",
    commit: "4444444444444444444444444444444444444444",
  });

  expect(
    resolveHighestStableSemverTag(
      "1111111111111111111111111111111111111111 refs/tags/v1.2.3\n2222222222222222222222222222222222222222 refs/tags/v1.2.3^{}\n",
    ),
  ).toEqual({
    tag: "v1.2.3",
    commit: "2222222222222222222222222222222222222222",
  });
});

test("stable tag resolver fails when a normalized version is ambiguous", () => {
  expect(() =>
    resolveHighestStableSemverTag(
      "1111111111111111111111111111111111111111 refs/tags/v1.2.3\n2222222222222222222222222222222222222222 refs/tags/1.2.3\n",
    ),
  ).toThrow(/ambiguous.*1\.2\.3.*v1\.2\.3/u);
  expect(() => resolveHighestStableSemverTag("")).toThrow(
    /no stable SemVer tag/u,
  );
  expect(() =>
    resolveHighestStableSemverTag(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/tags/v2.0.0\n1111111111111111111111111111111111111111 refs/tags/v1.2.3\n2222222222222222222222222222222222222222 refs/tags/1.2.3\n",
    ),
  ).toThrow(/ambiguous.*1\.2\.3.*v1\.2\.3/u);
});
