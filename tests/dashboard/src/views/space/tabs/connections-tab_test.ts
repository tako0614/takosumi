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
});
