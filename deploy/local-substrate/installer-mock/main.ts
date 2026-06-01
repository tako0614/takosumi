/**
 * Mock installer service for local-substrate.
 *
 * Returns the v1 InstallationDryRunResponse shape (source + InstallPlan +
 * planSnapshotDigest + expected guards) per the Source / Installation /
 * Deployment contract.
 *
 * Primary path: load pre-baked fixtures from /srv/fixtures/<repo>.json
 * (one per bundled app source fixture).
 *
 * Fallback path: if no fixture matches the repo, derive deterministic fake
 * values from sha256(gitUrl+ref) so smoke tests against arbitrary URLs
 * don't break — log a warning so the operator knows the wizard is running
 * blind.
 *
 * Wire env (worker → mock):
 *   TAKOSUMI_ACCOUNTS_INSTALLER_URL=http://installer-mock:8788
 */

import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? "8788");
const installations = new Map<string, Record<string, unknown>>();
const deployments = new Map<string, Record<string, unknown>>();

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function appIdFromGitUrl(gitUrl: string): string {
  try {
    const u = new URL(gitUrl);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "fake-app";
    return last.replace(/\.git$/, "");
  } catch {
    return "fake-app";
  }
}

const FIXTURE_DIR = "/srv/fixtures";

async function loadFixture(
  repoBasename: string,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(`${FIXTURE_DIR}/${repoBasename}.json`, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function dryRunPayload(
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | Response> {
  const source = (body.source ?? {}) as Record<string, unknown>;
  const gitUrl = String(source.url ?? source.gitUrl ?? body.gitUrl ?? "");
  const ref = String(source.ref ?? body.ref ?? "main");
  if (!gitUrl) {
    return Response.json({
      error: "invalid_request",
      error_description: "source.url required",
    }, { status: 400 });
  }

  const repoBasename = appIdFromGitUrl(gitUrl);

  // Fixture path: prepared source dry-run response if we have one.
  const fixture = await loadFixture(repoBasename);
  if (fixture) {
    const next = structuredClone(fixture);
    const src = (next.source ?? {}) as Record<string, unknown>;
    if (ref !== src.ref) {
      const fp = await sha256Hex(`${gitUrl}@${ref}`);
      const commit = fp.slice(0, 40);
      next.source = {
        ...src,
        ref,
        commit,
      };
      next.expected = { commit, planSnapshotDigest: `sha256:${fp}` };
      next.planSnapshotDigest = `sha256:${fp}`;
    }
    normalizeDryRunDigest(next);
    const changes = ((next.changes ?? []) as unknown[]).length;
    console.log(
      `[installer-mock] fixture-hit ${repoBasename} → appId=${next.appId} ` +
        `changes=${changes}`,
    );
    return next;
  }

  // Fallback: deterministic fake for arbitrary git URLs. Loud-warn so operator
  // knows the wizard is running blind.
  const fingerprint = await sha256Hex(`${gitUrl}@${ref}`);
  const commit = fingerprint.slice(0, 40);
  const digest = `sha256:${fingerprint}`;
  console.warn(
    `[installer-mock] FALLBACK no fixture for ${repoBasename}; ` +
      `returning empty changes[]. Run scripts/refresh-installer-fixtures.sh ` +
      `to add this repo to the fixture set.`,
  );

  return {
    repo: { name: repoBasename },
    appId: repoBasename,
    source: { kind: "git", url: gitUrl, ref, commit },
    planSnapshotDigest: digest,
    plan: { source: { kind: "git", url: gitUrl, ref, commit } },
    changes: [],
    expected: { commit, planSnapshotDigest: digest },
    metadata: {
      mock: true,
      fixture: false,
      service: "installer-mock (local-substrate)",
      generatedAt: new Date().toISOString(),
    },
  };
}

function normalizeDryRunDigest(payload: Record<string, unknown>): void {
  const expected = (payload.expected ?? {}) as Record<string, unknown>;
  payload.expected = expected;
}

function installApplyPayload(
  requestBody: Record<string, unknown>,
  dryRun: Record<string, unknown>,
): Record<string, unknown> | Response {
  const spaceId = String(requestBody.spaceId ?? requestBody.space_id ?? "");
  if (!spaceId) {
    return Response.json({
      error: "invalid_request",
      error_description: "spaceId required",
    }, { status: 400 });
  }
  const source = (dryRun.source ?? {}) as Record<string, unknown>;
  const expected = (dryRun.expected ?? {}) as Record<string, unknown>;
  const repo = (dryRun.repo ?? {}) as Record<string, unknown>;
  const appId = String(dryRun.appId ?? repo.name ?? "fake-app");
  const commit = String(source.commit ?? expected.commit ?? "");
  const planSnapshotDigest = String(
    dryRun.planSnapshotDigest ?? expected.planSnapshotDigest ?? "",
  );
  const fingerprintBase = `${spaceId}:${appId}:${commit}:${planSnapshotDigest}`;
  const idSuffix = crypto.randomUUID().slice(0, 8);
  const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const installationId = `inst_${safeAppId}_${idSuffix}`;
  const deploymentId = `dep_${safeAppId}_${idSuffix}`;
  return {
    installation: {
      id: installationId,
      spaceId,
      appId,
      currentDeploymentId: deploymentId,
      status: "ready",
      createdAt: Date.now(),
    },
    deployment: {
      id: deploymentId,
      installationId,
      source,
      planSnapshotDigest,
      status: "succeeded",
      outputs: { extensions: { mockFingerprint: fingerprintBase } },
      createdAt: Date.now(),
    },
  };
}

async function deploymentDryRunPayload(
  installationId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | Response> {
  const installation = installations.get(installationId);
  if (!installation) {
    return Response.json({
      error: { code: "not_found", message: "installation not found" },
    }, { status: 404 });
  }
  const currentDeploymentId = String(
    installation.currentDeploymentId ?? "",
  );
  const currentDeployment = currentDeploymentId
    ? deployments.get(currentDeploymentId)
    : undefined;
  const source = (body.source ?? currentDeployment?.source ?? {}) as Record<
    string,
    unknown
  >;
  const dryRun = await dryRunPayload({
    source,
    spaceId: installation.spaceId,
  });
  if (dryRun instanceof Response) return dryRun;
  const expected = (dryRun.expected ?? {}) as Record<string, unknown>;
  return {
    ...dryRun,
    expected: {
      ...expected,
      currentDeploymentId: currentDeploymentId || null,
    },
  };
}

async function deploymentApplyPayload(
  installationId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | Response> {
  const installation = installations.get(installationId);
  if (!installation) {
    return Response.json({
      error: { code: "not_found", message: "installation not found" },
    }, { status: 404 });
  }
  const expected = (body.expected ?? {}) as Record<string, unknown>;
  if (
    "currentDeploymentId" in expected &&
    expected.currentDeploymentId !== installation.currentDeploymentId
  ) {
    return Response.json({
      error: {
        code: "failed_precondition",
        message: "currentDeploymentId mismatch",
      },
    }, { status: 409 });
  }
  const dryRun = await deploymentDryRunPayload(installationId, body);
  if (dryRun instanceof Response) return dryRun;
  const dryRunExpected = (dryRun.expected ?? {}) as Record<string, unknown>;
  if (
    expected.commit && dryRunExpected.commit &&
    expected.commit !== dryRunExpected.commit
  ) {
    return Response.json({
      error: { code: "failed_precondition", message: "commit mismatch" },
    }, { status: 409 });
  }
  if (
    expected.planSnapshotDigest && dryRunExpected.planSnapshotDigest &&
    expected.planSnapshotDigest !== dryRunExpected.planSnapshotDigest
  ) {
    return Response.json({
      error: {
        code: "failed_precondition",
        message: "planSnapshotDigest mismatch",
      },
    }, { status: 409 });
  }
  const appId = String(installation.appId ?? "fake-app");
  const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const idSuffix = crypto.randomUUID().slice(0, 8);
  const deploymentId = `dep_${safeAppId}_${idSuffix}`;
  const deployment = {
    id: deploymentId,
    installationId,
    source: dryRun.source,
    planSnapshotDigest: dryRun.planSnapshotDigest,
    status: "succeeded",
    outputs: { extensions: { mockDeployment: true } },
    createdAt: Date.now(),
  };
  deployments.set(deploymentId, deployment);
  installations.set(installationId, {
    ...installation,
    currentDeploymentId: deploymentId,
    status: "ready",
  });
  return { deployment };
}

function rollbackPayload(
  installationId: string,
  body: Record<string, unknown>,
): Record<string, unknown> | Response {
  const installation = installations.get(installationId);
  if (!installation) {
    return Response.json({
      error: { code: "not_found", message: "installation not found" },
    }, { status: 404 });
  }
  const deploymentId = String(body.deploymentId ?? "");
  const deployment = deployments.get(deploymentId);
  if (!deployment || deployment.installationId !== installationId) {
    return Response.json({
      error: { code: "not_found", message: "deployment not found" },
    }, { status: 404 });
  }
  if (deployment.status !== "succeeded") {
    return Response.json({
      error: {
        code: "failed_precondition",
        message: "rollback target is not succeeded",
      },
    }, { status: 409 });
  }
  const rolledBackFrom = installation.currentDeploymentId ?? null;
  const updatedInstallation = {
    ...installation,
    currentDeploymentId: deploymentId,
    status: "ready",
  };
  installations.set(installationId, updatedInstallation);
  return {
    installation: updatedInstallation,
    deployment,
    rollback: {
      rolledBackFrom,
      rolledBackTo: deploymentId,
    },
  };
}

Bun.serve({ port: PORT, hostname: "0.0.0.0", fetch: async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }
  const isDryRun = url.pathname === "/v1/installations/dry-run";
  const isInstallApply = url.pathname === "/v1/installations";
  const deploymentDryRunMatch = url.pathname.match(
    /^\/v1\/installations\/([^/]+)\/deployments\/dry-run$/,
  );
  const deploymentApplyMatch = url.pathname.match(
    /^\/v1\/installations\/([^/]+)\/deployments$/,
  );
  const rollbackMatch = url.pathname.match(
    /^\/v1\/installations\/([^/]+)\/rollback$/,
  );
  if (
    !isDryRun && !isInstallApply && !deploymentDryRunMatch &&
    !deploymentApplyMatch && !rollbackMatch
  ) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (deploymentDryRunMatch) {
    const response = await deploymentDryRunPayload(
      decodeURIComponent(deploymentDryRunMatch[1]),
      body,
    );
    return response instanceof Response ? response : Response.json(response);
  }
  if (deploymentApplyMatch) {
    const response = await deploymentApplyPayload(
      decodeURIComponent(deploymentApplyMatch[1]),
      body,
    );
    return response instanceof Response
      ? response
      : Response.json(response, { status: 201 });
  }
  if (rollbackMatch) {
    const response = rollbackPayload(
      decodeURIComponent(rollbackMatch[1]),
      body,
    );
    return response instanceof Response ? response : Response.json(response);
  }

  const dryRun = await dryRunPayload(body);
  if (dryRun instanceof Response) return dryRun;
  if (isDryRun) return Response.json(dryRun);
  const apply = installApplyPayload(body, dryRun);
  if (apply instanceof Response) return apply;
  const installation = apply.installation as Record<string, unknown>;
  const deployment = apply.deployment as Record<string, unknown>;
  installations.set(String(installation.id), installation);
  deployments.set(String(deployment.id), deployment);
  return Response.json(apply, { status: 201 });
} });

console.log(`[installer-mock] listening on :${PORT}`);
