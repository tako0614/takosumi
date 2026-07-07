import { describe, expect, test } from "bun:test";
import { ControlApiError } from "../../../../dashboard/src/lib/control-api.ts";

describe("ControlApiError source-sync classification", () => {
  test("treats the typed source_sync_required code as source sync retryable", () => {
    const error = new ControlApiError(
      409,
      "source_sync_required",
      "Source contents are still being fetched.",
    );

    expect(error.isSourceSyncRequired).toBe(true);
  });

  test("keeps source_sync_required failed_precondition retryable for legacy route messages", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "source_sync_required: source src_1 has no SourceSnapshot; run a source sync first",
    );

    expect(error.isSourceSyncRequired).toBe(true);
  });

  test("does not classify unrelated failed_precondition errors as source sync", () => {
    const duplicateInstallation = new ControlApiError(
      409,
      "failed_precondition",
      "installation @space/takos (production) already exists",
    );
    const compatibilityNotRunnable = new ControlApiError(
      409,
      "failed_precondition",
      "compatibility_report_not_runnable: report caprep_1 is needs_patch",
    );

    expect(duplicateInstallation.isSourceSyncRequired).toBe(false);
    expect(compatibilityNotRunnable.isSourceSyncRequired).toBe(false);
  });
});

describe("ControlApiError duplicate service classification", () => {
  test("reads typed duplicate reasons from deploy-control error details", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "installation @workspace/takos (production) already exists",
      {
        error: {
          code: "failed_precondition",
          message: "installation @workspace/takos (production) already exists",
          details: {
            reason: "duplicate_installation",
            installationId: "inst_existing",
            name: "takos",
            environment: "production",
          },
        },
      },
    );

    expect(error.reason).toBe("duplicate_installation");
    expect(error.isDuplicateService).toBe(true);
  });

  test("keeps duplicate fallback for older deploy-control messages", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "installation @workspace/takos (production) already exists",
    );

    expect(error.reason).toBeUndefined();
    expect(error.isDuplicateService).toBe(true);
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
  test("classifies app hostname collisions without exposing owner details", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "app_hostname_unavailable: yurucommu.app.takos.jp already exists",
    );

    expect(error.isAppHostnameUnavailable).toBe(true);
    expect(error.isDuplicateService).toBe(false);
  });

  test("reads typed app hostname collision reasons when present", () => {
    const error = new ControlApiError(
      409,
      "failed_precondition",
      "app_hostname_unavailable: yurucommu.app.takos.jp already exists",
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
});
