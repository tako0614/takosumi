import { expect, spyOn, test } from "bun:test";

import {
  createTrustedNativeClientsEnvReader,
  parseTrustedNativeClientsEnv,
  TRUSTED_NATIVE_CLIENTS_ENV,
  trustedNativeClientsFromEnv,
} from "../../../../accounts/service/src/trusted-native-clients.ts";
import {
  DEFAULT_TRUSTED_NATIVE_CLIENTS,
  parseInterfaceClients,
  RESERVED_DEFAULT_NATIVE_CLIENTS,
} from "../../../../contract/interface-clients.ts";
import { parseEnv } from "../../../../deploy/node-postgres/src/handler.ts";

const ENTRY = {
  id: "chat-mobile",
  name: "Chat",
  android: {
    package: "com.example.chat",
    schemes: ["chat"],
    appLinkHosts: [],
    templates: ["chat://connect?server={origin}"],
  },
};

/** Values that must verify nothing, each carrying a marker that must never be logged. */
const MALFORMED = [
  [{ problem: "invalid_json" }, "{\"private-marker\""],
  [{ problem: "invalid_entries", path: "list" }, "{\"private-marker\":1}"],
  [{ problem: "invalid_entries", path: "[0]" }, JSON.stringify([{ ...ENTRY, "private-marker": 1 }])],
  [{ problem: "invalid_entries", path: "[0].name" }, JSON.stringify([{ ...ENTRY, name: "private-marker\u202E" }])],
  [{ problem: "invalid_entries", path: "[0].android.package" }, JSON.stringify([{ ...ENTRY, android: { ...ENTRY.android, package: "com.takosumi" } }])],
  [{ problem: "invalid_entries", path: "[0].android.templates" }, JSON.stringify([{ ...ENTRY, android: { ...ENTRY.android, templates: ["private-marker://connect"] } }])],
] as const;

test("unset or blank keeps the built-in first-party clients", () => {
  expect(TRUSTED_NATIVE_CLIENTS_ENV).toBe("TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS");
  expect(parseTrustedNativeClientsEnv()).toEqual({ clients: DEFAULT_TRUSTED_NATIVE_CLIENTS });
  expect(parseTrustedNativeClientsEnv("  ").clients).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
});

test("a JSON array replaces the built-in list, and [] trusts none", () => {
  const valid = parseTrustedNativeClientsEnv(JSON.stringify([ENTRY]));
  expect(valid.problem).toBeUndefined();
  expect(valid.clients.map((entry) => entry.id)).toEqual(["chat-mobile"]);
  expect(parseTrustedNativeClientsEnv("[]")).toEqual({ clients: [] });
});

test("a malformed value verifies nothing, keeps the built-in clients reserved, and never throws", () => {
  for (const [expected, value] of MALFORMED) {
    expect(parseTrustedNativeClientsEnv(value), value).toEqual({
      clients: RESERVED_DEFAULT_NATIVE_CLIENTS,
      ...expected,
    });
  }
  // A Wrangler var written as a JSON array or object reaches env as a value, not a string.
  for (const value of [[ENTRY], { id: "x" }, 1, true]) {
    expect(() => parseTrustedNativeClientsEnv(value)).not.toThrow();
    expect(parseTrustedNativeClientsEnv(value)).toEqual({
      clients: RESERVED_DEFAULT_NATIVE_CLIENTS,
      problem: "not_a_string",
    });
  }
});

test("reserved-only built-in clients verify nothing and stay unborrowable", () => {
  const options = { surfaceUrl: "https://chat.example.test/", trustedClients: RESERVED_DEFAULT_NATIVE_CLIENTS };
  // The first-party identity and template no longer verify; as unverified, the
  // reserved scheme is refused, so the platform is dropped.
  expect(
    parseInterfaceClients(
      { android: { package: "com.yurucommu", open: "yurucommu://connect?host_url={origin}" } },
      options,
    ),
  ).toBeUndefined();
  const other = parseInterfaceClients(
    { android: { name: "Yurucommu", package: "org.example.other", open: "other://open" } },
    options,
  );
  expect(other?.android?.verified).toBe(false);
  expect(other?.android?.name).toBeUndefined();
  expect(other?.preferred).toBe("web");
});

test("a reader logs one structured error per malformed value, with its field but not its contents", () => {
  const lines: string[] = [];
  const read = createTrustedNativeClientsEnvReader((line) => lines.push(line));
  for (const [, value] of MALFORMED) {
    expect(read(value)).toBe(RESERVED_DEFAULT_NATIVE_CLIENTS);
    expect(read(value)).toBe(RESERVED_DEFAULT_NATIVE_CLIENTS);
  }
  expect(lines).toHaveLength(MALFORMED.length);
  expect(lines.map((line) => JSON.parse(line))).toEqual(
    MALFORMED.map(([expected]) => ({
      level: "error",
      event: "trusted_native_clients_config_invalid",
      setting: TRUSTED_NATIVE_CLIENTS_ENV,
      problem: expected.problem,
      ...("path" in expected ? { field: expected.path } : {}),
      effect: "no_native_client_verified",
    })),
  );
  expect(lines.join("\n")).not.toContain("private-marker");
  // Valid and absent values keep working and log nothing more.
  expect(read(JSON.stringify([ENTRY])).map((entry) => entry.id)).toEqual(["chat-mobile"]);
  expect(read(undefined)).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
  expect(lines).toHaveLength(MALFORMED.length);
});

test("a reader parses each distinct value once and logs nothing for valid values", () => {
  const lines: string[] = [];
  const read = createTrustedNativeClientsEnvReader((line) => lines.push(line));
  const raw = JSON.stringify([ENTRY]);
  const first = read(raw);
  expect(read(raw)).toBe(first);
  expect(read(undefined)).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
  expect(read("[]")).toEqual([]);
  expect(lines).toEqual([]);
});

test("a throwing logger never escapes the reader", () => {
  const read = createTrustedNativeClientsEnvReader(() => {
    throw new Error("log sink down");
  });
  expect(read("{")).toBe(RESERVED_DEFAULT_NATIVE_CLIENTS);
  expect(read([ENTRY])).toBe(RESERVED_DEFAULT_NATIVE_CLIENTS);
});

test("the shared reader logs to console.error exactly once for a repeated malformed value", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let index = 0; index < 3; index += 1) {
      expect(trustedNativeClientsFromEnv("[{\"id\":\"service-test-marker\"}]")).toBe(RESERVED_DEFAULT_NATIVE_CLIENTS);
    }
    const lines = error.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("trusted_native_clients_config_invalid"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("service-test-marker");
    expect(trustedNativeClientsFromEnv(undefined)).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
  } finally {
    error.mockRestore();
  }
});

test("node-postgres starts with absent, valid and malformed trusted client lists", () => {
  const env = {
    TAKOSUMI_ACCOUNTS_DATABASE_URL: "postgres://takosumi@localhost:5432/accounts",
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
  };
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(parseEnv(env).trustedNativeClients).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
    expect(
      parseEnv({ ...env, TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS: JSON.stringify([ENTRY]) })
        .trustedNativeClients.map((entry) => entry.id),
    ).toEqual(["chat-mobile"]);
    expect(
      parseEnv({ ...env, TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS: "[{\"id\":\"node-postgres-marker\"}]" })
        .trustedNativeClients,
    ).toBe(RESERVED_DEFAULT_NATIVE_CLIENTS);
    const lines = error.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("trusted_native_clients_config_invalid"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("node-postgres-marker");
  } finally {
    error.mockRestore();
  }
});
