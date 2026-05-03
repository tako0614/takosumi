import { Command } from "@cliffy/command";
import { loadConfig, resolveMode } from "../config.ts";
import { callKernel } from "../remote_client.ts";

/**
 * `takosumi status [name]` — query the running kernel for deployment state.
 *
 * Local mode has no persistence (every CLI invocation creates a fresh
 * in-process kernel), so status reporting is a remote-only operation. We
 * surface a clear message instead of silently succeeding.
 *
 * Remote mode issues `GET /v1/deployments` (or `/v1/deployments/<name>` for a
 * single resource) and renders a small table. The kernel response shape is
 * intentionally permissive: any object with a `deployments` array is rendered
 * with the columns the array exposes. When the kernel returns 404 for the
 * route, the operator's kernel build does not expose status reporting yet —
 * we surface that explicitly rather than printing an empty table.
 */
export const statusCommand = new Command()
  .description("Show current deployment status (remote kernel only)")
  .arguments("[name:string]")
  .option("--remote <url:string>", "Remote kernel URL")
  .option("--token <token:string>", "Auth token")
  .action(async ({ remote, token }, name) => {
    const target = resolveMode({ remote, token }, await loadConfig());
    if (target.mode !== "remote") {
      console.log(
        "local mode does not maintain deployment state — use --remote " +
          "<kernel-url> to query a running kernel.",
      );
      return;
    }
    const path = name
      ? `/v1/deployments/${encodeURIComponent(name)}`
      : "/v1/deployments";
    const { status, body } = await callKernel({
      url: target.url,
      token: target.token,
      path,
      method: "GET",
    });
    if (status === 404) {
      console.error(
        `kernel at ${target.url} did not expose ${path} (HTTP 404). The ` +
          `kernel build may not yet support status queries — upgrade the ` +
          `kernel or use the internal control-plane API.`,
      );
      Deno.exit(1);
    }
    if (status >= 400) {
      console.error(`kernel returned ${status}:`, body);
      Deno.exit(1);
    }
    renderStatus(body);
  });

function renderStatus(body: unknown): void {
  const rows = extractRows(body);
  if (rows.length === 0) {
    console.log("no deployments");
    return;
  }
  const columns: readonly { key: string; label: string }[] = [
    { key: "deployment", label: "deployment" },
    { key: "name", label: "resource" },
    { key: "shape", label: "shape" },
    { key: "provider", label: "provider" },
    { key: "status", label: "status" },
  ];
  const widths = columns.map(({ key, label }) =>
    Math.max(
      label.length,
      ...rows.map((row) => String(readField(row, key) ?? "").length),
    )
  );
  const header = columns
    .map(({ label }, i) => label.padEnd(widths[i]))
    .join("  ");
  console.log(header);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    const line = columns
      .map(({ key }, i) => String(readField(row, key) ?? "").padEnd(widths[i]))
      .join("  ");
    console.log(line);
  }
}

/**
 * Flatten a deployment-list response into per-resource rows.
 *
 * The kernel response from `GET /v1/deployments` has the shape:
 *   { deployments: [{ name, status, resources: [{ name, shape, provider, status, ... }] }] }
 * Each row carries the deployment name (under `deployment`) plus the
 * resource-level fields. When a deployment has no resources (status =
 * destroyed or apply-failed), we still emit a single row with the
 * deployment-level status so the table reflects every record.
 */
function extractRows(body: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return flattenDeployments(body);
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.deployments)) {
      return flattenDeployments(record.deployments);
    }
    if (Array.isArray(record.resources)) {
      // Single-deployment response: lift `name` (deployment name) onto each
      // resource row before flattening.
      return flattenDeployments([record]);
    }
    if (record.name !== undefined || record.shape !== undefined) {
      return [record];
    }
  }
  return [];
}

function flattenDeployments(
  entries: readonly unknown[],
): readonly Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const deployment = entry as Record<string, unknown>;
    const deploymentName = String(deployment.name ?? "");
    const deploymentStatus = String(
      deployment.status ?? deployment.state ?? "",
    );
    const resources = Array.isArray(deployment.resources)
      ? deployment.resources
      : [];
    if (resources.length === 0) {
      rows.push({
        deployment: deploymentName,
        name: "",
        shape: "",
        provider: "",
        status: deploymentStatus,
      });
      continue;
    }
    for (const resource of resources) {
      if (
        typeof resource !== "object" || resource === null ||
        Array.isArray(resource)
      ) continue;
      rows.push({
        ...resource as Record<string, unknown>,
        deployment: deploymentName,
        // Default each row's status to the deployment-level status when the
        // resource itself does not override it (older kernel builds may omit
        // the per-resource `status` field).
        status: (resource as Record<string, unknown>).status ??
          deploymentStatus,
      });
    }
  }
  return rows;
}

function readField(
  row: Record<string, unknown>,
  key: string,
): unknown {
  const direct = row[key];
  if (direct !== undefined) return direct;
  // Common alternate field names the kernel might use.
  if (key === "provider" && row.providerId !== undefined) {
    return row.providerId;
  }
  if (key === "shape" && row.shapeId !== undefined) return row.shapeId;
  if (key === "status" && row.state !== undefined) return row.state;
  return undefined;
}
