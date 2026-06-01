import {
  TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALL_PATH,
  TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALLATIONS_PATH,
} from "./mod.ts";
import {
 takosumiAccountsInstallationEventsPath,
} from "@takosjp/takosumi-accounts-contract";
import type { InstallationEventRecord, InstallationRecord } from "./ledger.ts";
import type { OidcClientRecord } from "./store.ts";
import { isRecord, numberValue, stringValue } from "./http-helpers.ts";
import {
  exportOperationBodyFromEvents,
  findOperationEvent,
  installationEventsTrackingUrl,
  installationExportRequestedEvent,
  installationMaterializeFailedEvent,
  installationMaterializeRequestedEvent,
  installationMaterializeSucceededEvent,
} from "./installation-helpers.ts";

export function dashboardInstallForm(input: {
  gitUrl: string;
  ref: string;
  spaceId: string;
  maxMeteredUseEdges: string;
}): string {
  return `<section class="panel">
    <div class="panel-head"><h1>Install</h1></div>
    <form class="form-grid" method="get" action="${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALL_PATH}">
      <label>
        <span>Git URL</span>
        <input class="field" name="git" value="${
    escapeAttribute(input.gitUrl)
  }" placeholder="https://github.com/example/app.git">
      </label>
      <label>
        <span>Ref</span>
        <input class="field" name="ref" value="${
    escapeAttribute(input.ref)
  }" placeholder="v1.2.3">
      </label>
      <label>
        <span>Space ID</span>
        <input class="field" name="space_id" value="${
    escapeAttribute(input.spaceId)
  }" placeholder="space_...">
      </label>
      <label>
        <span>Max metered use edges</span>
        <input class="field" name="max_metered_use_edges" inputmode="numeric" pattern="[0-9]*" value="${
    escapeAttribute(input.maxMeteredUseEdges)
  }" placeholder="0">
      </label>
      <div class="form-actions"><button class="primary" type="submit">Dry run</button></div>
    </form>
  </section>`;
}

export function defaultDashboardInstallFormInput(): {
  gitUrl: string;
  ref: string;
  spaceId: string;
  maxMeteredUseEdges: string;
} {
  return {
    gitUrl: "",
    ref: "",
    spaceId: "",
    maxMeteredUseEdges: "",
  };
}

export function dashboardOption(value: string, selected: string): string {
  return `<option value="${escapeAttribute(value)}"${
    value === selected ? " selected" : ""
  }>${escapeHtml(value)}</option>`;
}

export function dashboardNotice(
  kind: "error" | "info",
  message: string,
): string {
  return `<section class="panel">${
    dashboardInlineNotice(kind, message)
  }</section>`;
}

export function dashboardInlineNotice(
  kind: "error" | "info",
  message: string,
): string {
  return `<p class="notice notice-${kind}">${escapeHtml(message)}</p>`;
}

export function dashboardBudgetLimit(
  raw: string,
): { value?: number; error?: string } {
  const value = raw.trim();
  if (!value) return {};
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    return { error: "max_metered_use_edges must be a non-negative integer" };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { error: "max_metered_use_edges is too large" };
  }
  return { value: parsed };
}

export function dashboardBudgetGuardPanel(
  dryRunPayload: unknown,
  maxMeteredUseEdges: number | undefined,
): { blocked: boolean; panel: string } {
  if (maxMeteredUseEdges === undefined) return { blocked: false, panel: "" };
  const metered = dashboardDryRunMeteredBindingCount(dryRunPayload);
  if (metered > maxMeteredUseEdges) {
    return {
      blocked: true,
      panel: dashboardNotice(
        "error",
        `budget_guard_exceeded: dry-run requests ${metered} metered use edge(s), max is ${maxMeteredUseEdges}`,
      ),
    };
  }
  return {
    blocked: false,
    panel: dashboardNotice(
      "info",
      `budget guard passed: ${metered}/${maxMeteredUseEdges} metered use edge(s)`,
    ),
  };
}

export function dashboardInstallApplyForm(input: {
  gitUrl: string;
  ref: string;
  spaceId: string;
  maxMeteredUseEdges?: string;
  expectedCommit?: string;
  expectedPlanSnapshotDigest?: string;
  costAckRequired?: boolean;
}): string {
  return `<section class="panel">
    <div class="panel-head"><h2>Approve Install</h2></div>
    <form class="form-grid" method="post" action="${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALL_PATH}">
      <input type="hidden" name="git" value="${escapeAttribute(input.gitUrl)}">
      <input type="hidden" name="ref" value="${escapeAttribute(input.ref)}">
      <input type="hidden" name="space_id" value="${
    escapeAttribute(input.spaceId)
  }">
      <input type="hidden" name="max_metered_use_edges" value="${
    escapeAttribute(input.maxMeteredUseEdges ?? "")
  }">
      <input type="hidden" name="expected_commit" value="${
    escapeAttribute(input.expectedCommit ?? "")
  }">
      <input type="hidden" name="expected_plan_snapshot_digest" value="${
    escapeAttribute(input.expectedPlanSnapshotDigest ?? "")
  }">
      ${
    input.costAckRequired
      ? `<label class="check"><input type="checkbox" name="cost_ack" value="true" required><span>Acknowledge metered provider cost</span></label>`
      : ""
  }
      <div class="form-actions"><button class="primary" type="submit">Create Installation</button></div>
    </form>
  </section>`;
}

export function dashboardInstallationDryRun(payload: unknown): string {
  const dryRun = isRecord(payload) ? payload : {};
  const repo = recordProperty(dryRun, "repo");
  const installPlan = recordProperty(dryRun, "installPlan", "install_plan");
  const planRepo = recordProperty(installPlan, "repo");
  const source = recordProperty(dryRun, "source");
  const expected = recordProperty(dryRun, "expected");
  const estimatedCost = recordProperty(
    dryRun,
    "estimatedCost",
    "estimated_cost",
  );
  const changes = arrayRecordProperty(dryRun, "changes");
  return `<section class="panel">
    <div class="panel-head">
      <h2>Installation Dry Run</h2>
      <span class="status status-ready">${
    escapeHtml(String(changes.length))
  } change(s)</span>
    </div>
    ${
    dashboardDefinitionList({
      App: `${stringFromRecord(repo, "name") ?? stringFromRecord(planRepo, "name") ?? "unknown"} (${
        stringFromRecord(repo, "id") ?? stringFromRecord(planRepo, "id") ?? "unknown"
      })`,
      Source: `${stringFromRecord(source, "url") ?? "unknown"}@${
        stringFromRecord(source, "ref") ?? "unknown"
      }`,
      Commit: stringFromRecord(source, "commit") ?? "unresolved",
      "Plan snapshot": stringFromRecord(dryRun, "planSnapshotDigest") ??
        stringFromRecord(dryRun, "plan_snapshot_digest") ??
        "unknown",
      "Expected commit": stringFromRecord(expected, "commit") ?? "unknown",
      "Expected plan": stringFromRecord(expected, "planSnapshotDigest") ??
        stringFromRecord(expected, "plan_snapshot_digest") ??
        "unknown",
      Cost: estimatedCost
        ? `${stringFromRecord(estimatedCost, "currency") ?? "unknown"} ${
          String(numberFromRecord(estimatedCost, "monthly") ?? 0)
        } monthly`
        : "unknown",
    })
  }
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Changes</h2><span class="count">${changes.length}</span></div>
    <table>
      <thead><tr><th>Operation</th><th>Subject</th><th>Kind</th></tr></thead>
      <tbody>${dashboardDryRunChangeRows(changes)}</tbody>
    </table>
  </section>`;
}

export function dashboardDryRunExpectedCommit(
  payload: unknown,
): string | undefined {
  const dryRun = isRecord(payload) ? payload : {};
  return stringFromRecord(recordProperty(dryRun, "expected"), "commit");
}

export function dashboardDryRunExpectedPlanSnapshotDigest(
  payload: unknown,
): string | undefined {
  const dryRun = isRecord(payload) ? payload : {};
  return stringFromRecord(
    recordProperty(dryRun, "expected"),
    "planSnapshotDigest",
    "plan_snapshot_digest",
  );
}

export function dashboardDryRunMeteredBindingCount(payload: unknown): number {
  const dryRun = isRecord(payload) ? payload : {};
  return numberFromRecord(
    recordProperty(dryRun, "cost"),
    "meteredBindingCount",
  ) ??
    0;
}

export function dashboardInstallationDryRunError(input: {
  status: number;
  contentType: string;
  payload: unknown;
}): string {
  const payload = isRecord(input.payload) ? input.payload : {};
  const message = stringFromRecord(payload, "message", "error_description") ??
    stringFromRecord(payload, "error") ??
    (typeof input.payload === "string" ? input.payload : "dry-run failed");
  return `<section class="panel">
    <div class="panel-head"><h2>Dry run failed</h2><span class="status status-failed">HTTP ${
    String(input.status)
  }</span></div>
    ${
    dashboardDefinitionList({
      Error: message,
      "Content type": input.contentType,
    })
  }
  </section>`;
}

export function dashboardInstallApplyResult(payload: unknown): string {
  const result = isRecord(payload) ? payload : {};
  const accounts = recordProperty(result, "accounts");
  const installation = recordProperty(result, "installation");
  const deployment = recordProperty(result, "deployment");
  const response = recordProperty(result, "response");
  const launchUrl = stringFromRecord(recordProperty(result, "launch"), "url");
  const installationId = stringFromRecord(
    installation,
    "id",
    "installationId",
    "installation_id",
  ) ?? stringFromRecord(
    accounts,
    "installationId",
    "installation_id",
  ) ?? "unknown";
  const detailsLink = installationId === "unknown"
    ? ""
    : `<p><a class="button" href="${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALLATIONS_PATH}/${
      escapeAttribute(installationId)
    }">Open installation</a></p>`;
  const launchLink = launchUrl
    ? `<p><a class="button" href="${
      escapeAttribute(launchUrl)
    }">Launch app</a></p>`
    : "";
  return `<section class="panel">
    <div class="panel-head"><h2>Install requested</h2></div>
    ${
    dashboardDefinitionList({
      Kind: stringFromRecord(result, "kind") ??
        "takosumi.installer.installation-apply@v1",
      Installation: installationId,
      Status: stringFromRecord(deployment, "status") ??
        String(numberFromRecord(response, "status") ?? "accepted"),
      ...(launchUrl ? { Launch: launchUrl } : {}),
    })
  }
    ${detailsLink}
    ${launchLink}
  </section>`;
}

export function dashboardInstallApplyError(input: {
  status: number;
  contentType: string;
  payload: unknown;
}): string {
  const payload = isRecord(input.payload) ? input.payload : {};
  const message = stringFromRecord(payload, "message", "error_description") ??
    stringFromRecord(payload, "error") ??
    (typeof input.payload === "string" ? input.payload : "install failed");
  return `<section class="panel">
    <div class="panel-head"><h2>Install failed</h2><span class="status status-failed">HTTP ${
    String(input.status)
  }</span></div>
    ${
    dashboardDefinitionList({
      Error: message,
      "Content type": input.contentType,
    })
  }
  </section>`;
}

export function dashboardDryRunChangeRows(
  changes: readonly Record<string, unknown>[],
): string {
  if (changes.length === 0) {
    return `<tr><td colspan="3" class="empty">No changes planned.</td></tr>`;
  }
  return changes.map((change) =>
    `<tr>
      <td>${escapeHtml(stringFromRecord(change, "op") ?? "unknown")}</td>
      <td>${escapeHtml(stringFromRecord(change, "subject") ?? "unknown")}</td>
      <td>${escapeHtml(stringFromRecord(change, "kind") ?? "unknown")}</td>
    </tr>`
  ).join("");
}

export function dashboardListItems(
  values: readonly string[],
  empty: string,
): string {
  if (values.length === 0) return `<li class="empty">${escapeHtml(empty)}</li>`;
  return values.map((value) => `<li>${escapeHtml(value)}</li>`).join("");
}

export function recordProperty(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): Record<string, unknown> {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  return {};
}

export function arrayRecordProperty(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): readonly Record<string, unknown>[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

export function stringArrayProperty(
  record: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function stringFromRecord(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function numberFromRecord(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  return numberValue(record[key]);
}

export function dashboardPage(input: {
  title: string;
  active: "install" | "installations";
  body: string;
}): string {
  const title = escapeHtml(input.title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Takosumi Accounts</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --text: #18202a;
      --muted: #647084;
      --line: #d9dee7;
      --accent: #0f766e;
      --warn: #9a3412;
      --danger: #b42318;
      --ok: #166534;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    .shell {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      min-height: 100vh;
    }
    nav {
      border-right: 1px solid var(--line);
      background: #102027;
      color: #f8fafc;
      padding: 20px 16px;
    }
    nav a {
      display: block;
      padding: 8px 10px;
      border-radius: 6px;
      color: inherit;
      text-decoration: none;
    }
    nav a[aria-current="page"] { background: rgba(255, 255, 255, 0.14); }
    main { min-width: 0; padding: 24px; }
    .panel {
      width: 100%;
      margin: 0 0 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 56px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }
    h1, h2 { margin: 0; font-weight: 650; line-height: 1.2; }
    h1 { font-size: 20px; }
    h2 { font-size: 15px; }
    .count, .status {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 6px;
      padding: 2px 8px;
      border: 1px solid var(--line);
      white-space: nowrap;
      font-size: 12px;
    }
    .status-ready { color: var(--ok); border-color: #bbd7c0; background: #f0f8f1; }
    .status-installing { color: var(--accent); border-color: #9ed9d2; background: #effcf9; }
    .status-preparing { color: var(--accent); border-color: #9ed9d2; background: #effcf9; }
    .status-pending-approval { color: var(--warn); border-color: #f2c7a7; background: #fff7ed; }
    .status-approved { color: var(--ok); border-color: #bbd7c0; background: #f0f8f1; }
    .status-rejected { color: var(--danger); border-color: #f2b8b5; background: #fff4f2; }
    .status-failed, .status-suspended { color: var(--danger); border-color: #f2b8b5; background: #fff4f2; }
    .status-exported { color: var(--warn); border-color: #f2c7a7; background: #fff7ed; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      min-height: 40px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: middle;
      overflow-wrap: anywhere;
    }
    th { color: var(--muted); font-size: 12px; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    dl {
      display: grid;
      grid-template-columns: minmax(130px, 220px) minmax(0, 1fr);
      gap: 0;
      margin: 0;
    }
    dt, dd {
      margin: 0;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      overflow-wrap: anywhere;
    }
    dt { color: var(--muted); font-weight: 600; }
    dd { min-width: 0; }
    .empty { margin: 0; padding: 20px 16px; color: var(--muted); }
    .button {
      min-height: 32px;
      border: 1px solid #d0a49f;
      border-radius: 6px;
      background: #fff7f6;
      color: var(--danger);
      padding: 5px 9px;
      font: inherit;
      cursor: pointer;
    }
    .button:disabled {
      cursor: default;
      border-color: var(--line);
      color: var(--muted);
      background: #f8fafc;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      padding: 16px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    .field {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #ffffff;
      color: var(--text);
      padding: 6px 8px;
      font: inherit;
      font-size: 14px;
    }
    .form-actions {
      grid-column: 1 / -1;
      display: flex;
      justify-content: flex-end;
    }
    .operations-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      padding: 16px;
    }
    .operation-form {
      display: grid;
      gap: 12px;
      align-content: start;
      min-width: 0;
    }
    .operation-form h3 {
      margin: 0;
      font-size: 14px;
      line-height: 1.2;
    }
    .inline-field {
      display: flex;
      grid-template-columns: none;
      align-items: center;
      gap: 8px;
    }
    .primary {
      min-height: 36px;
      border: 1px solid #0b5f59;
      border-radius: 6px;
      background: var(--accent);
      color: #ffffff;
      padding: 6px 12px;
      font: inherit;
      cursor: pointer;
    }
    .primary:disabled {
      cursor: default;
      border-color: var(--line);
      background: #e2e8f0;
      color: var(--muted);
    }
    .muted {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .inline-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .inline-actions form {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .compact-field {
      width: min(180px, 100%);
      min-height: 32px;
    }
    .notice { margin: 0; padding: 16px; }
    .notice-error { color: var(--danger); }
    .notice-info { color: var(--muted); }
    .risk-low { color: var(--ok); border-color: #bbd7c0; background: #f0f8f1; }
    .risk-medium { color: var(--warn); border-color: #f2c7a7; background: #fff7ed; }
    .risk-high { color: var(--danger); border-color: #f2b8b5; background: #fff4f2; }
    .list { margin: 0; padding: 12px 16px 12px 32px; }
    .list li { margin: 4px 0; overflow-wrap: anywhere; }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; }
      nav { border-right: 0; }
      main { padding: 12px; }
      table { table-layout: auto; }
      dl { grid-template-columns: 1fr; }
      .form-grid { grid-template-columns: 1fr; }
      .operations-grid { grid-template-columns: 1fr; }
      dt { padding-bottom: 2px; border-bottom: 0; }
      dd { padding-top: 2px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <nav aria-label="Takosumi Accounts">
      <strong>Takosumi Accounts</strong>
      <a href="${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALL_PATH}" aria-current="${
    input.active === "install" ? "page" : "false"
  }">Install</a>
      <a href="${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALLATIONS_PATH}" aria-current="${
    input.active === "installations" ? "page" : "false"
  }">Installations</a>
    </nav>
    <main>${input.body}</main>
  </div>
</body>
</html>`;
}

export function dashboardDefinitionList(
  entries: Record<string, string>,
): string {
  return `<dl>${
    Object.entries(entries).map(([key, value]) =>
      `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`
    ).join("")
  }</dl>`;
}

export function dashboardOidcClient(
  client: OidcClientRecord | undefined,
): string {
  if (!client) {
    return `<p class="empty">No OIDC client registered.</p>`;
  }
  return dashboardDefinitionList({
    "Client ID": client.clientId,
    "Service path": client.namespacePath,
    Issuer: client.issuerUrl,
    "Subject mode": client.subjectMode,
    Scopes: client.allowedScopes.join(", "),
    "Auth method": client.tokenEndpointAuthMethod,
    "Redirect URIs": client.redirectUris.join(", "),
    Updated: new Date(client.updatedAt).toISOString(),
  });
}

export function dashboardOperationForms(
  installation: InstallationRecord,
): string {
  const id = escapeAttribute(installation.installationId);
  const materializeDisabled = installation.status !== "ready" ||
    installation.mode !== "shared-cell";
  const exportDisabled = installation.status === "installing" ||
    installation.status === "exported";
  return `<div class="operations-grid">
    <form class="operation-form" method="post" action="${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALLATIONS_PATH}/${id}/materialize">
      <h3>Materialize</h3>
      <label>Region
        <input class="field" name="region" value="default" ${
    materializeDisabled ? "disabled" : ""
  }>
      </label>
      <label class="inline-field">
        <input type="checkbox" name="cost_ack" value="true" required ${
    materializeDisabled ? "disabled" : ""
  }>
        Cost acknowledged
      </label>
      <button class="primary" type="submit" ${
    materializeDisabled ? "disabled" : ""
  }>Materialize</button>
    </form>
    <form class="operation-form" method="post" action="${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALLATIONS_PATH}/${id}/export">
      <h3>Export</h3>
      <label class="inline-field">
        <input type="checkbox" name="include_data" value="true" ${
    exportDisabled ? "disabled" : ""
  }>
        Include data
      </label>
      <label>Encryption
        <select class="field" name="encryption_method" ${
    exportDisabled ? "disabled" : ""
  }>
          <option value="none">none</option>
          <option value="age">age</option>
        </select>
      </label>
      <label>Age recipients
        <textarea class="field" name="recipients" rows="3" ${
    exportDisabled ? "disabled" : ""
  }></textarea>
      </label>
      <button class="primary" type="submit" ${
    exportDisabled ? "disabled" : ""
  }>Export</button>
    </form>
  </div>`;
}

export function dashboardOperationRows(
  installationId: string,
  events: readonly InstallationEventRecord[],
): string {
  const requests = events.filter((event) =>
    event.eventType === installationMaterializeRequestedEvent ||
    event.eventType === installationExportRequestedEvent
  ).toReversed();
  if (requests.length === 0) {
    return `<p class="empty">No operations requested.</p>`;
  }
  return `<table>
    <thead><tr><th>Operation</th><th>ID</th><th>Status</th><th>Tracking</th><th>Result</th></tr></thead>
    <tbody>${
    requests.map((event) =>
      dashboardOperationRow(installationId, events, event)
    )
      .join("")
  }</tbody>
  </table>`;
}

export function dashboardOperationRow(
  installationId: string,
  events: readonly InstallationEventRecord[],
  requestEvent: InstallationEventRecord,
): string {
  const operation = requestEvent.eventType === installationExportRequestedEvent
    ? "export"
    : "materialize";
  const operationId = stringValue(requestEvent.payload.operationId) ?? "-";
  const projection = operationId === "-"
    ? {
      status: "preparing",
      trackingUrl: takosumiAccountsInstallationEventsPath(installationId),
      result: "-",
    }
    : dashboardOperationProjection({
      installationId,
      events,
      operation,
      operationId,
    });
  return `<tr>
    <td>${operation}</td>
    <td>${escapeHtml(operationId)}</td>
    <td><span class="status status-${escapeAttribute(projection.status)}">${
    escapeHtml(projection.status)
  }</span></td>
    <td><a href="${escapeAttribute(projection.trackingUrl)}">Events</a></td>
    <td>${projection.result}</td>
  </tr>`;
}

export function dashboardOperationProjection(input: {
  installationId: string;
  events: readonly InstallationEventRecord[];
  operation: "materialize" | "export";
  operationId: string;
}): { status: string; trackingUrl: string; result: string } {
  if (input.operation === "export") {
    const body = exportOperationBodyFromEvents({
      installationId: input.installationId,
      operationId: input.operationId,
      events: input.events,
    });
    const downloadUrl = stringValue(body.downloadUrl);
    const error = stringValue(body.error);
    return {
      status: stringValue(body.status) ?? "preparing",
      trackingUrl: stringValue(body.trackingUrl) ??
       takosumiAccountsInstallationEventsPath(input.installationId),
      result: downloadUrl
        ? `<a href="${escapeAttribute(downloadUrl)}">Download</a>`
        : escapeHtml(error ?? "-"),
    };
  }

  const succeeded = findOperationEvent({
    events: input.events,
    operationId: input.operationId,
    eventTypes: [installationMaterializeSucceededEvent],
  });
  if (succeeded) {
    return {
      status: "ready",
      trackingUrl: installationEventsTrackingUrl(input.installationId, [
        installationMaterializeRequestedEvent,
        installationMaterializeSucceededEvent,
        installationMaterializeFailedEvent,
      ]),
      result: escapeHtml(
        stringValue(succeeded.payload.runtimeTargetId) ??
          stringValue(succeeded.payload.reason) ?? "-",
      ),
    };
  }
  const failed = findOperationEvent({
    events: input.events,
    operationId: input.operationId,
    eventTypes: [installationMaterializeFailedEvent],
  });
  return {
    status: failed ? "failed" : "preparing",
    trackingUrl: installationEventsTrackingUrl(input.installationId, [
      installationMaterializeRequestedEvent,
      installationMaterializeSucceededEvent,
      installationMaterializeFailedEvent,
    ]),
    result: escapeHtml(
      failed
        ? stringValue(failed.payload.error) ??
          stringValue(failed.payload.reason) ?? "-"
        : "-",
    ),
  };
}

export function dashboardEventRows(
  events: readonly InstallationEventRecord[],
): string {
  if (events.length === 0) {
    return `<tr><td colspan="3" class="empty">No events found.</td></tr>`;
  }
  return events.map((event) =>
    `<tr>
      <td>${escapeHtml(event.eventType)}</td>
      <td>${escapeHtml(new Date(event.createdAt).toISOString())}</td>
      <td>${escapeHtml(event.eventHash)}</td>
    </tr>`
  ).join("");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
