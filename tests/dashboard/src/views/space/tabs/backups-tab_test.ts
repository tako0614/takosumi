import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../dashboard/src/i18n/ja.ts";

const sourcePath = resolve(
  import.meta.dir,
  "../../../../../../dashboard/src/views/space/tabs/BackupsTab.tsx",
);

test("BackupsTab keeps storage object details folded out of the default table", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain('"backups.col.contents"');
  expect(source).toContain('"backups.col.source"');
  expect(source).toContain('<summary>{t("common.details")}</summary>');
  expect(source).toContain("shortDigest(backup.digest)");
  expect(source).toContain("backup.objectKey");
  expect(source).toContain("backup.createdByRunId");
  expect(source).not.toContain('header: t("backups.col.artifact")');
  expect(source).not.toContain('header: t("backups.col.serviceData")');
  expect(source).not.toContain('header: t("backups.col.run")');
  expect(en["backups.col.contents"]).toBe("Contents");
  expect(ja["backups.col.contents"]).toBe("内容");
});
