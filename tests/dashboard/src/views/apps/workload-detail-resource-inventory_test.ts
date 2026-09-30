import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const viewSource = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../dashboard/src/views/apps/WorkloadDetailView.tsx",
  ),
  "utf8",
);
const apiSource = readFileSync(
  resolve(import.meta.dir, "../../../../../dashboard/src/lib/control-api.ts"),
  "utf8",
);

test("Workload detail presents current recorded resources as a read-only disclosure", () => {
  expect(apiSource).toContain("current-resource-inventory");
  expect(viewSource).toContain("DeployedResourcesDisclosure");
  expect(viewSource).toContain('t("app.deploys.inventoryRecordedNote")');
  expect(en["app.deploys.inventoryRecordedNote"]).toContain(
    "not live health",
  );
  expect(ja["app.deploys.inventoryRecordedNote"]).toContain(
    "ライブ稼働状態ではありません",
  );
  expect(viewSource).toContain('t("app.deploys.inventoryLegacyUnavailable")');
  expect(viewSource).toContain('t("app.deploys.inventoryEmpty")');
  expect(viewSource).not.toContain("deleteResource");
  expect(viewSource).not.toContain("importResource");
});

test("recovered state inventory is explicitly unknown, not an applied resource list", () => {
  expect(viewSource).toContain('availability === "recovery_unknown"');
  expect(viewSource).toContain('t("app.deploys.inventoryRecoveryUnknownTitle")');
  expect(viewSource).toContain('t("app.deploys.inventoryRecoveryUnknownNote")');
  expect(viewSource).toContain('availability !== "recovery_unknown"');
  expect(ja["app.deploys.inventoryRecoveryUnknownNote"]).toContain(
    "元のデプロイは失敗したまま",
  );
  expect(en["app.deploys.inventoryRecoveryUnknownNote"]).toContain(
    "original deploy remains failed",
  );
  expect(en["app.deploys.inventoryRecoveryUnknownNote"]).toContain(
    "not been verified",
  );
});
