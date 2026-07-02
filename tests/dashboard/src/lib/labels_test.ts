import { describe, expect, test } from "bun:test";
import { setLocale, t } from "../../../../dashboard/src/i18n/index.ts";
import {
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
    expect(providerConnectionStatusLabel("revoked")).not.toContain("無効");
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
