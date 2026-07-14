// runner/lib/artifacts.ts
//
// Run workspace layout + artifact HTTP handlers (tfplan / tfplan-json / tfstate) + module-info/state restore.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunWorkspace } from "./types.ts";
import { RUN_ROOT, DEFAULT_PLAN_JSON_ARTIFACT_MAX_BYTES } from "./constants.ts";
import { isRecord, safeRunId, digestBytes } from "./util.ts";

// Stores the full `tofu show -json tfplan` JSON next to the plan binary so the
// DO/relay can promote it. The DO already promotes the tfplan binary; the
// plan-JSON sits beside it under the run root and is surfaced via the
// /artifacts/tfplan-json route below.
export interface PlanJsonArtifactWriteResult {
  readonly written: boolean;
  readonly sizeBytes: number;
  readonly maxBytes: number;
}

export async function writePlanJsonArtifact(
  workspace: RunWorkspace,
  planJson: string,
): Promise<PlanJsonArtifactWriteResult> {
  const bytes = new TextEncoder().encode(planJson);
  const maxBytes = planJsonArtifactMaxBytes();
  if (bytes.byteLength > maxBytes) {
    return { written: false, sizeBytes: bytes.byteLength, maxBytes };
  }
  await mkdir(workspace.root, { recursive: true });
  await writeFile(planJsonPath(workspace), bytes);
  return { written: true, sizeBytes: bytes.byteLength, maxBytes };
}

export function planJsonPath(workspace: RunWorkspace): string {
  return join(workspace.root, "tfplan.json");
}

function planJsonArtifactMaxBytes(): number {
  const raw = Bun.env.TAKOSUMI_PLAN_JSON_ARTIFACT_MAX_BYTES;
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PLAN_JSON_ARTIFACT_MAX_BYTES;
}

export async function handlePlanJsonArtifactRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json(
      { error: "method not allowed" },
      { status: 405, headers: { allow: "GET" } },
    );
  }
  try {
    const bytes = await readFile(planJsonPath(workspaceForRun(runId)));
    return new Response(bytes, {
      headers: {
        "content-type": "application/json",
        "content-length": String(bytes.byteLength),
      },
    });
  } catch {
    return Response.json(
      { error: "plan-json artifact not found" },
      { status: 404 },
    );
  }
}

export async function handlePlanArtifactRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  const workspace = workspaceForRun(runId);
  if (request.method === "GET") {
    try {
      const bytes = await readFile(workspace.planPath);
      return new Response(bytes, {
        headers: {
          "content-type": "application/vnd.opentofu.plan",
          "content-length": String(bytes.byteLength),
        },
      });
    } catch {
      return Response.json(
        { error: "plan artifact not found" },
        { status: 404 },
      );
    }
  }
  if (request.method === "PUT") {
    await mkdir(workspace.root, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    await writeFile(workspace.planPath, bytes);
    return Response.json({
      runId,
      artifact: "tfplan",
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  }
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { allow: "GET, PUT" } },
  );
}

export function workspaceForRun(runId: string): RunWorkspace {
  const root = join(RUN_ROOT, safeRunId(runId));
  const sourceRoot = join(root, "source");
  return {
    root,
    sourceRoot,
    moduleDir: sourceRoot,
    planPath: join(root, "tfplan"),
    restoredStatePath: join(root, "restored.tfstate"),
    moduleInfoPath: join(root, "module-info.json"),
    generatedRootDir: join(root, "generated-root"),
    childModuleDir: join(root, "generated-root", "module"),
    artifactDir: join(root, "artifact"),
    // The deps dir is a SIBLING of root (not under it) so the producer state
    // files restored BEFORE the run POST survive the plan/apply workspace prep,
    // which wipes `root`. The consumer's `terraform_remote_state` data sources
    // reference these absolute paths; they are written read-only (one-way read).
    depsDir: join(RUN_ROOT, `${safeRunId(runId)}-deps`),
  };
}

export async function handleStateArtifactRequest(
  runId: string,
  request: Request,
): Promise<Response> {
  const workspace = workspaceForRun(runId);
  if (request.method === "GET") {
    const moduleDir = await readModuleDir(workspace);
    try {
      const bytes = await readFile(join(moduleDir, "terraform.tfstate"));
      return new Response(bytes, {
        headers: {
          "content-type": "application/json",
          "content-length": String(bytes.byteLength),
        },
      });
    } catch {
      return Response.json(
        { error: "state artifact not found" },
        { status: 404 },
      );
    }
  }
  if (request.method === "PUT") {
    await mkdir(workspace.root, { recursive: true });
    const bytes = new Uint8Array(await request.arrayBuffer());
    await writeFile(workspace.restoredStatePath, bytes);
    return Response.json({
      runId,
      artifact: "tfstate",
      digest: await digestBytes(bytes),
      sizeBytes: bytes.byteLength,
    });
  }
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { allow: "GET, PUT" } },
  );
}

export async function writeModuleInfo(
  workspace: RunWorkspace,
  moduleDir: string,
): Promise<void> {
  await writeFile(
    workspace.moduleInfoPath,
    `${JSON.stringify({ moduleDir })}\n`,
  );
}

export async function readModuleDir(workspace: RunWorkspace): Promise<string> {
  try {
    const parsed = JSON.parse(
      await readFile(workspace.moduleInfoPath, "utf8"),
    ) as unknown;
    if (isRecord(parsed) && typeof parsed.moduleDir === "string") {
      return parsed.moduleDir;
    }
  } catch {
    // Fall through to the default root-module state path.
  }
  return workspace.sourceRoot;
}

export async function restoreUploadedState(
  workspace: RunWorkspace,
  moduleDir: string,
): Promise<void> {
  try {
    const bytes = await readFile(workspace.restoredStatePath);
    await writeFile(join(moduleDir, "terraform.tfstate"), bytes);
  } catch {
    // No previous state exists for first create plans.
  }
}
