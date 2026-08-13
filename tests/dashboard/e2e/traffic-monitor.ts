import type { Page } from "@playwright/test";
import {
  requiresLiveWorkerVersionHeader,
  shouldRecordRequestFailure,
  shouldRecordResponseFailure,
  workerVersionHeaderFailure,
  type DashboardE2EMode,
} from "./traffic-policy.ts";
import { validateExpectedWorkerVersionId } from "../../../scripts/dashboard-browser-e2e/live-inputs.ts";
import { assertExpectedWorkerVersionId } from "../../../scripts/dashboard-browser-e2e/version-contract.ts";

export interface DashboardTrafficFailure {
  readonly kind: "response" | "requestfailed" | "version" | "redirect";
  readonly url: string;
  readonly status?: number;
  readonly detail?: string;
}

export interface DashboardVersionObservation {
  readonly route: string;
  readonly status: number;
  readonly observedWorkerVersionId: string | null;
}

export interface DashboardTrafficMonitor {
  readonly failures: DashboardTrafficFailure[];
  readonly versionObservations: DashboardVersionObservation[];
  recordVersionedResponse(
    route: string,
    status: number,
    headers: Readonly<Record<string, string>>,
  ): void;
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
  const versionObservations: DashboardVersionObservation[] = [];
  const origin = expectedOrigin(mode);
  const expectedWorkerVersionId =
    mode === "live" || mode === "public-live"
      ? validateExpectedWorkerVersionId(
          process.env.TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID ?? "",
        )
      : "";

  const recordVersionedResponse = (
    route: string,
    status: number,
    headers: Readonly<Record<string, string>>,
  ): void => {
    if (mode !== "live" && mode !== "public-live") return;
    const observedWorkerVersionId =
      headers["x-takosumi-version-id"]?.trim() || null;
    versionObservations.push({
      route,
      status,
      observedWorkerVersionId,
    });
    assertExpectedWorkerVersionId({
      route: `${route} ${status}`,
      expectedWorkerVersionId,
      observedWorkerVersionId,
    });
  };

  page.on("response", (response) => {
    const status = response.status();
    const url = new URL(response.url());
    if (mode === "live" || mode === "public-live") {
      const versionFailure = workerVersionHeaderFailure({
        mode,
        origin,
        url: response.url(),
        resourceType: response.request().resourceType(),
        expectedWorkerVersionId,
        observedWorkerVersionId:
          response.headers()["x-takosumi-version-id"] ?? null,
      });
      if (
        requiresLiveWorkerVersionHeader(
          mode,
          origin,
          response.url(),
          response.request().resourceType(),
        )
      ) {
        const observation = {
          route: url.pathname,
          status,
          observedWorkerVersionId:
            response.headers()["x-takosumi-version-id"]?.trim() || null,
        } satisfies DashboardVersionObservation;
        versionObservations.push(observation);
      }
      if (versionFailure) {
        failures.push({
          kind: "version",
          url: response.url(),
          status,
          detail: versionFailure,
        });
      }
    }
    if (
      mode === "public-live" &&
      response.request().redirectedFrom() !== null
    ) {
      failures.push({
        kind: "redirect",
        url: response.url(),
        status,
        detail: "official-origin response followed an HTTP redirect",
      });
    }
    if (shouldRecordResponseFailure(mode, origin, response.url(), status)) {
      failures.push({
        kind: "response",
        url: response.url(),
        status,
      });
    }
  });
  page.on("request", (request) => {
    if (mode !== "public-live" || request.redirectedFrom() === null) return;
    failures.push({
      kind: "redirect",
      url: request.url(),
      detail: "official-origin request followed an HTTP redirect",
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
    versionObservations,
    recordVersionedResponse,
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
