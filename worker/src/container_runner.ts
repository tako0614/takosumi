import type {
  OpenTofuApplyJob,
  OpenTofuApplyResult,
  OpenTofuCapsuleSourceFile,
  OpenTofuCapsuleSourceFilesJob,
  OpenTofuDestroyJob,
  OpenTofuDestroyResult,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
  OpenTofuSourceSyncJob,
  OpenTofuSourceSyncResult,
} from "../../src/service/domains/deploy-control/mod.ts";
import type {
  CloudflareWorkerEnv,
  OpenTofuRunQueueMessage,
} from "./bindings.ts";
import { redactString } from "../../src/service/services/observability/redaction.ts";

/**
 * Implements {@link OpenTofuRunner} over the RUNNER Durable Object: each
 * plan/apply/destroy/source_sync run POSTs its job to the OpenTofu Container
 * runner DO and parses the DO's JSON result back into the controller's result
 * shape. Credential values and run bodies are never logged.
 */
export class CloudflareContainerOpenTofuRunner implements OpenTofuRunner {
  constructor(private readonly env: CloudflareWorkerEnv) {}

  async plan(job: OpenTofuPlanJob): Promise<OpenTofuPlanResult> {
    const result = await this.#runContainer("plan", job.planRun.id, job);
    const planDigest =
      stringFromRecord(result, "planDigest") ??
      (await digestJson({
        action: "plan",
        runId: job.planRun.id,
        stdout: stringFromRecord(result, "stdout") ?? "",
        stderr: stringFromRecord(result, "stderr") ?? "",
      }));
    const planArtifact = planArtifactFromContainerResult(
      result,
      job.planRun.id,
      planDigest,
    );
    return {
      planDigest,
      planArtifact,
      ...(stringArrayFromRecord(result, "requiredProviders")
        ? {
            requiredProviders: stringArrayFromRecord(
              result,
              "requiredProviders",
            ),
          }
        : {}),
      ...(stringFromRecord(result, "sourceCommit")
        ? { sourceCommit: stringFromRecord(result, "sourceCommit") }
        : {}),
      ...(stringFromRecord(result, "providerLockDigest")
        ? {
            providerLockDigest: stringFromRecord(result, "providerLockDigest"),
          }
        : {}),
      ...(recordFromRecord(result, "summary")
        ? {
            summary: recordFromRecord(
              result,
              "summary",
            ) as OpenTofuPlanResult["summary"],
          }
        : {}),
      diagnostics: diagnosticsFromContainerResult(result),
    };
  }

  async apply(job: OpenTofuApplyJob): Promise<OpenTofuApplyResult> {
    const result = await this.#runContainer(
      "apply",
      runnerRunIdFromPlanArtifact(job.planArtifact) ?? job.planRun.id,
      job,
    );
    // The DO echoes the persisted state pointer (`state.digest`) and, for an
    // apply that produced outputs, the encrypted raw-output artifact key
    // (`rawOutputsKey`, spec §26). Thread both onto the result so the controller
    // records them on the StateSnapshot / OutputSnapshot.
    const state = recordFromRecord(result, "state");
    return {
      ...(recordFromRecord(result, "outputs")
        ? {
            outputs: recordFromRecord(
              result,
              "outputs",
            ) as OpenTofuApplyResult["outputs"],
          }
        : {}),
      ...(state && stringFromRecord(state, "digest")
        ? { stateDigest: stringFromRecord(state, "digest") }
        : {}),
      ...(stringFromRecord(result, "rawOutputsKey")
        ? { rawOutputsKey: stringFromRecord(result, "rawOutputsKey") }
        : {}),
      diagnostics: diagnosticsFromContainerResult(result),
    };
  }

  async destroy(job: OpenTofuDestroyJob): Promise<OpenTofuDestroyResult> {
    const result = await this.#runContainer(
      "destroy",
      runnerRunIdFromPlanArtifact(job.planArtifact) ?? job.planRun.id,
      job,
    );
    return { diagnostics: diagnosticsFromContainerResult(result) };
  }

  async sourceSync(
    job: OpenTofuSourceSyncJob,
  ): Promise<OpenTofuSourceSyncResult> {
    // The runner resolves the ref, fetches a shallow checkout, builds the
    // deterministic archive, and PUTs its bytes to the source-archive route on
    // the DO (which persists them to R2_SOURCE under archiveObjectKey). It then
    // returns only the resolved commit + archive metadata. The request carries
    // the source-phase mint result (git env + files); never logged.
    const result = await this.#runContainer("source_sync", job.runId, {
      action: "source_sync",
      runId: job.runId,
      source: job.source,
      archiveObjectKey: job.archiveObjectKey,
      ...(job.credentials ? { credentials: job.credentials } : {}),
    });
    // The DO persists the archive to R2_SOURCE and rewrites `sourceArchive` to
    // the object-storage form ({ digest, sizeBytes }); `resolvedCommit` stays at
    // the top level. Read both top-level and `sourceArchive` so either shape is
    // accepted.
    const archive = recordFromRecord(result, "sourceArchive");
    const resolvedCommit = stringFromRecord(result, "resolvedCommit");
    const archiveDigest =
      stringFromRecord(result, "archiveDigest") ??
      (archive ? stringFromRecord(archive, "digest") : undefined);
    const archiveSizeBytes =
      typeof result.archiveSizeBytes === "number"
        ? result.archiveSizeBytes
        : archive && typeof archive.sizeBytes === "number"
          ? archive.sizeBytes
          : undefined;
    if (!resolvedCommit || !archiveDigest || archiveSizeBytes === undefined) {
      throw new Error(
        `OpenTofu runner source_sync ${job.runId} returned an incomplete result`,
      );
    }
    return { resolvedCommit, archiveDigest, archiveSizeBytes };
  }

  async readCapsuleSourceFiles(
    job: OpenTofuCapsuleSourceFilesJob,
  ): Promise<readonly OpenTofuCapsuleSourceFile[]> {
    const result = await this.#runContainer("compatibility_check", job.runId, {
      sourceArchive: {
        objectKey: job.sourceSnapshot.archiveObjectKey,
        digest: job.sourceSnapshot.archiveDigest,
      },
    });
    const files = result.files;
    if (!Array.isArray(files)) {
      throw new Error(
        `OpenTofu runner compatibility_check ${job.runId} returned no files`,
      );
    }
    return files.map((entry) => {
      if (!isRecord(entry)) {
        throw new Error("compatibility_check file entry must be an object");
      }
      const path = stringFromRecord(entry, "path");
      const text = stringFromRecord(entry, "text");
      if (!path || text === undefined) {
        throw new Error(
          "compatibility_check file entry requires path and text",
        );
      }
      return { path, text };
    });
  }

  async #runContainer(
    action: OpenTofuRunQueueMessage["action"],
    runId: string,
    request: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.env.RUNNER) {
      throw new Error("RUNNER binding is not configured");
    }
    const id = this.env.RUNNER.idFromName(runId);
    const response = await this.env.RUNNER.get(id).fetch(
      new Request(
        `https://opentofu-runner.internal/runs/${encodeURIComponent(runId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "takosumi.opentofu-run@v1",
            action,
            runId,
            requestedAt: new Date().toISOString(),
            request,
          }),
        },
      ),
    );
    const payload = await readResponseJsonObject(response);
    if (!response.ok) {
      throw new Error(
        `OpenTofu runner rejected ${action} run ${runId}: ${response.status}`,
      );
    }
    return payload;
  }
}

async function readResponseJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length === 0) return {};
  const value = JSON.parse(text) as unknown;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("OpenTofu runner response must be a JSON object");
}

function diagnosticsFromContainerResult(
  result: Record<string, unknown>,
): OpenTofuPlanResult["diagnostics"] {
  const stderr = stringFromRecord(result, "stderr");
  return stderr && stderr.trim().length > 0
    ? [{ severity: "warning", message: redactRunnerDiagnosticText(stderr) }]
    : [];
}

function redactRunnerDiagnosticText(text: string): string {
  return redactString(text, { redactedValue: "[redacted]" });
}

function planArtifactFromContainerResult(
  result: Record<string, unknown>,
  runId: string,
  planDigest: string,
): OpenTofuPlanResult["planArtifact"] {
  const artifact = recordFromRecord(result, "planArtifact");
  if (!artifact) {
    throw new Error(
      `OpenTofu runner plan ${runId} did not return a planArtifact`,
    );
  }
  const kind = stringFromRecord(artifact, "kind");
  const ref = stringFromRecord(artifact, "ref");
  const digest = stringFromRecord(artifact, "digest");
  if (!kind || !ref || !digest) {
    throw new Error(
      `OpenTofu runner plan ${runId} returned an incomplete planArtifact`,
    );
  }
  if (digest !== planDigest) {
    throw new Error(
      `OpenTofu runner plan ${runId} returned a planArtifact digest that does not match planDigest`,
    );
  }
  return {
    kind,
    ref,
    digest,
    ...(stringFromRecord(artifact, "contentType")
      ? { contentType: stringFromRecord(artifact, "contentType") }
      : {}),
    ...(typeof artifact?.sizeBytes === "number"
      ? { sizeBytes: artifact.sizeBytes }
      : {}),
    ...(typeof artifact?.createdAt === "number"
      ? { createdAt: artifact.createdAt }
      : {}),
  };
}

function runnerRunIdFromPlanArtifact(
  artifact: OpenTofuPlanResult["planArtifact"],
): string | undefined {
  const runnerLocal = /^runner-local:\/\/([^/]+)\/tfplan$/.exec(artifact.ref);
  if (runnerLocal?.[1]) return runnerLocal[1];
  const r2Plan = /^r2:\/\/[^/]+\/opentofu-plan-runs\/([^/]+)\/tfplan$/.exec(
    artifact.ref,
  );
  return r2Plan?.[1];
}

function stringArrayFromRecord(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function stringFromRecord(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordFromRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? true
    : false;
}

async function digestJson(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
