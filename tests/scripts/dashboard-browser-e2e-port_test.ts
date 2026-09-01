import { expect, test } from "bun:test";
import {
  DEFAULT_PORTABLE_E2E_PORT,
  explicitPortableE2EPort,
  pickFreePort,
  PortableE2EPortError,
  portableE2EPort,
  resolvePortableE2EPort,
} from "../../scripts/dashboard-browser-e2e/port.ts";

test("an explicit port wins and an invalid one fails closed", () => {
  expect(explicitPortableE2EPort({ TAKOSUMI_E2E_PORT: "5123" })).toBe(5123);
  expect(explicitPortableE2EPort({})).toBeUndefined();
  expect(explicitPortableE2EPort({ TAKOSUMI_E2E_PORT: "  " })).toBeUndefined();
  expect(() => explicitPortableE2EPort({ TAKOSUMI_E2E_PORT: "0" })).toThrow(
    PortableE2EPortError,
  );
  expect(() => explicitPortableE2EPort({ TAKOSUMI_E2E_PORT: "70000" })).toThrow(
    PortableE2EPortError,
  );
  expect(() => explicitPortableE2EPort({ TAKOSUMI_E2E_PORT: "http" })).toThrow(
    PortableE2EPortError,
  );
});

test("readers fall back to the historical default", () => {
  expect(portableE2EPort({})).toBe(DEFAULT_PORTABLE_E2E_PORT);
  expect(portableE2EPort({ TAKOSUMI_E2E_PORT: "5123" })).toBe(5123);
});

test("the launcher publishes a free port for its child processes", async () => {
  const env: Record<string, string | undefined> = {};
  const port = await resolvePortableE2EPort(env);

  expect(port).toBeGreaterThan(0);
  expect(env.TAKOSUMI_E2E_PORT).toBe(String(port));
  // Every reader in the run now agrees with the launcher.
  expect(portableE2EPort(env)).toBe(port);
});

test("two launches in the same host do not collide", async () => {
  const first = await pickFreePort();
  const server = Bun.serve({ port: first, fetch: () => new Response("") });
  try {
    const second = await pickFreePort();
    expect(second).not.toBe(first);
  } finally {
    await server.stop(true);
  }
});

test("an explicit port is not replaced by a picked one", async () => {
  const env: Record<string, string | undefined> = {
    TAKOSUMI_E2E_PORT: "5123",
  };
  expect(await resolvePortableE2EPort(env)).toBe(5123);
  expect(env.TAKOSUMI_E2E_PORT).toBe("5123");
});
