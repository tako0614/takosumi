import { Command } from "@cliffy/command";
import { loadConfig, resolveMode } from "../config.ts";
import { callKernel } from "../remote_client.ts";

function createAuditCommand() {
  return new Command()
    .description("Inspect deployment audit chains from a remote kernel")
    .command("show", createAuditShowCommand());
}

function createAuditShowCommand() {
  return new Command()
    .description(
      "Show WAL / provenance / rollback cause chain for a deployment",
    )
    .arguments("<deployment:string>")
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Auth token")
    .action(async ({ remote, token }, deployment) => {
      const target = resolveMode({ remote, token }, await loadConfig());
      if (target.mode !== "remote") {
        console.log(
          "local mode does not maintain deployment audit history — use " +
            "--remote <kernel-url> to query a running kernel.",
        );
        return;
      }
      const result = await fetchDeploymentAudit({
        url: target.url,
        token: target.token,
        deployment,
      });
      if (result.status === 404) {
        console.error(`deployment ${deployment} not found`);
        Deno.exit(1);
      }
      if (result.status >= 400) {
        console.error(`kernel returned ${result.status}:`, result.body);
        Deno.exit(1);
      }
      renderAudit(result.body);
    });
}

async function fetchDeploymentAudit(input: {
  readonly url: string;
  readonly token?: string;
  readonly deployment: string;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const direct = await getAudit(input.url, input.token, input.deployment);
  if (direct.status !== 404) return direct;
  const list = await callKernel({
    url: input.url,
    token: input.token,
    path: "/v1/deployments",
    method: "GET",
  });
  if (list.status >= 400) return direct;
  const resolvedName = resolveDeploymentName(list.body, input.deployment);
  return resolvedName
    ? await getAudit(input.url, input.token, resolvedName)
    : direct;
}

function getAudit(
  url: string,
  token: string | undefined,
  deploymentName: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return callKernel({
    url,
    token,
    path: `/v1/deployments/${encodeURIComponent(deploymentName)}/audit`,
    method: "GET",
  });
}

function resolveDeploymentName(
  body: unknown,
  idOrName: string,
): string | undefined {
  const deployments = isRecord(body) && Array.isArray(body.deployments)
    ? body.deployments
    : [];
  for (const item of deployments) {
    if (!isRecord(item)) continue;
    const id = readString(item.id);
    const name = readString(item.name);
    if ((id && id === idOrName) || (name && name === idOrName)) {
      return name;
    }
  }
  return undefined;
}

function renderAudit(body: unknown): void {
  const audit = isRecord(body) && isRecord(body.audit) ? body.audit : undefined;
  if (!audit) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const deployment = isRecord(audit.deployment) ? audit.deployment : {};
  const id = readString(deployment.id) ?? "";
  const name = readString(deployment.name) ?? "";
  const status = readString(deployment.status) ?? "";
  const tenant = readString(deployment.tenantId) ?? "";
  console.log(
    `deployment ${name || "<unknown>"}${id ? ` (${id})` : ""} ` +
      `status=${status || "unknown"}${tenant ? ` tenant=${tenant}` : ""}`,
  );
  const journal = isRecord(audit.journal) ? audit.journal : undefined;
  if (journal) {
    const phase = readString(journal.phase) ?? "";
    const stage = readString(journal.latestStage) ?? "";
    const journalStatus = readString(journal.status) ?? "";
    const digest = readString(journal.operationPlanDigest) ?? "";
    const terminal = String(journal.terminal ?? "");
    console.log(
      `journal ${phase}:${stage}/${journalStatus} terminal=${terminal} ` +
        `digest=${digest}`,
    );
  }
  renderProvenance(audit.provenance);
  renderCauseChain(audit.causeChain);
  renderRevokeDebts(audit.revokeDebts);
}

function renderProvenance(value: unknown): void {
  if (!isRecord(value)) return;
  console.log(
    `provenance workflowRunId=${readString(value.workflowRunId) ?? ""}`,
  );
  const git = isRecord(value.git) ? value.git : undefined;
  if (git) {
    console.log(
      `git commit=${readString(git.commitSha) ?? ""} ` +
        `ref=${readString(git.ref) ?? ""} ` +
        `repo=${
          readString(git.repositoryUrl) ?? readString(git.repository) ?? ""
        }`,
    );
  }
  const artifacts = Array.isArray(value.resourceArtifacts)
    ? value.resourceArtifacts
    : [];
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) continue;
    console.log(
      `artifact resource=${readString(artifact.resourceName) ?? ""} ` +
        `name=${readString(artifact.artifactName) ?? ""} ` +
        `uri=${readString(artifact.artifactUri) ?? ""}`,
    );
  }
}

function renderCauseChain(value: unknown): void {
  const causes = Array.isArray(value) ? value.filter(isRecord) : [];
  if (causes.length === 0) {
    console.log("cause chain: empty");
    return;
  }
  console.log("cause chain:");
  const rows = causes.map((cause) => ({
    time: readString(cause.createdAt) ?? "",
    phase: readString(cause.phase) ?? "",
    stage: readString(cause.stage) ?? "",
    status: readString(cause.status) ?? "",
    op: readString(cause.operationKind) ?? "",
    resource: readString(cause.resourceName) ?? "",
    provider: readString(cause.providerId) ?? "",
    reason: readString(cause.reason) ?? "",
    outcome: readString(cause.outcomeStatus) ?? "",
  }));
  renderTable(rows, [
    "time",
    "phase",
    "stage",
    "status",
    "op",
    "resource",
    "provider",
    "reason",
    "outcome",
  ]);
}

function renderRevokeDebts(value: unknown): void {
  const debts = Array.isArray(value) ? value.filter(isRecord) : [];
  if (debts.length === 0) return;
  console.log("revoke debt:");
  renderTable(
    debts.map((debt) => ({
      id: readString(debt.id) ?? "",
      reason: readString(debt.reason) ?? "",
      status: readString(debt.status) ?? "",
      resource: readString(debt.resourceName) ?? "",
      provider: readString(debt.providerId) ?? "",
    })),
    ["id", "reason", "status", "resource", "provider"],
  );
}

function renderTable(
  rows: readonly Record<string, string>[],
  keys: readonly string[],
): void {
  const widths = keys.map((key) =>
    Math.max(key.length, ...rows.map((row) => row[key].length))
  );
  console.log(keys.map((key, index) => key.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(
      keys.map((key, index) => row[key].padEnd(widths[index])).join("  "),
    );
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export const auditCommand: ReturnType<typeof createAuditCommand> =
  createAuditCommand();
