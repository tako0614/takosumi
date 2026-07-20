import { describe, expect, test } from "bun:test";
import { setLocale, t } from "../../../../dashboard/src/i18n/index.ts";
import {
  operationLabel,
  providerConnectionStatusLabel,
  providerConnectionTone,
} from "../../../../dashboard/src/lib/labels.ts";

describe("provider connection labels", () => {
  test("renders current connection statuses as localized labels", () => {
    setLocale("ja");

    expect(providerConnectionStatusLabel("verified")).toBe(
      t("status.connection.verified"),
    );
    expect(providerConnectionStatusLabel("verified")).not.toBe("verified");
    expect(providerConnectionTone("verified")).toBe("ok");

    expect(providerConnectionStatusLabel("pending")).toBe(
      t("status.connection.pending"),
    );
    expect(providerConnectionTone("pending")).toBe("warn");

    expect(providerConnectionStatusLabel("revoked")).toBe(
      t("status.connection.revoked"),
    );
    // State-label honesty: a revoked connection record is NOT deleted — the
    // badge must not claim 削除. It reads 無効化済み, matching the
    // notification copy （〜が無効になりました）.
    expect(providerConnectionStatusLabel("revoked")).not.toContain("削除");
    expect(providerConnectionStatusLabel("revoked")).toContain("無効化");
    expect(providerConnectionTone("revoked")).toBe("muted");

    expect(providerConnectionStatusLabel("error")).toBe(
      t("status.connection.error"),
    );
    expect(providerConnectionTone("error")).toBe("danger");
  });

  test("keeps legacy readiness statuses for older provider records", () => {
    setLocale("en");

    expect(providerConnectionStatusLabel("ready")).toBe(
      t("status.providerConnection.ready"),
    );
    expect(providerConnectionTone("ready")).toBe("ok");
    expect(providerConnectionStatusLabel("needs_setup")).toBe(
      t("status.providerConnection.needs_setup"),
    );
    expect(providerConnectionTone("needs_setup")).toBe("warn");
  });
});

describe("run operation labels", () => {
  test("maps internal Activity operations (create/update/destroy) — never 操作", () => {
    setLocale("ja");
    // Activity metadata records the INTERNAL plan operation, not the §19
    // RunType; feeds interpolate it into 「{operation}の準備ができました」etc.
    expect(operationLabel("create")).toBe(t("op.create"));
    expect(operationLabel("update")).toBe(t("op.update"));
    expect(operationLabel("destroy")).toBe(t("op.destroy_apply"));
    expect(operationLabel("create")).not.toBe(t("op.generic"));
    expect(operationLabel("update")).not.toBe(t("op.generic"));
    expect(operationLabel("destroy")).not.toBe(t("op.generic"));
    // §19 run types stay mapped.
    expect(operationLabel("plan")).toBe(t("op.plan"));
    expect(operationLabel("compatibility_check")).toBe(
      t("op.compatibility_check"),
    );
    expect(operationLabel("source_sync")).toBe(t("op.source_sync"));
    expect(operationLabel("artifact")).toBe(t("op.artifact"));
    // Unknown tokens still degrade to the neutral noun, not raw snake_case.
    expect(operationLabel("mystery_op")).toBe(t("op.generic"));
  });
});
