/**
 * Source-assertion regression tests for the Shares tab (SharesTab). Revoking
 * an output share cuts off a consumer Workspace immediately, so the danger
 * action must go through the shared confirm dialog naming the target.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../dashboard/src/i18n/ja.ts";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../../dashboard/src/views/workspace/tabs/SharesTab.tsx",
  ),
  "utf8",
);

describe("SharesTab revoke confirmation", () => {
  test("revoke goes through the shared confirm dialog, naming the target", () => {
    expect(source).toContain("useConfirmDialog");
    expect(source).toContain(
      "const confirmRevoke = async (share: OutputShare)",
    );
    expect(source).toContain('t("shares.revokeConfirmTitle")');
    expect(source).toContain('t("shares.revokeConfirmMessage"');
    // The message names the receiving workspace (handle when known, id else).
    expect(source).toContain("target: workspaceName().get(to) ?? to");
    expect(source).toMatch(/danger: true,\s*\}\);\s*if \(!ok\) return;/);
    // The row button opens the confirm — never fires revoke.run directly.
    expect(source).toContain("void confirmRevoke(share)");
    expect(source).not.toContain("onClick={() => void revoke.run(share.id)}");
  });

  test("confirm copy exists in both locales with the {target} placeholder", () => {
    expect(en["shares.revokeConfirmMessage"]).toContain("{target}");
    expect(ja["shares.revokeConfirmMessage"]).toContain("{target}");
    expect(ja["shares.revokeConfirmTitle"]).toBe("共有の取り消し");
    expect(en["shares.revokeConfirmTitle"]).toBe("Revoke share");
  });
});
