import { describe, expect, test } from "bun:test";
import { ControlApiError } from "../../../../dashboard/src/lib/control-api.ts";

describe("ControlApiError source-sync classification", () => {
  test("reads source sync reasons from failed_precondition details", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "Source contents are still being fetched.",
      {
        error: {
          code: "failed_precondition",
          message: "Source contents are still being fetched.",
          details: { reason: "source_sync_required" },
        },
      },
    );

    expect(error.reason).toBe("source_sync_required");
    expect(error.isSourceSyncRequired).toBe(true);
  });

  test("does not infer source sync semantics from failed_precondition messages", () => {
    const sourceMessageOnly = new ControlApiError(
      409,
      "failed_precondition",
      "source_sync_required: source src_1 has no SourceSnapshot",
    );
    const compatibilityNotRunnable = new ControlApiError(
      409,
      "failed_precondition",
      "compatibility_report_not_runnable: report caprep_1 is needs_patch",
    );
    const nonContractCodeOnly = new ControlApiError(
      409,
      "source_sync_required",
      "Source contents are still being fetched.",
    );

    expect(sourceMessageOnly.isSourceSyncRequired).toBe(false);
    expect(compatibilityNotRunnable.isSourceSyncRequired).toBe(false);
    expect(nonContractCodeOnly.isSourceSyncRequired).toBe(false);
  });
});

describe("ControlApiError duplicate service classification", () => {
  test("reads typed duplicate capsule reasons without owner details", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "capsule already exists",
      {
        error: {
          code: "failed_precondition",
          message: "capsule already exists",
          details: {
            reason: "duplicate_capsule",
            name: "takos",
            environment: "production",
          },
        },
      },
    );

    expect(error.reason).toBe("duplicate_capsule");
    expect(error.isDuplicateService).toBe(true);
  });

  test("does not infer duplicate semantics from Capsule messages", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "capsule @workspace/takos (production) already exists",
    );

    expect(error.reason).toBeUndefined();
    expect(error.isDuplicateService).toBe(false);
  });

  test("does not treat unrelated 409s as duplicate services", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "compatibility_report_not_runnable: report caprep_1 is needs_patch",
      {
        error: {
          code: "failed_precondition",
          details: { reason: "compatibility_report_not_runnable" },
        },
      },
    );

    expect(error.reason).toBe("compatibility_report_not_runnable");
    expect(error.isDuplicateService).toBe(false);
  });
});

describe("ControlApiError app hostname classification", () => {
  test("does not infer app hostname collisions from messages", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "app_hostname_unavailable: already exists",
    );

    expect(error.isAppHostnameUnavailable).toBe(false);
    expect(error.isDuplicateService).toBe(false);
  });

  test("reads typed app hostname collision reasons when present", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "app_hostname_unavailable: already exists",
      {
        error: {
          code: "failed_precondition",
          details: { reason: "app_hostname_unavailable" },
        },
      },
    );

    expect(error.reason).toBe("app_hostname_unavailable");
    expect(error.isAppHostnameUnavailable).toBe(true);
  });

  test("does not infer app hostname collisions from verbose owner messages", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "app_hostname_unavailable: yurucommu.app.takos.jp is already claimed by Capsule yurucommu (inst_1) in Workspace space_1",
    );

    expect(error.isAppHostnameUnavailable).toBe(false);
  });
});
