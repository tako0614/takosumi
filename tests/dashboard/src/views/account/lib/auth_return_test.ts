import { afterEach, expect, test } from "bun:test";
import {
  completeUpstreamOAuth,
  recallOAuthReturnTo,
  safeOAuthReturnTo,
} from "../../../../../../dashboard/src/views/account/lib/auth.ts";

const ORIGINAL_SESSION_STORAGE = globalThis.sessionStorage;
const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  if (ORIGINAL_SESSION_STORAGE === undefined) {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  } else {
    globalThis.sessionStorage = ORIGINAL_SESSION_STORAGE;
  }
  globalThis.fetch = ORIGINAL_FETCH;
});

test("safeOAuthReturnTo keeps same-origin paths", () => {
  expect(safeOAuthReturnTo("/")).toBe("/");
  expect(safeOAuthReturnTo("/installations?tab=apps#latest")).toBe(
    "/installations?tab=apps#latest",
  );
  expect(safeOAuthReturnTo("  /spaces/space_1  ")).toBe("/spaces/space_1");
});

test("safeOAuthReturnTo rejects open-redirect values", () => {
  for (const value of [
    undefined,
    null,
    "",
    "https://evil.example/",
    "javascript:alert(1)",
    "//evil.example/path",
    " ///evil.example/path",
    "/ok\nLocation: https://evil.example",
  ]) {
    expect(safeOAuthReturnTo(value)).toBe("/");
  }
});

test("completeUpstreamOAuth keeps the saved return path when callback exchange fails", async () => {
  const storage = new Map<string, string>();
  globalThis.sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  };
  storage.set("tg_oauth_state", "state_a");
  storage.set("tg_oauth_provider", "google");
  storage.set(
    "tg_oauth_return",
    "/new?git=https%3A%2F%2Fgithub.com%2Ftako0614%2Ftakos.git&path=deploy%2Fopentofu",
  );
  globalThis.fetch = async () =>
    Response.json(
      { error: "temporarily_unavailable", error_description: "retry later" },
      { status: 503 },
    );

  await expect(
    completeUpstreamOAuth("code_a", "state_a", "google"),
  ).rejects.toThrow("retry later");

  expect(recallOAuthReturnTo()).toBe(
    "/new?git=https%3A%2F%2Fgithub.com%2Ftako0614%2Ftakos.git&path=deploy%2Fopentofu",
  );
  expect(storage.get("tg_oauth_state")).toBe("state_a");
  expect(storage.get("tg_oauth_provider")).toBe("google");
});
