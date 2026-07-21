import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string =>
  readFileSync(resolve(here, relative), "utf8");

const sessionSource = read(
  "../../../../../../dashboard/src/views/account/lib/session.ts",
);
const userMenuSource = read(
  "../../../../../../dashboard/src/views/account/components/auth/UserMenu.tsx",
);
const accountViewSource = read(
  "../../../../../../dashboard/src/views/account/AccountView.tsx",
);

describe("sign-out cannot be undone by single-provider auto-start", () => {
  // Regression: signing out landed on /sign-in, which auto-started the sole
  // configured provider; the upstream IdP session was still valid, so the
  // browser was redirected straight back into a fresh session. To the user that
  // reads as "logging out logs me back in".
  test("clearSession arms the auto-start breaker", () => {
    expect(sessionSource).toContain(
      'import { markAutoStartAttempted } from "./oauth-autostart.ts";',
    );
    expect(sessionSource).toContain("markAutoStartAttempted();");
  });

  test("both sign-out entry points also pass manual=1", () => {
    expect(userMenuSource).toContain('nav("/sign-in?manual=1"');
    expect(accountViewSource).toContain('nav("/sign-in?manual=1"');
  });

  test("sign-out drops the previous session's Workspace list cache", () => {
    // The cached list is the old session's projection; it must not be shown to
    // whoever signs in next in this tab.
    expect(sessionSource).toContain("clearWorkspaceListCache();");
  });

  test("sign-out keeps the persisted Workspace selection", () => {
    // Clearing it dumped returning users into an arbitrary first Workspace
    // (usually the empty auto-created personal one), which reads as landing in
    // a stranger's account. `selectAvailableWorkspaceId` already validates the
    // stored id against the next session's own list.
    expect(sessionSource).not.toContain('setCurrentWorkspaceId("")');
  });
});

describe("oauth auto-start breaker", () => {
  test("marks, reads, and clears through sessionStorage", async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    const {
      autoStartAlreadyAttempted,
      clearAutoStartAttempt,
      markAutoStartAttempted,
    } =
      await import("../../../../../../dashboard/src/views/account/lib/oauth-autostart.ts");

    expect(autoStartAlreadyAttempted(storage)).toBe(false);
    markAutoStartAttempted(storage);
    expect(autoStartAlreadyAttempted(storage)).toBe(true);
    clearAutoStartAttempt(storage);
    expect(autoStartAlreadyAttempted(storage)).toBe(false);
  });
});
