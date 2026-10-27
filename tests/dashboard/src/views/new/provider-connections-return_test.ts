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
  test("the single install view embeds connection setup without serializing configuration", () => {
    expect(install).toContain("<ConnectionsTab");
    expect(install).toContain("embedded initialProviderSource");
    expect(install).toContain("refreshProviderChoices()");
    expect(install).not.toContain("providerConnectionsHrefForInstallReturn");
    expect(install).not.toContain("sessionStorage");
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
    expect(install).toContain("result.rootProviderRequirements");
    expect(install).not.toContain("result.providerPackages");
    expect(install).toContain(
      "provider.credentialRequired === true",
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
    expect(install).toContain("createReviewableGitInstallPlan(");
    expect(install).toContain("providerBindings: rows.map");
    expect(install).not.toContain("putCapsuleProviderBindingSet(");
    expect(install).not.toContain("createCapsule(");
    expect(install).toContain("checked.reportId");
    expect(install).toContain("compatibilityReportId: checked.reportId");
  });
});
