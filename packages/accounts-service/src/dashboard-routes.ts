import {
 takosumiAccountsInstallationExportPath,
 takosumiAccountsInstallationMaterializePath,
} from "@takosjp/takosumi-accounts-contract";
import type { InstallationRecord } from "./ledger.ts";
import type { AccountsStore } from "./store.ts";
import { appInstallationMaterializeDigest } from "./installation-helpers.ts";
import {
  handleRequestAppInstallationExport,
  handleRequestAppInstallationMaterialize,
} from "./installation-lifecycle-routes.ts";
import {
  dashboardBudgetGuardPanel,
  dashboardBudgetLimit,
  dashboardDefinitionList,
  dashboardDryRunExpectedCommit,
  dashboardDryRunExpectedPlanSnapshotDigest,
  dashboardDryRunMeteredBindingCount,
  dashboardEventRows,
  dashboardInlineNotice,
  dashboardInstallApplyError,
  dashboardInstallApplyForm,
  dashboardInstallApplyResult,
  dashboardInstallationDryRun,
  dashboardInstallationDryRunError,
  dashboardInstallForm,
  dashboardNotice,
  dashboardOidcClient,
  dashboardOperationForms,
  dashboardOperationRows,
  dashboardPage,
  defaultDashboardInstallFormInput,
  escapeAttribute,
  escapeHtml,
} from "./dashboard-html.ts";
import { isRecord, stringValue } from "./http-helpers.ts";
import {
  decodePageCursor,
  paginateById,
  parsePageLimit,
} from "./installation-routes.ts";
import type {
  AppInstallationExportWorker,
  AppInstallationMaterializeWorker,
  InstallerProxyOptions,
} from "./mod.ts";
import {
  requestInstallationApply,
  requestInstallationDryRun,
  TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALLATIONS_PATH,
} from "./mod.ts";

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function formString(
  formData: FormData,
  ...names: readonly string[]
): string {
  for (const name of names) {
    const value = formData.get(name);
    if (typeof value === "string") return value.trim();
  }
  return "";
}

export async function requestFormData(
  request: Request,
): Promise<FormData | undefined> {
  try {
    return await request.formData();
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

export function dashboardJsonRequest(input: {
  path: string;
  operation: string;
  installationId: string;
  body: Record<string, unknown>;
}): Request {
  return new Request(`https://dashboard.local${input.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key":
        `dashboard-${input.operation}-${input.installationId}-${Date.now()}`,
    },
    body: JSON.stringify(input.body),
  });
}

export async function dashboardOperationResponse(input: {
  installationId: string;
  response: Response;
}): Promise<Response> {
  if (input.response.status >= 200 && input.response.status < 300) {
    return new Response(null, {
      status: 303,
      headers: {
        location:
          `${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALLATIONS_PATH}/${input.installationId}`,
      },
    });
  }
  const body = await input.response.json().catch(() => ({}));
  const message = isRecord(body)
    ? stringValue(body.error_description) ?? stringValue(body.error) ??
      "operation_failed"
    : "operation_failed";
  return html(
    dashboardPage({
      title: "Installation Operation",
      active: "installations",
      body:
        `<section class="panel"><h1>Installation Operation</h1><p class="notice notice-error">${
          escapeHtml(message)
        }</p></section>`,
    }),
    input.response.status,
  );
}

export async function handleDashboardInstall(input: {
  url: URL;
  installer?: InstallerProxyOptions;
}): Promise<Response> {
  const gitUrl = input.url.searchParams.get("git") ??
    input.url.searchParams.get("gitUrl") ??
    input.url.searchParams.get("git_url") ?? "";
  const ref = input.url.searchParams.get("ref") ?? "";
  const spaceId = input.url.searchParams.get("space_id") ??
    input.url.searchParams.get("spaceId") ??
    input.url.searchParams.get("space") ?? "";
  const maxMeteredUseEdgesRaw = input.url.searchParams.get(
    "max_metered_use_edges",
  ) ??
    input.url.searchParams.get("maxMeteredUseEdges") ?? "";
  const form = dashboardInstallForm({
    gitUrl,
    ref,
    spaceId,
    maxMeteredUseEdges: maxMeteredUseEdgesRaw,
  });
  const budgetLimit = dashboardBudgetLimit(maxMeteredUseEdgesRaw);
  if (budgetLimit.error) {
    return html(
      dashboardPage({
        title: "Install",
        active: "install",
        body: `${form}${dashboardNotice("error", budgetLimit.error)}`,
      }),
      400,
    );
  }
  const hasDryRunRequest = gitUrl.trim() !== "" || ref.trim() !== "" ||
    spaceId.trim() !== "";
  if (!hasDryRunRequest) {
    return html(dashboardPage({
      title: "Install",
      active: "install",
      body: form,
    }));
  }
  if (!gitUrl.trim() || !ref.trim() || !spaceId.trim()) {
    return html(
      dashboardPage({
        title: "Install",
        active: "install",
        body: `${form}${
          dashboardNotice(
            "error",
            "git, ref, and space_id are required for dry-run.",
          )
        }`,
      }),
      400,
    );
  }
  if (!input.installer) {
    return html(
      dashboardPage({
        title: "Install",
        active: "install",
        body: `${form}${
          dashboardNotice(
            "error",
            "Installation dry-run is temporarily unavailable.",
          )
        }`,
      }),
      503,
    );
  }

  const dryRunBody: Record<string, unknown> = {
    spaceId,
    source: {
      kind: "git",
      url: gitUrl,
      ref,
    },
  };
  const dryRun = await requestInstallationDryRun({
    installer: input.installer,
    body: dryRunBody,
  });
  const dryRunPanel = dryRun.status >= 200 && dryRun.status < 300
    ? dashboardInstallationDryRun(dryRun.payload)
    : dashboardInstallationDryRunError(dryRun);
  const budgetGuard = dryRun.status >= 200 && dryRun.status < 300
    ? dashboardBudgetGuardPanel(dryRun.payload, budgetLimit.value)
    : { blocked: false, panel: "" };
  const applyForm = dryRun.status >= 200 && dryRun.status < 300 &&
      !budgetGuard.blocked
    ? dashboardInstallApplyForm({
      gitUrl,
      ref,
      spaceId,
      maxMeteredUseEdges: maxMeteredUseEdgesRaw,
      expectedCommit: dashboardDryRunExpectedCommit(dryRun.payload),
      expectedPlanSnapshotDigest: dashboardDryRunExpectedPlanSnapshotDigest(
        dryRun.payload,
      ),
      costAckRequired: dashboardDryRunMeteredBindingCount(dryRun.payload) > 0,
    })
    : "";
  return html(
    dashboardPage({
      title: "Install",
      active: "install",
      body: `${form}${dryRunPanel}${budgetGuard.panel}${applyForm}`,
    }),
    dryRun.status >= 200 && dryRun.status < 300
      ? budgetGuard.blocked ? 409 : 200
      : dryRun.status,
  );
}

export async function handleDashboardInstallApply(input: {
  request: Request;
  installer?: InstallerProxyOptions;
}): Promise<Response> {
  let formData: FormData;
  try {
    formData = await input.request.formData();
  } catch {
    return html(
      dashboardPage({
        title: "Install",
        active: "install",
        body: `${dashboardInstallForm(defaultDashboardInstallFormInput())}${
          dashboardNotice("error", "invalid install form submission")
        }`,
      }),
      400,
    );
  }
  const gitUrl = formString(formData, "git", "gitUrl", "git_url");
  const ref = formString(formData, "ref");
  const spaceId = formString(formData, "space_id", "spaceId", "space");
  const maxMeteredUseEdgesRaw = formString(
    formData,
    "max_metered_use_edges",
    "maxMeteredUseEdges",
  );
  const expectedCommit = formString(
    formData,
    "expected_commit",
    "expectedCommit",
  );
  const expectedPlanSnapshotDigest = formString(
    formData,
    "expected_plan_snapshot_digest",
    "expectedPlanSnapshotDigest",
  );
  const form = dashboardInstallForm({
    gitUrl,
    ref,
    spaceId,
    maxMeteredUseEdges: maxMeteredUseEdgesRaw,
  });
  const applyForm = dashboardInstallApplyForm({
    gitUrl,
    ref,
    spaceId,
    maxMeteredUseEdges: maxMeteredUseEdgesRaw,
    expectedCommit,
    expectedPlanSnapshotDigest,
    costAckRequired: false,
  });
  if (!input.installer) {
    return html(
      dashboardPage({
        title: "Install",
        active: "install",
        body: `${form}${applyForm}${
          dashboardNotice("error", "Install is temporarily unavailable.")
        }`,
      }),
      503,
    );
  }
  const budgetLimit = dashboardBudgetLimit(maxMeteredUseEdgesRaw);
  if (budgetLimit.error) {
    return html(
      dashboardPage({
        title: "Install",
        active: "install",
        body: `${form}${applyForm}${
          dashboardNotice("error", budgetLimit.error)
        }`,
      }),
      400,
    );
  }
  const missing = [];
  if (!gitUrl) missing.push("git");
  if (!ref) missing.push("ref");
  if (!spaceId) missing.push("space_id");
  if (missing.length > 0) {
    return html(
      dashboardPage({
        title: "Install",
        active: "install",
        body: `${form}${applyForm}${
          dashboardNotice(
            "error",
            `missing required install fields: ${missing.join(", ")}`,
          )
        }`,
      }),
      400,
    );
  }
  const body: Record<string, unknown> = {
    spaceId,
    source: {
      kind: "git",
      url: gitUrl,
      ref,
    },
  };
  if (expectedCommit || expectedPlanSnapshotDigest) {
    body.expected = {
      ...(expectedCommit ? { commit: expectedCommit } : {}),
      ...(expectedPlanSnapshotDigest
        ? { planSnapshotDigest: expectedPlanSnapshotDigest }
        : {}),
    };
  }
  if (budgetLimit.value !== undefined) {
    const dryRunBody: Record<string, unknown> = {
      spaceId,
      source: { kind: "git", url: gitUrl, ref },
    };
    const dryRun = await requestInstallationDryRun({
      installer: input.installer,
      body: dryRunBody,
    });
    if (dryRun.status < 200 || dryRun.status >= 300) {
      return html(
        dashboardPage({
          title: "Install",
          active: "install",
          body: `${form}${applyForm}${
            dashboardInstallationDryRunError(dryRun)
          }`,
        }),
        dryRun.status,
      );
    }
    const budgetGuard = dashboardBudgetGuardPanel(
      dryRun.payload,
      budgetLimit.value,
    );
    if (budgetGuard.blocked) {
      return html(
        dashboardPage({
          title: "Install",
          active: "install",
          body: `${form}${applyForm}${budgetGuard.panel}`,
        }),
        409,
      );
    }
  }
  const result = await requestInstallationApply({
    installer: input.installer,
    body,
  });
  const resultPanel = result.status >= 200 && result.status < 300
    ? dashboardInstallApplyResult(result.payload)
    : dashboardInstallApplyError(result);
  return html(
    dashboardPage({
      title: "Install",
      active: "install",
      body: `${form}${resultPanel}`,
    }),
    result.status >= 200 && result.status < 300 ? 202 : result.status,
  );
}

/**
 * Render the operator dashboard view of installations for a space.
 *
 * Pagination: accepts `?limit` (default 50, max 200) and `?cursor` (opaque
 * base64 cursor). When the page is not the final one, the rendered HTML
 * surfaces a `Next page` link that re-uses the same `space_id` and
 * `limit` along with the new cursor; clients that scrape the page can
 * follow that link to paginate. Cursor format mirrors the JSON list
 * endpoints: `base64url(JSON({ lastId }))`.
 */
export async function handleDashboardInstallations(input: {
  url: URL;
  store: AccountsStore;
}): Promise<Response> {
  const spaceId = input.url.searchParams.get("space_id") ??
    input.url.searchParams.get("spaceId");
  if (!spaceId) {
    return html(
      dashboardPage({
        title: "Installations",
        active: "installations",
        body:
          `<section class="panel"><h1>Installations</h1><p class="empty">space_id is required.</p></section>`,
      }),
      400,
    );
  }
  const limit = parsePageLimit(input.url.searchParams.get("limit"));
  if (limit === "invalid") {
    return html(
      dashboardPage({
        title: "Installations",
        active: "installations",
        body:
          `<section class="panel"><h1>Installations</h1><p class="empty">limit must be a positive integer.</p></section>`,
      }),
      400,
    );
  }
  const afterId = decodePageCursor(input.url.searchParams.get("cursor"));
  if (afterId === "invalid") {
    return html(
      dashboardPage({
        title: "Installations",
        active: "installations",
        body:
          `<section class="panel"><h1>Installations</h1><p class="empty">cursor is malformed.</p></section>`,
      }),
      400,
    );
  }
  const installations = await input.store.listAppInstallationsForSpace(spaceId);
  const page = paginateById(installations, {
    getId: (installation) => installation.installationId,
    limit,
    afterId,
  });
  const rows = page.items.map((installation) =>
    `<tr>
      <td><a href="${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALLATIONS_PATH}/${
      escapeAttribute(installation.installationId)
    }">${escapeHtml(installation.installationId)}</a></td>
      <td>${escapeHtml(installation.appId)}</td>
      <td><span class="status status-${escapeAttribute(installation.status)}">${
      escapeHtml(installation.status)
    }</span></td>
      <td>${escapeHtml(installation.mode)}</td>
      <td>${escapeHtml(installation.sourceRef)}</td>
      <td>${escapeHtml(new Date(installation.updatedAt).toISOString())}</td>
    </tr>`
  ).join("");
  const nextHref = page.nextCursor
    ? `${TAKOSUMI_ACCOUNTS_DASHBOARD_INSTALLATIONS_PATH}?space_id=${
      escapeAttribute(spaceId)
    }&limit=${limit}&cursor=${escapeAttribute(page.nextCursor)}`
    : null;
  const nextLink = nextHref
    ? `<p class="page-next"><a href="${nextHref}">Next page</a></p>`
    : "";
  return html(dashboardPage({
    title: "Installations",
    active: "installations",
    body: `<section class="panel">
      <div class="panel-head">
        <h1>Installations</h1>
        <span class="count">${page.items.length}</span>
      </div>
      <table>
        <thead><tr><th>ID</th><th>App</th><th>Status</th><th>Mode</th><th>Ref</th><th>Updated</th></tr></thead>
        <tbody>${
      rows ||
      `<tr><td colspan="6" class="empty">No installations found.</td></tr>`
    }</tbody>
      </table>
      ${nextLink}
    </section>`,
  }));
}

export async function handleDashboardInstallationDetail(input: {
  installationId: string;
  store: AccountsStore;
}): Promise<Response> {
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) {
    return html(
      dashboardPage({
        title: "Installation",
        active: "installations",
        body:
          `<section class="panel"><h1>Installation</h1><p class="empty">Installation not found.</p></section>`,
      }),
      404,
    );
  }
  const events = await input.store.listInstallationEvents(input.installationId);
  const oidcClient = await input.store.findOidcClientForInstallation(
    input.installationId,
  );
  const runtimeBinding = installation.runtimeBindingId
    ? await input.store.findRuntimeBinding(installation.runtimeBindingId)
    : undefined;
  return html(dashboardPage({
    title: installation.installationId,
    active: "installations",
    body: `<section class="panel">
      <div class="panel-head">
        <h1>${escapeHtml(installation.installationId)}</h1>
        <span class="status status-${escapeAttribute(installation.status)}">${
      escapeHtml(installation.status)
    }</span>
      </div>
      ${
      dashboardDefinitionList({
        App: installation.appId,
        Account: installation.accountId,
        Space: installation.spaceId,
        Mode: installation.mode,
        Runtime: runtimeBinding?.targetId ?? "unbound",
        Source: `${installation.sourceGitUrl}@${installation.sourceRef}`,
        Commit: installation.sourceCommit,
        "Plan snapshot": installation.planSnapshotDigest,
        "Artifact digest": installation.artifactDigest ?? "pending",
      })
    }
    </section>
    <section class="panel">
      <div class="panel-head"><h2>OIDC Client</h2></div>
      ${dashboardOidcClient(oidcClient)}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Operations</h2></div>
      ${dashboardOperationForms(installation)}
      ${dashboardOperationRows(installation.installationId, events)}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Events</h2><span class="count">${events.length}</span></div>
      <table>
        <thead><tr><th>Type</th><th>Created</th><th>Hash</th></tr></thead>
        <tbody>${dashboardEventRows(events)}</tbody>
      </table>
    </section>`,
  }));
}

export async function handleDashboardRequestMaterialize(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
  materializeWorker?: AppInstallationMaterializeWorker;
}): Promise<Response> {
  const form = await input.request.formData();
  const region = formString(form, "region") || "default";
  const plan = {};
  const cutover = {};
  const permissionDigest = await appInstallationMaterializeDigest({
    installationId: input.installationId,
    mode: "dedicated",
    region,
    plan,
    cutover,
  });
  const response = await handleRequestAppInstallationMaterialize({
    installationId: input.installationId,
    request: dashboardJsonRequest({
      path: takosumiAccountsInstallationMaterializePath(input.installationId),
      operation: "materialize",
      installationId: input.installationId,
      body: {
        mode: "dedicated",
        region,
        plan,
        cutover,
        confirm: {
          costAck: form.get("cost_ack") === "true",
          permissionDigest,
        },
      },
    }),
    store: input.store,
    materializeWorker: input.materializeWorker,
  });
  return await dashboardOperationResponse({
    installationId: input.installationId,
    response,
  });
}

export async function handleDashboardRequestExport(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
  exportWorker?: AppInstallationExportWorker;
}): Promise<Response> {
  const form = await input.request.formData();
  const encryptionMethod = formString(form, "encryption_method") || "none";
  const recipients = formString(form, "recipients")
    .split(/\r?\n|,/)
    .map((recipient) => recipient.trim())
    .filter((recipient) => recipient.length > 0);
  const response = await handleRequestAppInstallationExport({
    installationId: input.installationId,
    request: dashboardJsonRequest({
      path: takosumiAccountsInstallationExportPath(input.installationId),
      operation: "export",
      installationId: input.installationId,
      body: {
        includeData: form.get("include_data") === "true",
        format: "bundle",
        encryption: {
          method: encryptionMethod,
          recipients,
        },
        scope: {},
      },
    }),
    store: input.store,
    exportWorker: input.exportWorker,
  });
  return await dashboardOperationResponse({
    installationId: input.installationId,
    response,
  });
}
