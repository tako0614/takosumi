// runner/lib/http_server.ts
//
// HTTP request router for the OpenTofu runner container.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import type { RunCredentialRefreshUpdate, RunRequest } from "./types.ts";
import { savedPlanStateMetadata, SAVED_PLAN_PREFLIGHT_MAX_BYTES } from "./saved_plan_state_metadata.ts";
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
import {
  assertRunRootOwnershipFor,
  RunRootOwnershipUnavailableError,
  withRunRootWriter,
  type RunRootOwnership,
} from "./run_root_ownership.ts";
import { RUN_ROOT } from "./constants.ts";
import { PROVIDER_LOCK_RESTORE_DIGEST_HEADER } from "./transport.ts";
import {
  completeLocalMutation,
  authorizeLocalMutationPreparation,
  consumeLocalMutationReservation,
  consumeLocalMutationPreparation,
  inspectLocalMutation,
  inspectLocalMutationPreparation,
  inspectLocalMutationPreparationCompletion,
  localMutationCompletionResponse,
  localMutationSuccessReadbackResponse,
  reserveLocalMutation,
  reserveLocalMutationPreparation,
  withLocalMutationGate,
  type LocalMutationSyncFault,
} from "./run_completion.ts";

interface RunnerRequestDependencies {
  readonly runtimeSecretFileSystem?: Partial<RuntimeSecretFileSystem>;
  /** Test/composition override; HTTP callers cannot select custody. */
  readonly mutationCustodyMode?: RunnerMutationCustodyMode;
  /** Private test/composition opt-in; default remains v1 until owner review. */
  readonly localPreparationV2?: boolean;
  /** Private filesystem fault injection; never selectable by an HTTP caller. */
  readonly localMutationSyncFault?: LocalMutationSyncFault;
  /** Acquired for the canonical RUN_ROOT before the server accepts requests. */
  readonly runRootOwnership?: RunRootOwnership;
}

export type RunnerMutationCustodyMode = "cloudflare-do" | "local-http";
const MUTATION_CUSTODY_MODE_ENV = "TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE";

export function runnerMutationCustodyMode(
  override?: RunnerMutationCustodyMode,
): RunnerMutationCustodyMode | undefined {
  if (override) return override;
  const configured = Bun.env[MUTATION_CUSTODY_MODE_ENV];
  if (configured === undefined || configured === "cloudflare-do")
    return "cloudflare-do";
  if (configured === "local-http") return "local-http";
  return undefined;
}

export async function handleRunnerRequest(request: Request): Promise<Response> {
  return await handleRunnerRequestWithDependencies(request);
}

export async function handleRunnerRequestWithDependencies(
  request: Request,
  dependencies: RunnerRequestDependencies = {},
): Promise<Response> {
  const custodyMode = runnerMutationCustodyMode(dependencies.mutationCustodyMode);
  if (!custodyMode) {
    return Response.json(
      { errorCode: "runner_mutation_custody_mode_invalid" },
      { status: 503 },
    );
  }
  const owner = dependencies.runRootOwnership;
  const v2 = custodyMode === "local-http" && dependencies.localPreparationV2 === true;
  const mayWrite = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
  if (v2 && !owner) return rootOwnershipUnavailable();
  if (custodyMode === "local-http" && owner && (v2 || mayWrite)) {
    try {
      assertRunRootOwnershipFor(owner, RUN_ROOT);
      if (mayWrite) {
        return await withRunRootWriter(owner, () =>
          handleRunnerRequestBody(request, dependencies, custodyMode));
      }
    } catch (error) {
      if (error instanceof RunRootOwnershipUnavailableError) {
        return rootOwnershipUnavailable();
      }
      throw error;
    }
  }
  return await handleRunnerRequestBody(request, dependencies, custodyMode);
}

function rootOwnershipUnavailable(): Response {
  return Response.json(
    { errorCode: "runner_run_root_ownership_unavailable" },
    { status: 503 },
  );
}

async function handleRunnerRequestBody(
  request: Request,
  dependencies: RunnerRequestDependencies,
  custodyMode: RunnerMutationCustodyMode,
): Promise<Response> {
  {
    const url = new URL(request.url);
    const indeterminate = () => Response.json(
      { errorCode: "runner_mutation_indeterminate", retryable: false },
      { status: 409 },
    );
    const guardedWorkspaceMutation = async (
      runId: string,
      execute: () => Promise<Response>,
    ): Promise<Response> => {
      if (custodyMode !== "local-http") return await execute();
      return await withLocalMutationGate(runId, async () => {
        const authorization = await authorizeLocalMutationPreparation(
          runId,
          request.headers.get("x-takosumi-preparation-attempt"),
          request.headers.get("x-takosumi-preparation-epoch"),
        );
        return authorization === "indeterminate" ? indeterminate() : await execute();
      });
    };
    const guardedNonMutationPost = async (
      runId: string,
      execute: () => Promise<Response>,
    ): Promise<Response> => {
      if (custodyMode !== "local-http") return await execute();
      return await withLocalMutationGate(runId, async () => {
        const preparation = await inspectLocalMutationPreparation(runId);
        return preparation === "absent" || preparation === "legacy"
          ? await execute()
          : indeterminate();
      });
    };
    if (url.pathname === "/healthz" || url.pathname === "/container/health") {
      return Response.json({
        ok: true,
        runner: "opentofu",
        capabilities: [
          "takosumi.runner-credential-refresh@v1",
          ...(custodyMode === "local-http" && dependencies.localPreparationV2 === true
            ? ["takosumi.local-mutation-preparation@v2"] : []),
        ],
        mutationCustodyMode: custodyMode,
      });
    }
    const credentialRefreshMatch = /^\/runs\/([^/]+)\/credentials$/.exec(
      url.pathname,
    );
    if (credentialRefreshMatch) {
      const runId = decodeURIComponent(credentialRefreshMatch[1]!);
      if (request.method === "GET") {
        const metadata = runCredentialRefreshSessionMetadata(runId);
        return metadata
          ? Response.json(metadata)
          : Response.json(
              { error: "credential refresh is not active" },
              { status: 409 },
            );
      }
      if (request.method !== "PUT") {
        return Response.json(
          { error: "method not allowed" },
          {
            status: 405,
            headers: { allow: "PUT" },
          },
        );
      }
      const refresh = async (): Promise<Response> => { try {
        const body = await readBoundedJsonObject(request, 64 * 1024);
        await refreshRunCredentials(
          runId,
          body as unknown as RunCredentialRefreshUpdate,
        );
        return Response.json({ ok: true, status: "updated" });
      } catch {
        // Never echo the update or a filesystem diagnostic: either may contain
        // bearer material or a private run path.
        return Response.json(
          { error: "credential refresh rejected" },
          { status: 409 },
        );
      } };
      if (custodyMode !== "local-http") return await refresh();
      return await withLocalMutationGate(runId, async () => {
        const preparation = await inspectLocalMutationPreparation(runId);
        if (preparation === "indeterminate") return indeterminate();
        if (preparation !== "absent" && preparation !== "legacy" &&
          !runCredentialRefreshSessionMetadata(runId)) return indeterminate();
        return await refresh();
      });
    }
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    const completionMatch = /^\/runs\/([^/]+)\/completion$/.exec(url.pathname);
    const reservationMatch = /^\/runs\/([^/]+)\/mutation-reservation$/.exec(
      url.pathname,
    );
    const preparationMatch = /^\/runs\/([^/]+)\/mutation-preparation$/.exec(
      url.pathname,
    );
    const planMetadataMatch = /^\/runs\/([^/]+)\/plan-state-metadata$/.exec(
      url.pathname,
    );
    if (planMetadataMatch) {
      if (request.method !== "POST") {
        return Response.json({ error: "method not allowed" }, {
          status: 405, headers: { allow: "POST" },
        });
      }
      try {
        const expectedDigest = request.headers.get("x-takosumi-plan-digest") ?? "";
        const bytes = await readBoundedRequestBytes(
          request, SAVED_PLAN_PREFLIGHT_MAX_BYTES,
        );
        return Response.json(await savedPlanStateMetadata(bytes, expectedDigest));
      } catch {
        // Never expose ZIP members or state values in an HTTP error.
        return Response.json({ error: "saved Plan metadata rejected" }, {
          status: 409,
        });
      }
    }
    if (preparationMatch) {
      if (custodyMode !== "local-http" || dependencies.localPreparationV2 !== true)
        return Response.json({ error: "not found" }, { status: 404 });
      if (request.method !== "PUT")
        return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow: "PUT" } });
      const runId = decodeURIComponent(preparationMatch[1]!);
      let envelope: Record<string, unknown>;
      try {
        envelope = await readBoundedJsonObject(request, 1024 * 1024);
      } catch {
        return indeterminate();
      }
      const action = envelope.action;
      const embeddedRun = envelope.request && typeof envelope.request === "object" &&
        "applyRun" in envelope.request ? envelope.request.applyRun : undefined;
      if ((action !== "apply" && action !== "destroy") || envelope.runId !== runId ||
        !envelope.request || typeof envelope.request !== "object" ||
        !embeddedRun || typeof embeddedRun !== "object" ||
        !("id" in embeddedRun) || embeddedRun.id !== runId ||
        typeof envelope.attemptId !== "string") return indeterminate();
      return await withLocalMutationGate(runId, async () => {
        try {
          const epoch = await reserveLocalMutationPreparation(
            runId, action, envelope.request, envelope.attemptId as string,
            request.headers.get(PROVIDER_LOCK_RESTORE_DIGEST_HEADER) ?? undefined,
            dependencies.localMutationSyncFault,
          );
          return epoch === undefined ? indeterminate() : Response.json({ epoch }, { status: 201 });
        } catch {
          return indeterminate();
        }
      });
    }
    if (reservationMatch) {
      if (custodyMode !== "local-http")
        return Response.json({ error: "not found" }, { status: 404 });
      if (request.method !== "PUT") {
        return Response.json(
          { error: "method not allowed" },
          { status: 405, headers: { allow: "PUT" } },
        );
      }
      const runId = decodeURIComponent(reservationMatch[1]!);
      const envelope = await readBoundedJsonObject(request, 1024 * 1024);
      const action = envelope.action;
      const embeddedRun =
        envelope.request &&
        typeof envelope.request === "object" &&
        "applyRun" in envelope.request
          ? envelope.request.applyRun
          : undefined;
      if (
        (action !== "apply" && action !== "destroy") ||
        envelope.runId !== runId ||
        !envelope.request ||
        typeof envelope.request !== "object" ||
        !embeddedRun ||
        typeof embeddedRun !== "object" ||
        !("id" in embeddedRun) ||
        embeddedRun.id !== runId
      ) {
        return Response.json(
          { errorCode: "runner_mutation_indeterminate", retryable: false },
          { status: 409 },
        );
      }
      const token = await withLocalMutationGate(runId, () => reserveLocalMutation(
        runId, action, envelope.request,
        request.headers.get(PROVIDER_LOCK_RESTORE_DIGEST_HEADER) ?? undefined,
      ));
      return token
        ? Response.json({ token }, { status: 201 })
        : Response.json(
            { errorCode: "runner_mutation_indeterminate", retryable: false },
            { status: 409 },
          );
    }
    if (completionMatch) {
      if (custodyMode !== "local-http")
        return Response.json({ error: "not found" }, { status: 404 });
      if (request.method !== "GET") {
        return Response.json(
          { error: "method not allowed" },
          { status: 405, headers: { allow: "GET" } },
        );
      }
      const runId = decodeURIComponent(completionMatch[1]!);
      const action = request.headers.get("x-takosumi-mutation-action");
      const digest = request.headers.get("x-takosumi-mutation-digest");
      const restoredProviderLockDigest =
        request.headers.get(PROVIDER_LOCK_RESTORE_DIGEST_HEADER) ?? undefined;
      if ((action !== "apply" && action !== "destroy") || !digest) {
        return Response.json(
          { errorCode: "runner_mutation_indeterminate", retryable: false },
          { status: 409 },
        );
      }
      const preparation = await inspectLocalMutationPreparationCompletion(
        runId, action, digest, restoredProviderLockDigest,
      );
      if (preparation === "preparing")
        return Response.json({ status: "preparing" }, { status: 202 });
      if (preparation === "indeterminate") return indeterminate();
      if (preparation !== "not-v2") {
        return preparation.outcome === "succeeded"
          ? await localMutationSuccessReadbackResponse(
              preparation,
              request.headers.get("x-takosumi-preparation-attempt"),
              request.headers.get("x-takosumi-preparation-epoch"),
            )
          : localMutationCompletionResponse(preparation);
      }
      const inspection = await inspectLocalMutation(
        runId,
        action,
        digest,
        restoredProviderLockDigest,
      );
      return inspection === "absent"
        ? Response.json({ status: "absent" }, { status: 404 })
        : inspection === "indeterminate"
          ? Response.json(
              { errorCode: "runner_mutation_indeterminate", retryable: false },
              { status: 409 },
            )
          : localMutationCompletionResponse(inspection);
    }
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
      const runId = decodeURIComponent(depStateRestoreMatch[1]!);
      return request.method === "PUT"
        ? await guardedWorkspaceMutation(runId, () => handleDepStateRestoreRequest(runId, decodeURIComponent(depStateRestoreMatch[2]!), request))
        : await handleDepStateRestoreRequest(runId, decodeURIComponent(depStateRestoreMatch[2]!), request);
    }
    if (sourceArchiveRestoreMatch) {
      const runId = decodeURIComponent(sourceArchiveRestoreMatch[1]!);
      return request.method === "PUT"
        ? await guardedWorkspaceMutation(runId, () => handleSourceArchiveRestoreRequest(runId, request))
        : await handleSourceArchiveRestoreRequest(runId, request);
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
      const runId = decodeURIComponent(providerLockfileRestoreMatch[1]!);
      return request.method === "PUT"
        ? await guardedWorkspaceMutation(runId, () => handleProviderLockfileRestoreRequest(runId, request))
        : await handleProviderLockfileRestoreRequest(runId, request);
    }
    if (artifactMatch) {
      const runId = decodeURIComponent(artifactMatch[1]!);
      return request.method === "PUT"
        ? await guardedWorkspaceMutation(runId, () => handlePlanArtifactRequest(runId, request))
        : await handlePlanArtifactRequest(runId, request);
    }
    if (stateArtifactMatch) {
      const runId = decodeURIComponent(stateArtifactMatch[1]!);
      return request.method === "PUT"
        ? await guardedWorkspaceMutation(runId, () => handleStateArtifactRequest(runId, request))
        : await handleStateArtifactRequest(runId, request);
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
      return await guardedNonMutationPost(runId, async () => { try {
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
      } });
    }

    if (isStableSemverTagRequest(body.request)) {
      const action = "stable_semver_tag";
      return await guardedNonMutationPost(runId, async () => { try {
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
      } });
    }

    const action = parseAction(body.action);
    if (!action) {
      return Response.json(
        { error: "invalid OpenTofu action" },
        { status: 400 },
      );
    }

    if ((action === "apply" || action === "destroy") && custodyMode === "local-http") {
      const embeddedRun =
        body.request &&
        typeof body.request === "object" &&
        "applyRun" in body.request
          ? body.request.applyRun
          : undefined;
      if (
        body.runId !== runId ||
        !body.request ||
        typeof body.request !== "object" ||
        (embeddedRun !== undefined &&
          (typeof embeddedRun !== "object" ||
            embeddedRun === null ||
            !("id" in embeddedRun) ||
            embeddedRun.id !== runId))
      ) {
        return Response.json(
          { errorCode: "runner_mutation_indeterminate", retryable: false },
          { status: 409 },
        );
      }
      const marker =
        request.headers.get(PROVIDER_LOCK_RESTORE_DIGEST_HEADER) ?? undefined;
      const reservation = request.headers.get(
        "x-takosumi-mutation-reservation",
      );
      const accepted = await withLocalMutationGate(runId, async () => {
        const preparation = await inspectLocalMutationPreparation(runId);
        if (preparation === "indeterminate") return false;
        if (preparation !== "absent" && preparation !== "legacy") {
          try {
            return await consumeLocalMutationPreparation(
              runId, action, body.request, marker,
              request.headers.get("x-takosumi-preparation-attempt"),
              request.headers.get("x-takosumi-preparation-epoch"),
              dependencies.localMutationSyncFault,
            );
          } catch {
            // A visible marker after uncertain fsync is not dispatch authority.
            return false;
          }
        }
        return reservation
          ? await consumeLocalMutationReservation(runId, action, body.request, marker, reservation)
          : false;
      });
      if (!accepted) {
        return Response.json(
          { errorCode: "runner_mutation_indeterminate", retryable: false },
          { status: 409 },
        );
      }
    }

    const executeRun = async (): Promise<Response> => {
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
      if ((action === "apply" || action === "destroy") && custodyMode === "local-http") {
        const completion = await completeLocalMutation(
          runId,
          action,
          body.request,
          result,
          request.headers.get(PROVIDER_LOCK_RESTORE_DIGEST_HEADER) ?? undefined,
        );
        if (completion.outcome === "provider_failed") {
          return Response.json(
            {
              ...result,
              ...(completion.stateDigest
                ? { stateDigest: completion.stateDigest }
                : {}),
            },
            { status: 500 },
          );
        }
      }
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
        await endRunCredentialRefreshSession(
          runId,
          credentialRefreshSessionHandle,
        );
        clearRunRedactionValues(runId, requestRedactionValues);
      }
    }
    };
    return action === "apply" || action === "destroy"
      ? await executeRun()
      : await guardedNonMutationPost(runId, executeRun);
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

async function readBoundedRequestBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
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
  return bytes;
}
