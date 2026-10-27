import type { Capsule, Run } from "../../lib/control-api.ts";

export type InstallUiState = "not-installed" | "configuring" | "provider-required" |
  "ready" | "installing" | "installed" | "failed" | "uninstalling";

/** Only an opaque read locator survives reload, never inputs or consent. */
export function installCapsuleId(search: string): string | undefined {
  const ids = new URLSearchParams(search).getAll("capsule");
  return ids.length === 1 && /^cap_[A-Za-z0-9_-]{1,128}$/u.test(ids[0] ?? "") ? ids[0] : undefined;
}
export function installCapsuleSearch(id: string): string {
  const search = `?capsule=${encodeURIComponent(id)}`;
  if (installCapsuleId(search) !== id) throw new TypeError("Invalid Capsule locator");
  return search;
}
export function latestInstallRun(capsule: Capsule, runs: readonly Run[]): Run | undefined {
  return runs.filter((run) => run.workspaceId === capsule.workspaceId &&
    run.capsuleId === capsule.id && (run.type === "plan" || run.type === "apply"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) ||
      (a.type === b.type ? b.id.localeCompare(a.id) : a.type === "apply" ? -1 : 1))[0];
}
export function capsuleInstallState(capsule: Capsule, run?: Run): InstallUiState {
  if (capsule.status === "destroyed") return "not-installed";
  if (capsule.status === "uninstalled" || capsule.uninstall?.phase === "destroying") return "uninstalling";
  if (capsule.currentStateVersionId) return "installed";
  if (run?.status === "failed" || run?.status === "cancelled" || run?.status === "expired" || capsule.status === "error") return "failed";
  return run ? "installing" : "configuring";
}

/** Only a known, non-destructive policy-pass Plan may continue automatically. */
export function canAutoInstallRun(run: Run | undefined): boolean {
  const summary = run?.summary;
  return run?.type === "plan" && run.status === "succeeded" && run.policyStatus === "pass" &&
    run.requiresApproval !== true && !!summary &&
    [summary.add, summary.change, summary.destroy].every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0) && summary.destroy === 0;
}
