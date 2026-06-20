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
    ).toHaveLength(3);
  });

  test("connections tab renders and preserves a safe install return target", () => {
    expect(connectionsTabSource).toContain("installReturnContext");
    expect(connectionsTabSource).toContain("installReturnPathFromReturnParam");
    expect(connectionsTabSource).toContain("INSTALL_RETURN_QUERY_PARAM");
    expect(connectionsTabSource).toContain("INSTALL_RETURN_STORAGE_KEY");
    expect(connectionsTabSource).toContain("sessionStorage");
    expect(connectionsTabSource).toContain('"conn.return.cta"');
  });

  test("connections tab gives form controls stable names", () => {
    expect(connectionsTabSource).toContain('name="provider"');
    expect(connectionsTabSource).toContain('name="displayName"');
    expect(connectionsTabSource).toContain('name="helperToken"');
    expect(connectionsTabSource).toContain('name="genericProvider"');
    expect(connectionsTabSource).toContain("name={`field:${field().envName}`}");
    expect(connectionsTabSource).toContain(
      "name={`genericEnvName:${index}`}",
    );
    expect(connectionsTabSource).toContain(
      "name={`genericEnvValue:${index}`}",
    );
  });
});
