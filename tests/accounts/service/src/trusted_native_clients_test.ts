import { expect, spyOn, test } from "bun:test";

import {
  createTrustedNativeClientsEnvReader,
  parseTrustedNativeClientsEnv,
  TRUSTED_NATIVE_CLIENTS_ENV,
  trustedNativeClientsFromEnv,
} from "../../../../accounts/service/src/trusted-native-clients.ts";
import { DEFAULT_TRUSTED_NATIVE_CLIENTS } from "../../../../contract/interface-clients.ts";
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

/** Values that must trust none, each carrying a marker that must never be logged. */
const MALFORMED = [
  ["invalid_json", "{\"private-marker\""],
  ["invalid_entries", "{\"private-marker\":1}"],
  ["invalid_entries", JSON.stringify([{ ...ENTRY, "private-marker": 1 }])],
  ["invalid_entries", JSON.stringify([{ ...ENTRY, android: { ...ENTRY.android, package: "com.takosumi" }, name: "private-marker" }])],
  ["invalid_entries", JSON.stringify([{ ...ENTRY, android: { ...ENTRY.android, templates: ["private-marker://connect"] } }])],
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

test("a malformed value trusts none, never the defaults, and never throws", () => {
  for (const [problem, value] of MALFORMED) {
    expect(parseTrustedNativeClientsEnv(value), value).toEqual({ clients: [], problem });
  }
});

test("a reader logs one structured error for a malformed value, without its contents", () => {
  const lines: string[] = [];
  const read = createTrustedNativeClientsEnvReader((line) => lines.push(line));
  for (const [, value] of MALFORMED) {
    expect(read(value)).toEqual([]);
    expect(read(value)).toEqual([]);
  }
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({
    level: "error",
    event: "trusted_native_clients_config_invalid",
    setting: TRUSTED_NATIVE_CLIENTS_ENV,
    problem: "invalid_json",
    effect: "no_native_client_verified",
  });
  expect(lines.join("\n")).not.toContain("private-marker");
  // Valid and absent values keep working and log nothing more.
  expect(read(JSON.stringify([ENTRY])).map((entry) => entry.id)).toEqual(["chat-mobile"]);
  expect(read(undefined)).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
  expect(lines).toHaveLength(1);
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

test("the shared reader logs to console.error at most once per isolate", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let index = 0; index < 3; index += 1) {
      expect(trustedNativeClientsFromEnv(`[{"id":"x${index}"}]`)).toEqual([]);
    }
    expect(error.mock.calls.length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain("\"x0\"");
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
      parseEnv({ ...env, TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS: "[{\"id\":\"x\"}]" })
        .trustedNativeClients,
    ).toEqual([]);
  } finally {
    error.mockRestore();
  }
});
