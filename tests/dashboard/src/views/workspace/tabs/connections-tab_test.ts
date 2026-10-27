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
// The add flow is the extracted ConnectionCreateForm the tab renders.
const formSource = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../../dashboard/src/views/workspace/connections/ConnectionCreateForm.tsx",
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
    expect(source).toContain("<ConnectionCreateForm");
    expect(formSource).toContain("providerSetupOptionsFromCredentialRecipes");
    expect(formSource).toContain("setProvider(options[0].id)");
    for (const current of [source, formSource]) {
      expect(current).not.toContain("PROVIDERS");
      expect(current).not.toContain("providerDescriptor");
      expect(current).not.toContain("tokenHelper");
      // The old inverted IA (BYOK-first with a preset-shortcut intro) is gone.
      expect(current).not.toContain("wc-preset-intro");
      expect(current).not.toContain('t("conn.presets.body")');
      expect(current).not.toContain('t("conn.byok.backToByok")');
    }
    // The quiet advanced entry into the raw env editor.
    expect(formSource).toContain("const openByokEditor = ()");
    expect(formSource).toContain('t("conn.add.genericEnvOption")');
  });

  test("the BYOK panel heading sits at h2 under the page h1", () => {
    expect(formSource).toContain('<h2 class="wc-byok-title">');
    expect(formSource).not.toContain("<h4");
    expect(source).not.toContain("<h4");
  });
});

describe("ConnectionsTab create-form wiring", () => {
  test("the tab shares one recipe read and owns post-create state", () => {
    expect(source).toContain("setupCatalog={credentialRecipes}");
    expect(source).toContain("initialProviderSource={props.initialProviderSource}");
    expect(source).toContain("onCreated={afterConnectionCreated}");
    expect(source).toContain("verifyConnection={verifyCreatedConnection}");
    // The first test still runs through the tab's per-connection runTest,
    // even when the form closed itself in onCreated; only unmount skips it.
    expect(source).toMatch(
      /const verifyCreatedConnection = async \(id: string\) => \{\s*if \(!disposed\) await runTest\(id\);\s*\};/,
    );
    // The form never gates the callbacks on its own open/mounted state.
    const saved = formSource.slice(
      formSource.indexOf("const connectionSaved = async"),
      formSource.indexOf("const connectOAuth = async"),
    );
    expect(saved).toContain("await props.onCreated(connection);");
    expect(saved).toContain("await props.verifyConnection(connection.id);");
    expect(saved).not.toContain("disposed");
  });

  test("typed-credential paths verify; the OAuth path arrives checked", () => {
    expect(formSource.match(/await connectionSaved\(connection, true\);/g)).toHaveLength(2);
    expect(formSource).toContain("await connectionSaved(connection, false);");
    expect(formSource).toContain("connectProviderWithPopup");
    expect(source).not.toContain("connectProviderWithPopup");
  });

  test("the OAuth callback relay stays on the Connections route", () => {
    expect(source).toContain("takosumi.oauth.${flow}");
    expect(formSource).not.toContain("connection_flow");
  });
});
