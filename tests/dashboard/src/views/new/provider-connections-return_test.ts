/**
 * Regression guard for the `/new` -> Provider Connections detour.
 *
 * Creating a Provider Connection happens on `/space/settings/connections`, but
 * the user must be able to return to the exact `/new?git=...&ref=...&path=...`
 * add flow afterwards. These source assertions keep the view wired to the
 * shared, validated return-context helper instead of hard-coding bare settings
 * links.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const newAppViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/new/NewAppView.tsx"),
  "utf8",
);
const connectionsTabSource = readFileSync(
  resolve(
    here,
    "../../../../../dashboard/src/views/space/tabs/ConnectionsTab.tsx",
  ),
  "utf8",
);

describe("/new Provider Connections return context", () => {
  test("all /new Provider Connections links use the return-context href", () => {
    expect(newAppViewSource).toContain("installReturnPathFromPrefill");
    expect(newAppViewSource).toContain(
      "providerConnectionsHrefForInstallReturn",
    );
    expect(newAppViewSource).toContain("const providerConnectionsHref = () =>");
    expect(newAppViewSource).not.toContain(
      'href="/space/settings/connections"',
    );
    expect(
      newAppViewSource.match(/href=\{providerConnectionsHref\(\)\}/g) ?? [],
    ).toHaveLength(4);
  });

  test("connections tab renders and preserves a safe install return target", () => {
    expect(connectionsTabSource).toContain("installReturnContext");
    expect(connectionsTabSource).toContain("installReturnPathFromReturnParam");
    expect(connectionsTabSource).toContain("INSTALL_RETURN_QUERY_PARAM");
    expect(connectionsTabSource).toContain("INSTALL_RETURN_STORAGE_KEY");
    expect(connectionsTabSource).toContain("sessionStorage");
    expect(connectionsTabSource).toContain('"conn.return.cta"');
  });

  test("connections tab refreshes ProviderConnection projections after mutations", () => {
    expect(connectionsTabSource).toContain(
      "refetch: refetchProviderConnections",
    );
    expect(connectionsTabSource).toContain("const refreshConnections = async");
    expect(
      connectionsTabSource.match(/await refreshConnections\(\)/g) ?? [],
    ).toHaveLength(3);
    expect(
      connectionsTabSource.match(
        /await afterConnectionCreated\(connection\)/g,
      ) ?? [],
    ).toHaveLength(3);
    expect(connectionsTabSource).toContain('"conn.saved.message"');
    expect(connectionsTabSource).toContain('"conn.saved.needsTest"');
    expect(connectionsTabSource).toContain('"conn.saved.testCta"');
    expect(connectionsTabSource).toContain('"conn.saved.returnCta"');
    expect(connectionsTabSource).toContain("lastCreatedReady()");
    expect(connectionsTabSource).toContain("shouldOfferInstallReturn()");
    expect(connectionsTabSource).toContain(
      "!lastCreatedConnectionId() || lastCreatedReady()",
    );
  });

  test("/new only proceeds when the compatibility report is runnable", () => {
    expect(newAppViewSource).toContain("const compatibilityRunnable = () =>");
    expect(newAppViewSource).toContain('level === "ready"');
    expect(newAppViewSource).toContain('level === "auto_capsulized"');
    expect(newAppViewSource).toContain('"new.error.notRunnable"');
  });

  test("/new retries source-sync waits by rechecking when no compatibility report exists", () => {
    expect(newAppViewSource).toContain("sourceIdFromControlError");
    expect(newAppViewSource).toContain("onSourceCreated");
    expect(newAppViewSource).toContain("const retryAfterSyncWait = () =>");
    expect(newAppViewSource).toContain("else void runCompatibilityCheck()");
  });

  test("connections tab gives form controls stable names", () => {
    expect(connectionsTabSource).toContain('name="provider"');
    expect(connectionsTabSource).toContain('name="displayName"');
    expect(connectionsTabSource).toContain('name="helperToken"');
    expect(connectionsTabSource).toContain('name="genericProvider"');
    expect(connectionsTabSource).toContain("name={`field:${field().envName}`}");
    expect(connectionsTabSource).toContain("name={`genericEnvName:${index}`}");
    expect(connectionsTabSource).toContain("name={`genericEnvValue:${index}`}");
  });
});
