// runner/lib/http_server.ts
//
// HTTP request router for the OpenTofu runner container.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import type { RunCredentialRefreshUpdate, RunRequest } from "./types.ts";
import { readJsonObject, parseAction } from "./util.ts";
import { redactRunnerOutput } from "./redaction.ts";
import {
  redactionValuesFromRequest,
  sourceCredentialRedactionValuesFromRequest,
  refreshRunCredentials,
  setRunRedactionValues,
  clearRunRedactionValues,
  beginRunCredentialRefreshSession,
  endRunCredentialRefreshSession,
  runCredentialRefreshSessionMetadata,
} from "./credentials.ts";
import {
  isSourceSyncRequest,
  isStableSemverTagRequest,
  SourceRefNotFoundError,
  runSourceSync,
  runStableSemverTagResolution,
  handleSourceArchiveArtifactRequest,
  handleSourceArchiveRestoreRequest,
  handleDepStateRestoreRequest,
} from "./source_sync.ts";
import {
  handlePlanJsonArtifactRequest,
  handlePlanArtifactRequest,
  handleProviderLockfileArtifactRequest,
  handleProviderLockfileRestoreRequest,
  handleStateArtifactRequest,
} from "./artifacts.ts";
import { runBackup, runRelease } from "./backup.ts";
import {
  runPlan,
  runReviewedPlanApply,
  runCompatibilityCheck,
} from "./plan_apply.ts";
import { classifyOpenTofuFailure } from "./exec.ts";
import type { RuntimeSecretFileSystem } from "./runtime_secrets.ts";
import { PROVIDER_LOCK_RESTORE_DIGEST_HEADER } from "./transport.ts";

interface RunnerRequestDependencies {
  readonly runtimeSecretFileSystem?: Partial<RuntimeSecretFileSystem>;
}

const MAX_ASYNC_MUTATION_RESULT_BYTES = 6 * 1024 * 1024;

interface AsyncMutationJob {
  readonly runId: string;
  readonly applyRunId: string;
  readonly action: "apply" | "destroy" | "release";
  status: "running" | "terminal";
  responseStatus?: number;
  responseBody?: string;
}

// This is deliberately container-local. A replacement container cannot
// pretend it knows the outcome of work that may have been interrupted with
// the old process; GET then returns 404 and the caller must treat it as unknown.
const asyncMutationJobs = new Map<string, AsyncMutationJob>();

function prefersAsyncMutation(request: Request): boolean {
  return (request.headers.get("prefer") ?? "")
    .split(",")
    .some((preference) => preference.split(";")[0]?.trim().toLowerCase() === "respond-async");
}

function asyncMutationApplyRunId(
  request: unknown,
  action: "apply" | "destroy" | "release",
): string | undefined {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return;
  const applyRun = (request as Record<string, unknown>)[
    action === "release" ? "activation" : "applyRun"
  ];
  if (typeof applyRun !== "object" || applyRun === null || Array.isArray(applyRun)) return;
  const id = (applyRun as Record<string, unknown>)[
    action === "release" ? "applyRunId" : "id"
  ];
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

function asyncMutationPayload(job: AsyncMutationJob, status: "accepted" | "running") {
  return {
    kind: "takosumi.runner-mutation-pending@v1",
    runId: job.runId,
    applyRunId: job.applyRunId,
    action: job.action,
    status,
  } as const;
}

function oversizedAsyncMutationResult(runId: string, action: "apply" | "destroy" | "release") {
  return Response.json({
    runId,
    action,
    status: "failed",
    exitCode: 1,
    errorCode: "runner_result_size_limit_exceeded",
    stderr: "runner result exceeded its in-process response limit",
  }, { status: 500 });
}

async function runAsyncMutation(
  requestUrl: string,
  requestHeaders: Headers,
  body: RunRequest,
  job: AsyncMutationJob,
  dependencies: RunnerRequestDependencies,
): Promise<void> {
  try {
    // Do not propagate the submit request's AbortSignal: its response has
    // already completed, while accepted provider work must remain observable.
    const headers = new Headers({ "content-type": "application/json" });
    const lockDigest = requestHeaders.get(PROVIDER_LOCK_RESTORE_DIGEST_HEADER);
    if (lockDigest !== null) headers.set(PROVIDER_LOCK_RESTORE_DIGEST_HEADER, lockDigest);
    const terminal = await handleRunnerRequestWithDependencies(
      new Request(requestUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      dependencies,
    );
    const responseBody = await terminal.text();
    const responseBytes = new TextEncoder().encode(responseBody).byteLength;
    if (responseBytes > MAX_ASYNC_MUTATION_RESULT_BYTES) {
      const bounded = oversizedAsyncMutationResult(job.runId, job.action);
      job.responseStatus = bounded.status;
      job.responseBody = await bounded.text();
    } else {
      job.responseStatus = terminal.status;
      job.responseBody = responseBody;
    }
    job.status = "terminal";
  } catch {
    // Never retain or return an internal exception that could contain secret
    // request material, filesystem paths, or provider diagnostics.
    const failure = Response.json({
      runId: job.runId,
      action: job.action,
      status: "failed",
      exitCode: 1,
      stderr: "runner mutation failed",
    }, { status: 500 });
    job.responseStatus = failure.status;
    job.responseBody = await failure.text();
    job.status = "terminal";
  }
}

export async function handleRunnerRequest(request: Request): Promise<Response> {
  return await handleRunnerRequestWithDependencies(request);
}

export async function handleRunnerRequestWithDependencies(
  request: Request,
  dependencies: RunnerRequestDependencies = {},
): Promise<Response> {
  {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" || url.pathname === "/container/health") {
      return Response.json({
        ok: true,
        runner: "opentofu",
        capabilities: ["takosumi.runner-credential-refresh@v1"],
      });
    }
    const resultMatch = /^\/runs\/([^/]+)\/result$/.exec(url.pathname);
    if (resultMatch) {
      if (request.method !== "GET") {
        return Response.json({ error: "method not allowed" }, {
          status: 405,
          headers: { allow: "GET" },
        });
      }
      const runId = decodeURIComponent(resultMatch[1]!);
      const job = asyncMutationJobs.get(runId);
      if (!job) return Response.json({ error: "run result not found" }, { status: 404 });
      if (job.status === "running") {
        return Response.json(asyncMutationPayload(job, "running"), { status: 202 });
      }
      return new Response(job.responseBody ?? "{}", {
        status: job.responseStatus ?? 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const credentialRefreshMatch = /^\/runs\/([^/]+)\/credentials$/.exec(url.pathname);
    if (credentialRefreshMatch) {
      const runId = decodeURIComponent(credentialRefreshMatch[1]!);
      if (request.method === "GET") {
        const metadata = runCredentialRefreshSessionMetadata(runId);
        return metadata
          ? Response.json(metadata)
          : Response.json({ error: "credential refresh is not active" }, { status: 409 });
      }
      if (request.method !== "PUT") {
        return Response.json({ error: "method not allowed" }, {
          status: 405,
          headers: { allow: "PUT" },
        });
      }
      try {
        const body = await readBoundedJsonObject(request, 64 * 1024);
        await refreshRunCredentials(
          runId,
          body as unknown as RunCredentialRefreshUpdate,
        );
        return Response.json({ ok: true, status: "updated" });
      } catch {
        // Never echo the update or a filesystem diagnostic: either may contain
        // bearer material or a private run path.
        return Response.json({ error: "credential refresh rejected" }, { status: 409 });
      }
    }
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    const artifactMatch = /^\/runs\/([^/]+)\/artifacts\/tfplan$/.exec(
      url.pathname,
    );
    const planJsonArtifactMatch =
      /^\/runs\/([^/]+)\/artifacts\/tfplan-json$/.exec(url.pathname);
    const providerLockfileArtifactMatch =
      /^\/runs\/([^/]+)\/artifacts\/tf-lockfile$/.exec(url.pathname);
    const providerLockfileRestoreMatch =
      /^\/runs\/([^/]+)\/provider-lockfile\/restore$/.exec(url.pathname);
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
    if (providerLockfileArtifactMatch) {
      return await handleProviderLockfileArtifactRequest(
        decodeURIComponent(providerLockfileArtifactMatch[1]!),
        request,
      );
    }
    if (providerLockfileRestoreMatch) {
      return await handleProviderLockfileRestoreRequest(
        decodeURIComponent(providerLockfileRestoreMatch[1]!),
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
    // Source credentials use a separate git-only envelope without the provider
    // credential manifest. Keep this redaction boundary source-aware so a
    // malformed source-sync failure can never echo minted git material while
    // the provider-only parser rejects an undeclared credential map.
    const requestRedactionValues = isSourceSyncRequest(body.request)
      ? sourceCredentialRedactionValuesFromRequest(body.request)
      : redactionValuesFromRequest(body.request);
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
            ...(error instanceof SourceRefNotFoundError
              ? { errorCode: error.code }
              : {}),
            stderr: redactRunnerOutput(
              error instanceof Error ? error.message : String(error),
              requestRedactionValues,
            ),
          },
          { status: 500 },
        );
      }
    }

    if (isStableSemverTagRequest(body.request)) {
      const action = "stable_semver_tag";
      try {
        const result = await runStableSemverTagResolution(runId, body.request);
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

    if (
      prefersAsyncMutation(request) &&
      (action === "apply" || action === "destroy" || action === "release")
    ) {
      const applyRunId = asyncMutationApplyRunId(body.request, action);
      if (!applyRunId) {
        return Response.json({ error: "invalid async mutation identity" }, { status: 400 });
      }
      const existing = asyncMutationJobs.get(runId);
      if (existing) {
        return Response.json({ error: "run already accepted" }, { status: 409 });
      }
      const job: AsyncMutationJob = {
        runId,
        applyRunId,
        action,
        status: "running",
      };
      // Reserve synchronously before yielding so concurrent duplicate POSTs
      // cannot start a second provider process.
      asyncMutationJobs.set(runId, job);
      queueMicrotask(() => {
        void runAsyncMutation(request.url, request.headers, body, job, dependencies);
      });
      return Response.json(asyncMutationPayload(job, "accepted"), { status: 202 });
    }

    const mutationRedactionScope =
      action === "plan" || action === "apply" || action === "destroy";
    let credentialRefreshSessionHandle: object | undefined;
    try {
      if (mutationRedactionScope) {
        credentialRefreshSessionHandle = await beginRunCredentialRefreshSession(
          runId,
          action as "plan" | "apply" | "destroy",
          body.request,
          request.signal,
          requestRedactionValues,
        );
        setRunRedactionValues(runId, requestRedactionValues);
      }
      const result =
        action === "compatibility_check"
          ? await runCompatibilityCheck(runId, body.request)
          : action === "backup"
            ? await runBackup(runId, body.request)
            : action === "release"
              ? await runRelease(
                  runId,
                  body.request,
                  request.signal,
                  dependencies.runtimeSecretFileSystem,
                )
              : action === "plan"
                ? await runPlan(runId, body.request, request.signal)
                : await runReviewedPlanApply(
                    runId,
                    action,
                    body.request,
                    request.signal,
                    request.headers.get(PROVIDER_LOCK_RESTORE_DIGEST_HEADER) ??
                      undefined,
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
      if (mutationRedactionScope) {
        await endRunCredentialRefreshSession(runId, credentialRefreshSessionHandle);
        clearRunRedactionValues(runId, requestRedactionValues);
      }
    }
  }
}

async function readBoundedJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("request too large");
  }
  if (!request.body) throw new Error("request body is missing");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value as Record<string, unknown>;
}
