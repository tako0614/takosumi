import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  autoApplyModeFromParam,
  autoApplyRunPath,
  grantAutoApplyConsent,
  hasAutoApplyConsent,
} from "../../../../dashboard/src/lib/auto-apply-consent.ts";

const ORIGINAL_SESSION_STORAGE = globalThis.sessionStorage;

function installFakeSessionStorage(): Map<string, string> {
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
  return storage;
}

afterEach(() => {
  if (ORIGINAL_SESSION_STORAGE === undefined) {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  } else {
    globalThis.sessionStorage = ORIGINAL_SESSION_STORAGE;
  }
});

describe("auto-apply consent", () => {
  test("a bare ?auto link carries no consent — only the flow that started it does", () => {
    installFakeSessionStorage();
    // The victim's tab never started an update: a crafted query parameter is
    // not authority to apply infrastructure changes.
    expect(hasAutoApplyConsent("run_a", "update")).toBe(false);

    // The in-app flow mints the token together with the URL it navigates to.
    expect(autoApplyRunPath("/runs/run_a", "run_a", "update")).toBe(
      "/runs/run_a?auto=update",
    );
    expect(hasAutoApplyConsent("run_a", "update")).toBe(true);
  });

  test("consent is scoped to one run id and one mode", () => {
    installFakeSessionStorage();
    grantAutoApplyConsent("run_a", "update");
    expect(hasAutoApplyConsent("run_b", "update")).toBe(false);
    expect(hasAutoApplyConsent("", "update")).toBe(false);
  });

  test("the minted token is unguessable and preserves an existing query", () => {
    const storage = installFakeSessionStorage();
    expect(autoApplyRunPath("/runs/run_a?handoff=x", "run_a", "update")).toBe(
      "/runs/run_a?handoff=x&auto=update",
    );
    const stored = storage.get("takosumi.auto-apply-consent@run_a") ?? "";
    expect(stored.startsWith("update:")).toBe(true);
    expect(stored.slice("update:".length).length).toBeGreaterThan(8);
    grantAutoApplyConsent("run_a", "update");
    expect(storage.get("takosumi.auto-apply-consent@run_a")).not.toBe(stored);
  });

  test("fails closed when storage is unavailable", () => {
    Reflect.deleteProperty(globalThis, "sessionStorage");
    expect(() => grantAutoApplyConsent("run_a", "update")).not.toThrow();
    expect(hasAutoApplyConsent("run_a", "update")).toBe(false);
  });

  test("only the update mode is accepted from the query string", () => {
    expect(autoApplyModeFromParam("install")).toBeNull();
    expect(autoApplyModeFromParam("update")).toBe("update");
    for (const value of [undefined, null, "", "1", "INSTALL", ["install"]]) {
      expect(autoApplyModeFromParam(value)).toBeNull();
    }
  });
});

describe("auto-apply consent call sites", () => {
  const read = (relativePath: string): string =>
    readFileSync(resolve(import.meta.dir, "../../../../", relativePath), "utf8");

  test("the run screen requires the token, not just the parameter", () => {
    const source = read("dashboard/src/views/runs/RunView.tsx");
    // ?auto alone never reaches deploy.run(false): the mode is null unless this
    // tab minted the run-scoped token.
    expect(source).toContain("autoApplyModeFromParam(searchParams.auto)");
    expect(source).toContain("hasAutoApplyConsent(runId(), requested)");
    expect(source).toContain(
      'const autoContinueEnabled = () => autoMode() === "update";',
    );
    // The plan→apply hop and the re-plan mint consent for the run they open.
    expect(source).toContain("autoApplyRunPath(path, targetRunId, mode)");
  });

  test("the update entry mints the token and install stays on /new", () => {
    expect(read("dashboard/src/views/apps/WorkloadDetailView.tsx")).toContain(
      'autoApplyRunPath(`/runs/${runId}`, runId, "update")',
    );
    expect(read("dashboard/src/views/new/InstallExecution.tsx")).not.toContain(
      "autoApplyRunPath",
    );
  });
});
