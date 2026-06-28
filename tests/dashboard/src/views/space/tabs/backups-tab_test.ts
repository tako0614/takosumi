import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../dashboard/src/i18n/ja.ts";

const sourcePath = resolve(
  import.meta.dir,
  "../../../../../../dashboard/src/views/workspace/tabs/BackupsTab.tsx",
);

test("BackupsTab keeps storage object details out of the user-facing table", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain('"backups.col.contents"');
  expect(source).not.toContain('t("backups.col.source")');
  expect(source).not.toContain('<summary>{t("common.details")}</summary>');
  expect(source).not.toContain("shortDigest");
  expect(source).not.toContain("backup.digest");
  expect(source).not.toContain("backup.objectKey");
  expect(source).not.toContain("data().objectKey");
  expect(source).not.toContain('"backups.detail.id"');
  expect(source).not.toContain("backup.createdByRunId");
  expect(source).not.toContain("backup.serviceData");
  expect(source).not.toContain('header: t("backups.col.artifact")');
  expect(source).not.toContain('header: t("backups.col.serviceData")');
  expect(source).not.toContain('header: t("backups.col.run")');
  expect(en["backups.col.contents"]).toBe("Contents");
  expect(ja["backups.col.contents"]).toBe("内容");
});
