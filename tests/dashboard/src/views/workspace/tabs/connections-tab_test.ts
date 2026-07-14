/**
 * Source-assertion regression tests for the Connections tab (ConnectionsTab):
 * connection tests track busy/error state PER connection id. A single shared
 * signal let concurrent tests clear each other's spinner and showed whichever
 * error finished last, attributed to nothing in particular.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../../dashboard/src/views/workspace/tabs/ConnectionsTab.tsx",
  ),
  "utf8",
);

describe("ConnectionsTab per-connection test state", () => {
  test("busy and error state are keyed by connection id", () => {
    expect(source).toContain("const [testBusyIds, setTestBusyIds]");
    expect(source).toContain("const [testErrors, setTestErrors]");
    expect(source).toContain(
      "const testBusy = (id: string) => testBusyIds().has(id);",
    );
    expect(source).toContain(
      "const testError = (id: string) => testErrors()[id] ?? null;",
    );
    // The old single-flight signals must not come back.
    expect(source).not.toContain("testBusyId()");
    expect(source).not.toContain("setTestBusyId(");
    expect(source).not.toContain("testError()");
  });

  test("runTest scopes every state write to its own connection", () => {
    expect(source).toContain("setTestBusy(id, true);");
    expect(source).toContain("setTestError(id, null);");
    expect(source).toMatch(/finally \{\s*setTestBusy\(id, false\);\s*\}/);
    // Errors render inside the owning connection's row, not one global toast.
    expect(source).toContain("<Show when={testError(connection.id)}>");
    expect(source).toContain("busy={testBusy(connection.id)}");
  });

  test("the verified hint only follows the last-created connection", () => {
    // Testing some OTHER row must not corrupt lastCreatedReady() / the
    // install-return offer for a connection that was never verified.
    expect(source).toContain(
      "const isLastCreated = lastCreatedConnectionId() === id;",
    );
    expect(source).toContain(
      "if (isLastCreated) setLastCreatedVerifiedHint(false);",
    );
    expect(source).toContain(
      "if (isLastCreated) setLastCreatedVerifiedHint(true);",
    );
    // No unconditional hint writes remain inside runTest.
    const runTestBody = source.slice(
      source.indexOf("const runTest = async"),
      source.indexOf("const remove = createAction"),
    );
    expect(runTestBody).not.toMatch(/^\s*setLastCreatedVerifiedHint\(/m);
  });

  test("remove is busy per connection row, not for the whole list", () => {
    expect(source).toContain("const [removingId, setRemovingId]");
    expect(source).toContain("setRemovingId(id);");
    expect(source).toMatch(/finally \{\s*setRemovingId\(null\);\s*\}/);
    expect(source).toContain(
      "busy={remove.busy() && removingId() === connection.id}",
    );
  });
});

describe("ConnectionsTab guided-first add flow", () => {
  test("installed recipes are the default surface; BYOK is the advanced path", () => {
    expect(source).toContain("providerSetupOptionsFromCredentialRecipes");
    expect(source).toContain("setProvider(options[0].id)");
    expect(source).not.toContain("PROVIDERS");
    expect(source).not.toContain("providerDescriptor");
    expect(source).not.toContain("tokenHelper");
    // The quiet advanced entry into the raw env editor.
    expect(source).toContain("const openByokEditor = ()");
    expect(source).toContain('t("conn.add.genericEnvOption")');
    // The old inverted IA (BYOK-first with a preset-shortcut intro) is gone.
    expect(source).not.toContain("wc-preset-intro");
    expect(source).not.toContain('t("conn.presets.body")');
    expect(source).not.toContain('t("conn.byok.backToByok")');
  });

  test("the BYOK panel heading sits at h2 under the page h1", () => {
    expect(source).toContain('<h2 class="wc-byok-title">');
    expect(source).not.toContain("<h4");
  });
});
