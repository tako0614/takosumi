import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const sheet = read("dashboard/src/views/new/InstallSheet.tsx");
const view = read("dashboard/src/views/new/InstallView.tsx");
const controller = read("dashboard/src/views/new/use-install-attempt.ts");
const connections = read(
  "dashboard/src/views/workspace/tabs/ConnectionsTab.tsx",
);

describe("/new Provider Connections return context", () => {
  test("the install sheet embeds connection setup without serializing configuration", () => {
    expect(sheet).not.toContain("<ConnectionsTab");
    expect(sheet).toContain("<ConnectionCreateForm");
    expect(sheet).toContain("initialProviderSource={requirement().provider}");
    expect(sheet).toContain("attempt().adoptConnection(requirement, connectionId)");
    for (const source of [sheet, view, controller]) {
      expect(source).not.toContain("providerConnectionsHrefForInstallReturn");
      expect(source).not.toContain("sessionStorage");
      expect(source).not.toContain("localStorage");
    }
  });

  test("the Connections screen restores and validates that return target", () => {
    expect(connections).toContain("installReturnContext");
    expect(connections).toContain("installReturnPathFromReturnParam");
    expect(connections).toContain("INSTALL_RETURN_QUERY_PARAM");
    expect(connections).toContain("INSTALL_RETURN_STORAGE_KEY");
    expect(connections).toContain("sessionStorage");
    expect(connections).toContain('t("conn.saved.returnCta")');
  });

  test("provider rows and their candidates come only from the coordinator", () => {
    // The page does no compatibility analysis or connection matching itself:
    // the rows are the coordinator's sheet, with the person's later choices
    // applied on top.
    expect(sheet).toContain("const rows = () => props.attempt.connectionRows();");
    expect(controller).toContain("withConnectionOverrides(retained.connections, overrides())");
    expect(sheet).toContain("requirement().candidates");
    for (const source of [sheet, view, controller]) {
      expect(source).not.toContain("listProviderConnections");
      expect(source).not.toContain("isProviderConnectionCandidate");
      expect(source).not.toContain("rootProviderRequirements");
      expect(source).not.toContain("checkCapsuleCompatibility");
    }
  });

  test("a chosen connection is answered as the exact provider tuple", () => {
    expect(controller).toContain(
      "providerBindings: bindingsWith(current.userAction.connections, requirement, connectionId)",
    );
    // A connection made in the sheet is chosen only once the coordinator offers it.
    const adopt = controller.slice(
      controller.indexOf("const adoptConnection = async"),
      controller.indexOf("/** The name the install uses now"),
    );
    expect(adopt).toContain("await refresh()");
    expect(adopt).toContain('return "not_offered"');
  });

  test("source credentials reach the attempt by reference only", () => {
    expect(view).toContain("authConnectionId: sourceAuth()");
    expect(view).not.toContain("createSource(");
    expect(view).not.toContain("putCapsuleProviderBindingSet(");
  });
});
