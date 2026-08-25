import { expect, test } from "bun:test";

import {
  createDocsBrowserConfig,
  DEFAULT_DOCS_BROWSER_PORT,
  resolveDocsBrowserPort,
} from "../../docs/.vitepress/playwright.config.ts";

test("uses the default docs browser port when no override is provided", () => {
  expect(resolveDocsBrowserPort({})).toBe(DEFAULT_DOCS_BROWSER_PORT);

  const config = createDocsBrowserConfig({});
  const project = config.projects?.find(({ name }) => name === "docs-mobile");

  expect(project?.use?.baseURL).toBe("http://127.0.0.1:4180");
  expect(config.webServer).toMatchObject({
    command: expect.stringContaining("--port 4180"),
    url: "http://127.0.0.1:4180/docs/",
  });
});

test("accepts an explicit docs browser port override", () => {
  expect(
    resolveDocsBrowserPort({ TAKOSUMI_DOCS_BROWSER_PORT: "4280" }),
  ).toBe(4280);

  const config = createDocsBrowserConfig({
    TAKOSUMI_DOCS_BROWSER_PORT: "4280",
  });
  const project = config.projects?.find(({ name }) => name === "docs-mobile");

  expect(project?.use?.baseURL).toBe("http://127.0.0.1:4280");
  expect(config.webServer).toMatchObject({
    command: expect.stringContaining("--port 4280"),
    url: "http://127.0.0.1:4280/docs/",
  });
});

test("rejects invalid docs browser port overrides", () => {
  for (const value of ["0", "65536", "42.5", "not-a-port"]) {
    expect(() =>
      resolveDocsBrowserPort({ TAKOSUMI_DOCS_BROWSER_PORT: value }),
    ).toThrow(/TAKOSUMI_DOCS_BROWSER_PORT/);
  }
});
