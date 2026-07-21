import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTO_INSTALL_TOKEN_PARAM,
  consumeAutoInstallToken,
  issueAutoInstallToken,
} from "../../../../dashboard/src/lib/auto-install-handoff.ts";

const here = dirname(fileURLToPath(import.meta.url));
const newAppViewSource = readFileSync(
  resolve(here, "../../../../dashboard/src/views/new/NewAppView.tsx"),
  "utf8",
);

const originalSessionStorage = globalThis.sessionStorage;

function installMemorySessionStorage(): void {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
    },
  });
}

describe("one-tap install provenance", () => {
  beforeEach(() => installMemorySessionStorage());
  afterEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: originalSessionStorage,
    });
  });

  test("a forged auto-install link carries no authority", () => {
    // Exactly the link an attacker can publish: every param is theirs.
    expect(
      consumeAutoInstallToken(
        "?git=https%3A%2F%2Fattacker.example%2Frepo.git&auto=1&tcsBase=https%3A%2F%2Fattacker.example&tcsListing=x",
      ),
    ).toBe(false);
    // A guessed token id is not armed either.
    expect(
      consumeAutoInstallToken(
        `?auto=1&${AUTO_INSTALL_TOKEN_PARAM}=00000000-0000-4000-8000-000000000000`,
      ),
    ).toBe(false);
  });

  test("our own CTA arms exactly one install and cannot be replayed", () => {
    const id = issueAutoInstallToken();
    expect(id).toBeDefined();
    const search = `?auto=1&${AUTO_INSTALL_TOKEN_PARAM}=${id}`;
    expect(consumeAutoInstallToken(search)).toBe(true);
    // Back-navigation / re-share must not re-fire the install.
    expect(consumeAutoInstallToken(search)).toBe(false);
  });

  test("the add flow gates auto-start on the token and on a verified listing", () => {
    expect(newAppViewSource).toContain(
      "consumeAutoInstallToken(initialSearch)",
    );
    // The handoff must settle only on the success path — a `finally` here armed
    // auto-start for listings that failed or did not match.
    expect(newAppViewSource).not.toContain(
      "finally {\n        setTcsHandoffSettled(true);",
    );
  });
});
