import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const install = read("dashboard/src/views/new/InstallView.tsx");
const connections = read(
  "dashboard/src/views/workspace/tabs/ConnectionsTab.tsx",
);

describe("/new Provider Connections return context", () => {
  test("the single install view preserves its exact return target", () => {
    expect(install).toContain("installReturnPathFromPrefill");
    expect(install).toContain("providerConnectionsHrefForInstallReturn");
    expect(install).toContain("git: gitUrl()");
    expect(install).toContain("ref: gitRef()");
    expect(install).toContain("path: modulePath()");
    expect(install).toContain("name: name()");
  });

  test("the Connections screen restores and validates that return target", () => {
    expect(connections).toContain("installReturnContext");
    expect(connections).toContain("installReturnPathFromReturnParam");
    expect(connections).toContain("INSTALL_RETURN_QUERY_PARAM");
    expect(connections).toContain("INSTALL_RETURN_STORAGE_KEY");
    expect(connections).toContain("sessionStorage");
    expect(connections).toContain('t("conn.saved.returnCta")');
  });

  test("Provider choices come only from the compatibility report", () => {
    expect(install).toContain("rowsFromCompatibility(result)");
    expect(install).toContain("result.providers");
    expect(install).toContain(
      "provider.allowed && provider.credentialRequired === true",
    );
    expect(install).not.toContain("rootModuleVariables.map");
    expect(install).not.toContain("resources.map");
  });

  test("candidate matching is verified and exact after registry qualification", () => {
    expect(install).toContain("isProviderConnectionCandidate(connection)");
    expect(install).toContain("sameProviderSource(");
    expect(install).toContain("providerConnectionMatchesProviderSource,");
    expect(install).toContain(
      "providerConnectionMatchesProviderSource(required, {",
    );
  });

  test("source credentials, bindings, and compatibility authority reach Plan", () => {
    expect(install).toContain("sourceAuthConnectionId()");
    expect(install).toContain("authConnectionId: sourceAuthConnectionId()");
    expect(install).toContain("putCapsuleProviderBindingSet(");
    expect(install).toContain("providerBindings(rows)");
    expect(install).toContain("checked.reportId");
    expect(install).toContain("compatibilityReportId: checked.reportId");
  });
});
