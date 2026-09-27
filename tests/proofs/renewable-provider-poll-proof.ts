import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { workspaceForRun } from "../../runner/lib/artifacts.ts";
import { handleRunnerRequest } from "../../runner/lib/http_server.ts";
import { runPlan } from "../../runner/lib/plan_apply.ts";
import { RunCredentialBroker } from "../../core/domains/deploy-control/run_credential_broker.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import { PhaseMintBundle, type ConnectionVault } from "../../core/adapters/vault/mod.ts";
import type { ResolvedCapsuleProviderBinding } from "../../core/domains/connections/mod.ts";
import type { PlanRun } from "../../contract/internal-deploy-control-api.ts";

const PROVIDER_BINARY = Bun.env.TAKOSUMI_TEST_TAKOFORM_PROVIDER_BINARY;
const PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";
const API_ROOT = "/apis/forms.takoform.com/v1";
const INITIAL = "initial_local_run_token_0123456789abcdef";
const RENEWED = "renewed_local_run_token_0123456789abcdef";

test("a real Takoform provider polls one accepted operation with a rotated runner credential file", async () => {
  if (!PROVIDER_BINARY) {
    throw new Error("TAKOSUMI_TEST_TAKOFORM_PROVIDER_BINARY is required for this explicit local proof");
  }
  const runId = `renewable-provider-${crypto.randomUUID()}`;
  const applyRunId = `apply-${crypto.randomUUID()}`;
  const workspace = workspaceForRun(runId);
  const mirror = await mkdtemp(join(tmpdir(), "takosumi-refresh-mirror-"));
  const originalMirror = Bun.env.OPENTOFU_PROVIDER_MIRROR;
  let firstPollSeen!: () => void;
  const firstPoll = new Promise<void>((resolve) => { firstPollSeen = resolve; });
  let mutations = 0;
  let polls = 0;
  let expectedToken = INITIAL;
  let savedResource: Record<string, unknown> | undefined;
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const json = (body: unknown, status = 200, headers?: HeadersInit) =>
        Response.json(body, { status, headers });
      const error = (code: string, status: number) =>
        json({ error: { code, message: code, requestId: "local", retryable: false } }, status);
      if (request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
        return error("unauthenticated", 401);
      }
      if (url.pathname === "/.well-known/takoform/v1") {
        return json({
          api_versions: ["forms.takoform.com/v1"],
          features: Object.fromEntries([
            "service_forms", "exact_form_ref", "optimistic_concurrency",
            "idempotent_lifecycle", "operations", "artifact_upload", "support_profiles",
          ].map((name) => [name, true])),
          endpoints: { api: `http://127.0.0.1:${host.port}${API_ROOT}` },
        });
      }
      if (url.pathname === `${API_ROOT}/forms`) {
        const identity = { formRef: {
          apiVersion: url.searchParams.get("group"),
          kind: url.searchParams.get("kind"),
          definitionVersion: url.searchParams.get("definitionVersion"),
          schemaDigest: url.searchParams.get("schemaDigest"),
        } };
        return json({ forms: [{ identity, definitionKnown: true, installed: true,
          executable: true, activated: true, availableToPrincipal: true,
          operations: ["create", "read", "update", "delete", "import", "observe"] }] });
      }
      if (url.pathname === `${API_ROOT}/resources/validate`) {
        return json({ valid: true, diagnostics: [] });
      }
      if (url.pathname === `${API_ROOT}/resources/prepare`) {
        const body = await request.json() as Record<string, unknown>;
        const spec = body.spec ?? {};
        const specDigest = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
        return json({ resource: {
          apiVersion: body.apiVersion, kind: body.kind, form: body.form,
          metadata: body.metadata, spec,
        }, review: {
          prepareDigest: `sha256:${"b".repeat(64)}`,
          specDigest: `sha256:${specDigest}`,
        } });
      }
      if (url.pathname.startsWith(`${API_ROOT}/operations/`)) {
        polls++;
        if (polls === 1) {
          firstPollSeen();
          return json({ apiVersion: "operations.takoform.com/v1alpha1",
            kind: "Operation", id: "op_local", done: false }, 200,
          { "Retry-After": "1" });
        }
        return json({ apiVersion: "operations.takoform.com/v1alpha1",
          kind: "Operation", id: "op_local", done: true,
          result: { resource: savedResource } });
      }
      if (url.pathname.startsWith(`${API_ROOT}/resources/`)) {
        if (request.method === "GET") {
          return savedResource ? json(savedResource) : error("resource_not_found", 404);
        }
        if (request.method === "PUT") {
          mutations++;
          const body = await request.json() as Record<string, unknown>;
          savedResource = {
            apiVersion: body.apiVersion,
            kind: body.kind,
            form: body.form,
            metadata: { ...(body.metadata as object), uid: "uid-1",
              generation: "1", revision: "1" },
            spec: body.spec,
            status: { observedGeneration: "1", conditions: [{ type: "Ready",
              status: "True", reason: "Available",
              lastTransitionTime: "2026-09-27T00:00:00Z" }] },
          };
          return json({ operation: { apiVersion: "operations.takoform.com/v1alpha1",
            kind: "Operation", id: "op_local", done: false,
            target: { uid: "uid-1" } } }, 202, { "Retry-After": "0" });
        }
      }
      // Support profiles are optional; an unavailable profile does not deny an
      // otherwise available Form during Plan.
      return error("unavailable", 503);
    },
  });
  const manifest = { bindings: [{
    providerSource: PROVIDER_SOURCE,
    connectionId: "conn-local",
    recipeId: "local-renewable",
    authMode: "run",
    envNames: ["TAKOFORM_TOKEN"],
    fileEnvNames: ["TAKOFORM_TOKEN_FILE"],
    requiredEnvGroups: [["TAKOFORM_TOKEN"]],
    renewableEnv: { sourceEnvName: "TAKOFORM_TOKEN",
      fileEnvName: "TAKOFORM_TOKEN_FILE", minimumProviderVersion: "4.1.0" },
  }] };
  let issueCount = 0;
  const binding = {
    provider: PROVIDER_SOURCE,
    connection: {
      id: "conn-local", workspaceId: "workspace-local",
      provider: PROVIDER_SOURCE, providerSource: PROVIDER_SOURCE,
      scope: "workspace", status: "verified", materialization: "run-issued",
      envNames: ["TAKOFORM_TOKEN"],
      credentialRecipe: { id: "local-renewable", authMode: "run",
        renewableEnv: { sourceEnvName: "TAKOFORM_TOKEN",
          fileEnvName: "TAKOFORM_TOKEN_FILE", minimumProviderVersion: "4.1.0" } },
      createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z",
    },
    materialization: "run-issued",
  } as ResolvedCapsuleProviderBinding;
  const broker = new RunCredentialBroker({
    store: new InMemoryOpenTofuControlStore(),
    newId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
    now: () => Date.now(),
    vault: { mintForCapsuleProviderBindings: async () => {
      const value = issueCount++ === 0 ? INITIAL : RENEWED;
      return new PhaseMintBundle(
        { env: { TAKOFORM_TOKEN: value } }, [],
        [{ provider: PROVIDER_SOURCE, connectionId: "conn-local",
          temporary: true, ttlEnforced: true, ttlSeconds: 300,
          expiresAt: new Date(Date.now() + 300_000).toISOString() }],
      );
    } } as unknown as ConnectionVault,
    resolveRunProviderBindings: async () => [binding],
    policyForPlanRun: async () => undefined,
  });
  const brokerPlan = {
    id: runId, workspaceId: "workspace-local", capsuleId: "capsule-local",
    capsuleContext: { workspaceId: "workspace-local",
      capsuleId: "capsule-local", environment: "test" },
    requiredProviders: [PROVIDER_SOURCE],
  } as unknown as PlanRun;
  const base = {
    planRun: { operation: "create", source: { kind: "git",
      url: "https://example.test/local.git", commit: "a".repeat(40) } },
    requiredProviders: [PROVIDER_SOURCE],
    runnerProfile: { id: "local-provider-refresh",
      allowedProviders: [PROVIDER_SOURCE], requireProviderBindings: true,
      resourceLimits: { maxRunSeconds: 30 } },
    providerInstallationPolicy: { requireMirror: true },
  };
  try {
    const providerDir = join(mirror, "registry.terraform.io", "tako0614", "takoform", "4.1.0", "linux_amd64");
    await mkdir(providerDir, { recursive: true });
    const providerCopy = join(providerDir, "terraform-provider-takoform_v4.1.0");
    await copyFile(PROVIDER_BINARY, providerCopy);
    await chmod(providerCopy, 0o755);
    Bun.env.OPENTOFU_PROVIDER_MIRROR = mirror;
    await mkdir(workspace.sourceRoot, { recursive: true });
    await writeFile(join(workspace.sourceRoot, "main.tf"), `terraform {
  required_providers {
    takoform = {
      source  = "registry.terraform.io/tako0614/takoform"
      version = "4.1.0"
    }
  }
}
provider "takoform" {
  endpoint = "http://127.0.0.1:${host.port}"
  space    = "prod"
}
resource "takoform_module_worker" "example" {
  name = "local-worker"
}
`);
    const planned = await runPlan(runId, {
      ...base,
      credentials: { env: { TAKOFORM_TOKEN: INITIAL },
        manifest: { bindings: [{ ...manifest.bindings[0], fileEnvNames: [],
          renewableEnv: undefined }] } },
    });
    expect(planned.status).toBe("succeeded");
    const issued = await broker.mintRunCredentials(brokerPlan, "apply", applyRunId);
    expect(issued?.renewable).toHaveLength(1);
    const manifestDigest = issued!.manifestDigest!;
    const applyRequest = {
      ...base,
      applyRun: { id: applyRunId },
      planArtifact: planned.planArtifact,
      credentials: issued,
    };
    const applying = handleRunnerRequest(new Request(`http://runner.local/runs/${runId}`, {
      method: "POST", body: JSON.stringify({ action: "apply", request: applyRequest }),
    }));
    await Promise.race([
      firstPoll,
      applying.then(async (response) => {
        const body = await response.clone().json() as Record<string, unknown>;
        const detail = String(body.stderr ?? "").replaceAll(INITIAL, "[redacted]").replaceAll(RENEWED, "[redacted]");
        throw new Error(`apply finished before operation poll: ${response.status} ${String(body.status)} ${String(body.exitCode)} ${detail}`);
      }),
      Bun.sleep(15_000).then(() => { throw new Error("provider did not poll accepted operation"); }),
    ]);
    const renewed = await broker.renewRunCredential(
      brokerPlan, "apply", applyRunId, "conn-local",
    );
    const refreshed = await handleRunnerRequest(new Request(`http://runner.local/runs/${runId}/credentials`, {
      method: "PUT", body: JSON.stringify({
        owner: { kind: "apply", id: applyRunId },
        runnerRunId: runId, manifestDigest,
        sequence: 1, credentials: [{ ...renewed.renewable![0],
          value: renewed.env.TAKOFORM_TOKEN }],
      }),
    }));
    expect(refreshed.status).toBe(200);
    expectedToken = RENEWED;
    const result = await applying;
    const body = await result.json() as Record<string, unknown>;
    expect(body.status).toBe("succeeded");
    expect(mutations).toBe(1);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(issueCount).toBe(2);
    expect(JSON.stringify(body)).not.toContain(INITIAL);
    expect(JSON.stringify(body)).not.toContain(RENEWED);
    const siblings = await readdir(dirname(workspace.root));
    expect(siblings.some((name) => name.startsWith(`${basename(workspace.root)}-credentials-`))).toBe(false);
  } finally {
    host.stop(true);
    if (originalMirror === undefined) delete Bun.env.OPENTOFU_PROVIDER_MIRROR;
    else Bun.env.OPENTOFU_PROVIDER_MIRROR = originalMirror;
    await rm(workspace.root, { recursive: true, force: true });
    await rm(workspace.depsDir, { recursive: true, force: true });
    await rm(mirror, { recursive: true, force: true });
  }
}, 30_000);
