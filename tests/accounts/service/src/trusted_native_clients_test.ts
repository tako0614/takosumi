import { expect, test } from "bun:test";

import {
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

test("unset or blank keeps the built-in first-party clients", () => {
  expect(TRUSTED_NATIVE_CLIENTS_ENV).toBe("TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS");
  expect(parseTrustedNativeClientsEnv()).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
  expect(parseTrustedNativeClientsEnv("  ")).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
});

test("a JSON array replaces the built-in list, and [] trusts none", () => {
  expect(parseTrustedNativeClientsEnv(JSON.stringify([ENTRY])).map((entry) => entry.id)).toEqual([
    "chat-mobile",
  ]);
  expect(parseTrustedNativeClientsEnv("[]")).toEqual([]);
});

test("malformed values throw with the setting's name", () => {
  for (const value of [
    "{",
    "{}",
    JSON.stringify([{ ...ENTRY, extra: 1 }]),
    JSON.stringify([{ ...ENTRY, android: { ...ENTRY.android, package: "com.takosumi" } }]),
    JSON.stringify([{ ...ENTRY, android: { ...ENTRY.android, templates: ["chat://connect"] } }]),
  ]) {
    expect(() => parseTrustedNativeClientsEnv(value)).toThrow(TRUSTED_NATIVE_CLIENTS_ENV);
  }
});

test("the per-request reader parses each distinct value once and never falls back on error", () => {
  const raw = JSON.stringify([ENTRY]);
  const first = trustedNativeClientsFromEnv(raw);
  expect(trustedNativeClientsFromEnv(raw)).toBe(first);
  expect(trustedNativeClientsFromEnv(undefined)).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
  expect(() => trustedNativeClientsFromEnv("[{}]")).toThrow(TRUSTED_NATIVE_CLIENTS_ENV);
});

test("node-postgres refuses to start with a malformed trusted client list", () => {
  const env = {
    TAKOSUMI_ACCOUNTS_DATABASE_URL: "postgres://takosumi@localhost:5432/accounts",
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
  };
  expect(parseEnv(env).trustedNativeClients).toBe(DEFAULT_TRUSTED_NATIVE_CLIENTS);
  expect(
    parseEnv({ ...env, TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS: JSON.stringify([ENTRY]) })
      .trustedNativeClients.map((entry) => entry.id),
  ).toEqual(["chat-mobile"]);
  expect(() => parseEnv({ ...env, TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS: "[{\"id\":\"x\"}]" }))
    .toThrow(TRUSTED_NATIVE_CLIENTS_ENV);
});
