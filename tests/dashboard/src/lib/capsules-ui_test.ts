import { describe, expect, test } from "bun:test";
import {
  effectiveCapsuleStatus,
  isCapsuleRuntimeOpenable,
  isStateVersionRuntimeReady,
  needsAttention,
  outputLabel,
  pendingNeedsAttention,
  publicLinkRowLabels,
  releaseActivationStatusForStateVersion,
  stateVersionReadinessAfterApply,
} from "../../../../dashboard/src/lib/capsules-ui.ts";
import type { ActivityEvent } from "../../../../dashboard/src/lib/control-api.ts";

describe("Capsule presentation status", () => {
  const now = Date.parse("2026-06-25T12:00:00.000Z");

  test("keeps recent pending services as normal setup", () => {
    const inst = {
      status: "pending",
      updatedAt: "2026-06-25T11:45:01.000Z",
    };
    expect(pendingNeedsAttention(inst, { now })).toBe(false);
    expect(effectiveCapsuleStatus(inst, { now })).toBe("pending");
    expect(needsAttention(inst, { now })).toBe(false);
  });

  test("turns old pending services into needs-attention presentation", () => {
    const inst = {
      status: "pending",
      updatedAt: "2026-06-25T11:29:59.000Z",
    };
    expect(pendingNeedsAttention(inst, { now })).toBe(true);
    expect(effectiveCapsuleStatus(inst, { now })).toBe("needs_attention");
    expect(needsAttention(inst, { now })).toBe(true);
  });

  test("preserves derived stale status ahead of stored active", () => {
    expect(
      effectiveCapsuleStatus({
        status: "active",
        freshness: "stale",
        updatedAt: "2026-06-25T01:00:00.000Z",
      }),
    ).toBe("stale");
  });
});

describe("publicLinkRowLabels", () => {
  test("keeps friendly labels while they are unique", () => {
    const entries: [string, unknown][] = [
      ["launch_url", "https://a.test/"],
      ["endpoint", "https://b.test/"],
    ];
    expect(publicLinkRowLabels(entries)).toEqual(["Launch URL", "Endpoint"]);
  });

  test("colliding friendly labels fall back to the humanized raw key", () => {
    // Ordinary keys are humanized independently; none is a reserved runtime
    // or presentation fact.
    const entries: [string, unknown][] = [
      ["launch_url", "https://a.test/"],
      ["url", "https://b.test/"],
      ["app_url", "https://c.test/"],
    ];
    const labels = publicLinkRowLabels(entries);
    expect(labels[0]).toBe("Launch URL");
    expect(labels[1]).toBe("URL");
    expect(labels[2]).toBe("App URL");
    expect(new Set(labels).size).toBe(3);
  });

  test("keys that also humanize identically get host+path disambiguation", () => {
    const entries: [string, unknown][] = [
      ["site_url", "https://a.test/"],
      ["siteUrl", "https://b.test/admin"],
    ];
    expect(publicLinkRowLabels(entries)).toEqual([
      "Site URL (a.test)",
      "Site URL (b.test/admin)",
    ]);
  });
});

describe("StateVersion release-activation readiness", () => {
  const stateVersion = {
    id: "sv_1",
    capsuleId: "cap_1",
    createdByRunId: "run_apply_1",
  };

  function activity(
    action: string,
    metadata: Record<string, unknown> = {},
  ): ActivityEvent {
    return {
      id: `act_${action}`,
      workspaceId: "ws_1",
      action,
      targetType: "run",
      targetId: "run_apply_1",
      runId: "run_apply_1",
      metadata: {
        capsuleId: "cap_1",
        stateVersionId: "sv_1",
        applyRunId: "run_apply_1",
        ...metadata,
      },
      createdAt: "2026-06-30T19:00:00.000Z",
    };
  }

  test("does not infer lifecycle requirements from OpenTofu Outputs", () => {
    expect(stateVersionReadinessAfterApply(undefined, [], "cap_1")).toBe(
      "settling",
    );
    expect(
      releaseActivationStatusForStateVersion(stateVersion, [], "cap_1"),
    ).toBe("not_required");
    expect(stateVersionReadinessAfterApply(stateVersion, [], "cap_1")).toBe(
      "ready",
    );
    expect(isStateVersionRuntimeReady(stateVersion, [], "cap_1")).toBe(true);
  });

  test("records matching release activation success", () => {
    const events = [activity("release_activation.succeeded")];
    expect(
      releaseActivationStatusForStateVersion(stateVersion, events, "cap_1"),
    ).toBe("succeeded");
    expect(stateVersionReadinessAfterApply(stateVersion, events, "cap_1")).toBe(
      "ready",
    );
    expect(isStateVersionRuntimeReady(stateVersion, events, "cap_1")).toBe(
      true,
    );
  });

  test("marks matching release activation failure as failed readiness", () => {
    const events = [activity("release_activation.failed")];
    expect(
      releaseActivationStatusForStateVersion(stateVersion, events, "cap_1"),
    ).toBe("failed");
    expect(stateVersionReadinessAfterApply(stateVersion, events, "cap_1")).toBe(
      "activation_failed",
    );
    expect(isStateVersionRuntimeReady(stateVersion, events, "cap_1")).toBe(
      false,
    );
  });

  test("does not reuse a previous apply's activation success", () => {
    const current = activity("release_activation.succeeded");
    const previous = {
      ...current,
      targetId: "run_apply_previous",
      runId: "run_apply_previous",
      metadata: {
        ...current.metadata,
        stateVersionId: "sv_previous",
        applyRunId: "run_apply_previous",
      },
    };
    expect(
      releaseActivationStatusForStateVersion(stateVersion, [previous], "cap_1"),
    ).toBe("not_required");
    expect(
      stateVersionReadinessAfterApply(stateVersion, [previous], "cap_1"),
    ).toBe("ready");
  });

  test("keeps runtime readiness false while lifecycle activity is pending", () => {
    const events = [activity("release_activation.pending")];
    expect(
      releaseActivationStatusForStateVersion(stateVersion, events, "cap_1"),
    ).toBe("pending");
    expect(stateVersionReadinessAfterApply(stateVersion, events, "cap_1")).toBe(
      "activation_pending",
    );
    expect(isStateVersionRuntimeReady(stateVersion, events, "cap_1")).toBe(
      false,
    );
  });

  test("does not expose Open for a state-only recovered Capsule that remains in error", () => {
    const recoveredStateVersion = {
      ...stateVersion,
      createdByRunId: "run_state_recovery_1",
    };
    const recoveredEvent: ActivityEvent = {
      id: "act_state_recovered_1",
      workspaceId: "ws_1",
      action: "capsule.state_recovered",
      targetType: "capsule",
      targetId: "cap_1",
      runId: "run_state_recovery_1",
      metadata: {
        failedApplyRunId: "run_failed_apply_1",
        stateVersionId: "sv_1",
        sourceSnapshotId: "snapshot_1",
        artifactEvidenceDigest: "sha256:fixture",
      },
      createdAt: "2026-06-30T19:00:00.000Z",
    };

    expect(
      isCapsuleRuntimeOpenable(
        { id: "cap_1", status: "error", currentStateVersionId: "sv_1" },
        "cap_1",
        recoveredStateVersion,
        [recoveredEvent],
      ),
    ).toBe(false);
  });

  test("offers Open only for active or legacy-stale Capsules with ready StateVersions", () => {
    expect(
      isCapsuleRuntimeOpenable(
        { id: "cap_1", status: "active", currentStateVersionId: "sv_1" },
        "cap_1",
        stateVersion,
      ),
    ).toBe(true);
    expect(
      isCapsuleRuntimeOpenable(
        { id: "cap_1", status: "stale", currentStateVersionId: "sv_1" },
        "cap_1",
        stateVersion,
      ),
    ).toBe(true);

    for (const status of ["pending", "error", "disabled", "destroyed"] as const) {
      expect(
        isCapsuleRuntimeOpenable(
          { id: "cap_1", status, currentStateVersionId: "sv_1" },
          "cap_1",
          stateVersion,
        ),
      ).toBe(false);
    }
    expect(isCapsuleRuntimeOpenable(undefined, "cap_1", stateVersion)).toBe(
      false,
    );
    expect(
      isCapsuleRuntimeOpenable(
        { id: "cap_1", status: "active", currentStateVersionId: "sv_1" },
        "cap_1",
      ),
    ).toBe(false);
    expect(
      isCapsuleRuntimeOpenable(
        { id: "cap_1", status: "active" },
        "cap_1",
        stateVersion,
      ),
    ).toBe(false);
  });

  test("does not open retained Capsule A data while route B loads or returns not-found", () => {
    const retainedA = {
      id: "cap_a",
      status: "active" as const,
      currentStateVersionId: "sv_1",
    };
    const stateVersionA = { ...stateVersion, capsuleId: "cap_a" };

    // The resource may retain A as its last-good value while B loads or after
    // B returns not-found. Both cases have the same last-good A input; route
    // identity must fence the old runtime action.
    expect(
      isCapsuleRuntimeOpenable(retainedA, "cap_b", stateVersionA),
    ).toBe(false);
    // Last-good behavior remains valid when the route still names A.
    expect(
      isCapsuleRuntimeOpenable(retainedA, "cap_a", stateVersionA),
    ).toBe(true);
  });

  test("keeps Open unavailable until current StateVersion activation succeeds", () => {
    expect(
      isCapsuleRuntimeOpenable(
        { id: "cap_1", status: "active", currentStateVersionId: "sv_1" },
        "cap_1",
        stateVersion,
        [activity("release_activation.pending")],
      ),
    ).toBe(false);
    expect(
      isCapsuleRuntimeOpenable(
        { id: "cap_1", status: "active", currentStateVersionId: "sv_1" },
        "cap_1",
        stateVersion,
        [activity("release_activation.failed")],
      ),
    ).toBe(false);
  });
});
