import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { capsuleInstallState, installCapsuleId, installCapsuleSearch, latestInstallRun } from "../../../../../dashboard/src/views/new/install-lifecycle.ts";
import type { Capsule, Run } from "../../../../../dashboard/src/lib/control-api.ts";
const capsule = { id: "cap_test", workspaceId: "ws_a", status: "pending" } as Capsule;
const plan = { id: "plan_a", type: "plan", workspaceId: "ws_a", capsuleId: "cap_test", status: "succeeded", policyStatus: "pass", summary: { add: 1, change: 0, destroy: 0 }, createdAt: "2026-10-27T01:00:00Z" } as Run;
test("reload locator is opaque and singular, not config or consent", () => {
  expect(installCapsuleId(installCapsuleSearch("cap_test"))).toBe("cap_test");
  for (const s of ["?capsule=cap_a&capsule=cap_b", "?capsule=https://evil.test", "?capsule=../secret", "?capsule=cap_%00"]) expect(installCapsuleId(s)).toBeUndefined();
  expect(() => installCapsuleSearch("../secret")).toThrow();
});
test("restore selects the latest apply and rejects other Workspace/Capsule records", () => {
  const apply = { ...plan, id: "apply_a", type: "apply", status: "running", createdAt: "2026-10-27T01:01:00Z" } as Run;
  expect(latestInstallRun(capsule, [plan, { ...apply, workspaceId: "ws_b" }, { ...apply, capsuleId: "cap_b" }, apply])).toEqual(apply);
  expect(latestInstallRun(capsule, [{ ...apply, workspaceId: "ws_b" }])).toBeUndefined();
});
test("scheduled uninstall is not completed deletion", () => {
  expect(capsuleInstallState({ ...capsule, status: "uninstalled" })).toBe("uninstalling");
  expect(capsuleInstallState({ ...capsule, status: "destroyed" })).toBe("not-installed");
  expect(capsuleInstallState({ ...capsule, status: "active", currentStateVersionId: "sv_actual" })).toBe("installed");
  expect(capsuleInstallState(capsule, { ...plan, status: "failed" })).toBe("failed");
  expect(capsuleInstallState(capsule, { ...plan, status: "running" })).toBe("installing");
});
test("Apply starts only from the explicit Allow and install click", () => {
  // TASK-0115: nothing applies automatically, so no consent can be replayed
  // from a reload, a URL, or a stale in-memory flag.
  const source = readFileSync(new URL("../../../../../dashboard/src/views/new/InstallExecution.tsx", import.meta.url), "utf8");
  expect(source).not.toContain("installRequested");
  expect(source).not.toContain("canAutoInstallRun");
  const installCalls = [...source.matchAll(/void install\(\)/gu)];
  expect(installCalls).toHaveLength(1);
  expect(source).toContain("onClick={() => void install()}");
});

test("a later failed update or disabled app keeps installed management actions", () => {
  for (const status of ["error", "disabled", "stale"] as const) expect(capsuleInstallState({ ...capsule, status, currentStateVersionId: "sv_applied" }, { ...plan, status: "failed" })).toBe("installed");
});
