// runner/lib/http_server.ts
//
// HTTP request router for the OpenTofu runner container.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import type { RunRequest } from "./types.ts";
import { readJsonObject, parseAction } from "./util.ts";
import { redactRunnerOutput } from "./redaction.ts";
import { redactionValuesFromRequest } from "./credentials.ts";
import {
  isSourceSyncRequest,
  isStableSemverTagRequest,
  isSourceSnapshotFileRequest,
  runSourceSync,
  runStableSemverTagResolution,
  runSourceSnapshotFileRead,
  handleSourceArchiveArtifactRequest,
  handleSourceArchiveRestoreRequest,
  handleDepStateRestoreRequest,
} from "./source_sync.ts";
import {
  handlePlanJsonArtifactRequest,
  handlePlanArtifactRequest,
  handleStateArtifactRequest,
} from "./artifacts.ts";
import { runBackup, runRelease } from "./backup.ts";
import {
  runPlan,
  runReviewedPlanApply,
  runCompatibilityCheck,
} from "./plan_apply.ts";
import { classifyOpenTofuFailure } from "./exec.ts";
import { readApplyProgress } from "./apply_progress.ts";

// Run-slot ceiling for the standalone / in-process runner. The Cloudflare
// profile bounds concurrency with the platform's container `max_instances`;
// the self-host runner needs its own ceiling or a burst of installs launches
// an unbounded number of tofu processes on one host. The refusal happens
// BEFORE any work starts, which is what makes it safe for the control plane
// to requeue (`capacity_exhausted` is a safe-mutating retry reason). The
// message embeds the same phrase the Cloudflare classifier matches.
const DEFAULT_MAX_CONCURRENT_RUNS = 10;
let activeTofuRuns = 0;

function maxConcurrentRuns(): number {
  const raw = (globalThis as {
    Bun?: { env: Record<string, string | undefined> };
  }).Bun?.env.TAKOSUMI_RUNNER_MAX_CONCURRENT_RUNS?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_RUNS;
  const parsed = Number(raw);
  // 0 is a deliberate drain mode: refuse every new run while in-flight work
  // finishes (the control plane keeps them queued under its capacity budget).
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_CONCURRENT_RUNS;
}

export async function handleRunnerRequest(request: Request): Promise<Response> {
  {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" || url.pathname === "/container/health") {
      return Response.json({ ok: true, runner: "opentofu" });
    }
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    const artifactMatch = /^\/runs\/([^/]+)\/artifacts\/tfplan$/.exec(
      url.pathname,
    );
    const planJsonArtifactMatch =
      /^\/runs\/([^/]+)\/artifacts\/tfplan-json$/.exec(url.pathname);
    const stateArtifactMatch = /^\/runs\/([^/]+)\/artifacts\/tfstate$/.exec(
      url.pathname,
    );
    const sourceArchiveArtifactMatch =
      /^\/runs\/([^/]+)\/artifacts\/source-archive$/.exec(url.pathname);
    const sourceArchiveRestoreMatch =
      /^\/runs\/([^/]+)\/source-archive\/restore$/.exec(url.pathname);
    const depStateRestoreMatch =
      /^\/runs\/([^/]+)\/deps\/([^/]+)\/restore$/.exec(url.pathname);
    // Live apply progress, read while the run's own request is still blocked
    // inside `tofu apply`. Read-only and cheap; absent for a run that is not
    // applying (or whose output has not narrated a resource yet).
    const progressMatch = /^\/runs\/([^/]+)\/progress$/.exec(url.pathname);
    if (progressMatch) {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method not allowed" },
          { status: 405, headers: { allow: "GET" } },
        );
      }
      const runId = decodeURIComponent(progressMatch[1]!);
      const progress = readApplyProgress(runId);
      return Response.json(
        progress ? { runId, progress } : { runId },
        { status: 200 },
      );
    }
    if (depStateRestoreMatch) {
      return await handleDepStateRestoreRequest(
        decodeURIComponent(depStateRestoreMatch[1]!),
        decodeURIComponent(depStateRestoreMatch[2]!),
        request,
      );
    }
    if (sourceArchiveRestoreMatch) {
      return await handleSourceArchiveRestoreRequest(
        decodeURIComponent(sourceArchiveRestoreMatch[1]!),
        request,
      );
    }
    if (sourceArchiveArtifactMatch) {
      return await handleSourceArchiveArtifactRequest(
        decodeURIComponent(sourceArchiveArtifactMatch[1]!),
        request,
      );
    }
    if (planJsonArtifactMatch) {
      return await handlePlanJsonArtifactRequest(
        decodeURIComponent(planJsonArtifactMatch[1]!),
        request,
      );
    }
    if (artifactMatch) {
      return await handlePlanArtifactRequest(
        decodeURIComponent(artifactMatch[1]!),
        request,
      );
    }
    if (stateArtifactMatch) {
      return await handleStateArtifactRequest(
        decodeURIComponent(stateArtifactMatch[1]!),
        request,
      );
    }
    if (!match) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "method not allowed" },
        { status: 405, headers: { allow: "POST" } },
      );
    }

    const body = (await readJsonObject(request)) as RunRequest;
    const runId = decodeURIComponent(match[1]);

    // Source-sync (LANE M1) is a distinct job carried on the `request` field as
    // `{ action: "source_sync", source, credentials?, archiveRef }`. It
    // resolves a commit, builds a deterministic archive of source.path, PUTs the
    // bytes to the DO source-archive route, and returns resolution metadata. It
    // never runs tofu and never restores/persists OpenTofu state.
    const requestRedactionValues = redactionValuesFromRequest(body.request);
    if (isSourceSyncRequest(body.request)) {
      try {
        const result = await runSourceSync(runId, body.request);
        return Response.json(result, { status: 200 });
      } catch (error) {
        return Response.json(
          {
            runId,
            action: "source_sync",
            status: "failed",
            exitCode: 1,
            stderr: redactRunnerOutput(
              error instanceof Error ? error.message : String(error),
              requestRedactionValues,
            ),
          },
          { status: 500 },
        );
      }
    }

    if (
      isStableSemverTagRequest(body.request) ||
      isSourceSnapshotFileRequest(body.request)
    ) {
      const action = isStableSemverTagRequest(body.request)
        ? "stable_semver_tag"
        : "source_snapshot_file";
      try {
        const result =
          action === "stable_semver_tag"
            ? await runStableSemverTagResolution(runId, body.request)
            : await runSourceSnapshotFileRead(runId, body.request);
        return Response.json(result, { status: 200 });
      } catch (error) {
        return Response.json(
          {
            runId,
            action,
            status: "failed",
            exitCode: 1,
            stderr: redactRunnerOutput(
              error instanceof Error ? error.message : String(error),
              requestRedactionValues,
            ),
          },
          { status: 500 },
        );
      }
    }

    const action = parseAction(body.action);
    if (!action) {
      return Response.json(
        { error: "invalid OpenTofu action" },
        { status: 400 },
      );
    }

    // Only actions that actually execute provider work consume a run slot.
    // Counting read-only preflight (compatibility_check) against the same
    // ceiling let a burst of install checks refuse the applies they were
    // checking for — the run then waits out the capacity budget and fails.
    const consumesRunSlot =
      action === "apply" || action === "destroy" || action === "plan";
    const runSlotLimit = maxConcurrentRuns();
    if (consumesRunSlot && activeTofuRuns >= runSlotLimit) {
      return Response.json(
        {
          runId,
          action,
          errorCode: "capacity_exhausted",
          error:
            `Maximum number of running container instances exceeded: ${runSlotLimit} concurrent runs already executing. Try again later, or raise TAKOSUMI_RUNNER_MAX_CONCURRENT_RUNS`,
        },
        { status: 503, headers: { "retry-after": "30" } },
      );
    }
    if (consumesRunSlot) activeTofuRuns += 1;
    try {
      const result =
        action === "compatibility_check"
          ? await runCompatibilityCheck(runId, body.request)
          : action === "backup"
            ? await runBackup(runId, body.request)
            : action === "release"
              ? await runRelease(runId, body.request, request.signal)
              : action === "plan"
                ? await runPlan(runId, body.request, request.signal)
                : await runReviewedPlanApply(
                    runId,
                    action,
                    body.request,
                    request.signal,
                  );
      return Response.json(result, {
        status: result.exitCode === 0 ? 200 : 500,
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      const errorCode = classifyOpenTofuFailure(errorText, "runtime");
      return Response.json(
        {
          runId,
          action,
          status: "failed",
          exitCode: 1,
          ...(errorCode ? { errorCode } : {}),
          stderr: redactRunnerOutput(errorText, requestRedactionValues),
        },
        { status: 500 },
      );
    } finally {
      if (consumesRunSlot) activeTofuRuns -= 1;
    }
  }
}
