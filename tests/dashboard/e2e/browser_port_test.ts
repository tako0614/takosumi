import { expect, test } from "bun:test";
import {
  dashboardBrowserOrigin,
  DEFAULT_DASHBOARD_BROWSER_PORT,
  resolveDashboardBrowserPort,
  resolveDashboardBrowserPortForMode,
} from "./browser-port.ts";

test("uses the default local dashboard browser port", () => {
  expect(resolveDashboardBrowserPort({})).toBe(DEFAULT_DASHBOARD_BROWSER_PORT);
  expect(dashboardBrowserOrigin({})).toBe("http://127.0.0.1:4179");
});

test("resolves an explicit dashboard browser port as a local origin", () => {
  const environment = { TAKOSUMI_DASHBOARD_BROWSER_PORT: "4191" };
  expect(resolveDashboardBrowserPort(environment)).toBe(4191);
  expect(dashboardBrowserOrigin(environment)).toBe("http://127.0.0.1:4191");
});

test("rejects invalid dashboard browser ports", () => {
  for (const value of ["0", "65536", "42.5", "not-a-port"]) {
    expect(() =>
      resolveDashboardBrowserPort({ TAKOSUMI_DASHBOARD_BROWSER_PORT: value }),
    ).toThrow(/TAKOSUMI_DASHBOARD_BROWSER_PORT/);
  }
});

test("only portable mode resolves the dashboard browser port", () => {
  const environment = {
    TAKOSUMI_DASHBOARD_BROWSER_PORT: "not-a-port",
    TAKOSUMI_E2E_BASE_URL: "https://dashboard.example.test",
  };

  expect(() =>
    resolveDashboardBrowserPortForMode("portable", environment),
  ).toThrow(/TAKOSUMI_DASHBOARD_BROWSER_PORT/);
  expect(resolveDashboardBrowserPortForMode("live", environment)).toBeUndefined();
  expect(
    resolveDashboardBrowserPortForMode("public-live", environment),
  ).toBeUndefined();
});
