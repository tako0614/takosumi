import type { Page } from "@playwright/test";
import {
  shouldRecordRequestFailure,
  shouldRecordResponseFailure,
  type DashboardE2EMode,
} from "./traffic-policy.ts";

export interface DashboardTrafficFailure {
  readonly kind: "response" | "requestfailed";
  readonly url: string;
  readonly status?: number;
  readonly detail?: string;
}

export interface DashboardTrafficMonitor {
  readonly failures: DashboardTrafficFailure[];
  assertNoFailures(): void;
}

function expectedOrigin(mode: DashboardE2EMode): string {
  return mode === "portable"
    ? "http://127.0.0.1:4179"
    : (process.env.TAKOSUMI_E2E_BASE_URL?.trim() ?? "");
}

export function monitorDashboardTraffic(
  page: Page,
  mode: DashboardE2EMode,
): DashboardTrafficMonitor {
  const failures: DashboardTrafficFailure[] = [];
  const origin = expectedOrigin(mode);

  page.on("response", (response) => {
    const status = response.status();
    if (!shouldRecordResponseFailure(mode, origin, response.url(), status)) {
      return;
    }
    failures.push({
      kind: "response",
      url: response.url(),
      status,
    });
  });
  page.on("requestfailed", (request) => {
    if (!shouldRecordRequestFailure(request.url())) return;
    failures.push({
      kind: "requestfailed",
      url: request.url(),
      detail: request.failure()?.errorText,
    });
  });

  return {
    failures,
    assertNoFailures() {
      if (failures.length === 0) return;
      throw new Error(
        `dashboard browser traffic failures:\n${failures
          .map((failure) => {
            const status = failure.status === undefined ? "" : ` ${failure.status}`;
            const detail = failure.detail ? ` ${failure.detail}` : "";
            return `- ${failure.kind}${status} ${failure.url}${detail}`;
          })
          .join("\n")}`,
      );
    },
  };
}
