// runner/lib/http_server.ts
//
// HTTP request router for the OpenTofu runner container.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import type {
  RunRequest,
} from "./types.ts";
import {
  readJsonObject,
  parseAction,
} from "./util.ts";
import {
  redactRunnerOutput,
} from "./redaction.ts";
import {
  redactionValuesFromRequest,
} from "./credentials.ts";
import {
  isSourceSyncRequest,
  runSourceSync,
  handleSourceArchiveArtifactRequest,
  handleSourceArchiveRestoreRequest,
  handleDepStateRestoreRequest,
} from "./source_sync.ts";
import {
  handlePlanJsonArtifactRequest,
  handlePlanArtifactRequest,
  handleStateArtifactRequest,
} from "./artifacts.ts";
import {
  runBackup,
  runRelease,
} from "./backup.ts";
import {
  runPlan,
  runReviewedPlanApply,
  runCompatibilityCheck,
} from "./plan_apply.ts";
import { classifyOpenTofuFailure } from "./exec.ts";
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
    // `{ action: "source_sync", source, credentials?, archiveObjectKey }`. It
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

    const action = parseAction(body.action);
    if (!action) {
      return Response.json(
        { error: "invalid OpenTofu action" },
        { status: 400 },
      );
    }

    try {
      const result =
        action === "compatibility_check"
          ? await runCompatibilityCheck(runId, body.request)
          : action === "backup"
            ? await runBackup(runId, body.request)
            : action === "release"
              ? await runRelease(runId, body.request)
              : action === "plan"
                ? await runPlan(runId, body.request)
                : await runReviewedPlanApply(runId, action, body.request);
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
          stderr: redactRunnerOutput(
            errorText,
            requestRedactionValues,
          ),
        },
        { status: 500 },
      );
    }
  }
}
