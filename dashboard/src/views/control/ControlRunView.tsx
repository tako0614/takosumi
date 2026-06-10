/**
 * Plan summary view (spec §31) — a single Run.
 *
 * Shows, for one Run (`GET /v1/control/runs/:id`):
 *   - the run header (type / status / policy status),
 *   - the §19 changes summary + diagnostics from the run logs
 *     (`GET /v1/control/runs/:id/logs`: diagnostics + run-level audit trail),
 *   - inputs (the dependency-injected names) on a best-effort basis (read from
 *     the run logs audit metadata when present — the control surface does not
 *     expose resolved input VALUES), and
 *   - an approve button when the run is `waiting_approval`
 *     (`POST /v1/control/runs/:id/approve`).
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { useParams } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import StatusPill from "../account/components/StatusPill.tsx";
import {
  approveRun,
  ControlApiError,
  createApplyRun,
  getRun,
  getRunCostInfo,
  getRunLogs,
  type Run,
  type RunCostInfo,
  type RunDiagnostic,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  controlPolicyStatusLabel,
  controlRunStatusClass,
  controlRunStatusLabel,
} from "../../lib/status-labels.ts";

export default function ControlRunView() {
  return <Page title="Plan の確認">{() => <Inner />}</Page>;
}

/** Best-effort extraction of dependency-injected input names from audit events. */
function inputNamesFromLogs(
  auditEvents: readonly { readonly [k: string]: unknown }[],
): readonly string[] {
  const names = new Set<string>();
  for (const event of auditEvents) {
    const detail = (event.detail ?? event) as Record<string, unknown>;
    const inputs = detail.inputs ?? detail.injectedInputs ?? detail.variables;
    if (Array.isArray(inputs)) {
      for (const i of inputs) if (typeof i === "string") names.add(i);
    } else if (inputs && typeof inputs === "object") {
      for (const k of Object.keys(inputs)) names.add(k);
    }
  }
  return [...names];
}

interface ChangeItem {
  readonly action: "create" | "update" | "delete";
  readonly label: string;
}

/**
 * A Run is terminal once it has reached a final status; while it is non-terminal
 * (`queued` / `running` / `waiting_approval`) the run screen polls so a panpii who
 * lands on `/runs/:id` right after install sees it advance without a refresh.
 */
function isTerminalRunStatus(status: Run["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Date(time).toLocaleString("ja-JP");
}

/** Formats a backend-provided credit count for display (no invented units). */
function formatCredits(value: number): string {
  return value.toLocaleString("ja-JP");
}

/**
 * True when the cost projection has anything worth showing the operator before
 * apply: an estimate the backend computed, a reservation outcome, a shortfall,
 * or a block reason. A `disabled`-mode plan with a zero estimate and nothing
 * blocked carries no information, so we render nothing (don't clutter the page).
 */
function hasCostToShow(cost: RunCostInfo): boolean {
  return (
    cost.blocked ||
    cost.estimatedCredits > 0 ||
    cost.reservationStatus !== undefined ||
    cost.creditShortfall !== undefined ||
    cost.reasons.length > 0
  );
}

/**
 * Pre-apply cost / shortfall panel. Shows ONLY the values the backend computed
 * at plan time (estimated credits, available balance, shortfall, block reasons)
 * — it invents no amount and no formula. When the plan is `blocked` it states,
 * in plain Japanese, that the deploy cannot run, and lists the backend's own
 * reasons verbatim as supporting detail.
 */
function CostNotice(props: { readonly cost: RunCostInfo }) {
  const cost = () => props.cost;
  return (
    <div
      class={`run-cost-notice${cost().blocked ? " run-cost-notice-blocked" : ""}`}
    >
      <Show when={cost().estimatedCredits > 0}>
        <p class="run-cost-line">
          必要クレジット: 約 <strong>{formatCredits(cost().estimatedCredits)}</strong>
        </p>
      </Show>
      <Show when={cost().availableCredits !== undefined}>
        {(_) => (
          <p class="run-cost-line muted">
            残高: {formatCredits(cost().availableCredits ?? 0)}
          </p>
        )}
      </Show>
      <Show when={cost().blocked}>
        <p class="sign-in-error run-cost-blocked-msg">
          <Show
            when={cost().creditShortfall !== undefined}
            fallback={<>残高または上限の都合により、このまま実行できません。</>}
          >
            クレジット残高が約 {formatCredits(cost().creditShortfall ?? 0)}{" "}
            不足しているため、このまま実行できません。
          </Show>
        </p>
        <Show when={cost().reasons.length > 0}>
          <ul class="run-cost-reasons muted">
            <For each={cost().reasons}>{(reason) => <li>{reason}</li>}</For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}

/**
 * True when an apply rejection means the plan is destructive and the backend is
 * asking for an explicit confirmation (the controller's
 * `confirmDestructive=true` precondition). Matched on the message so the UI does
 * not depend on a separate destructiveness field on the public Run.
 */
function isDestructiveConfirmationRequired(error: ControlApiError): boolean {
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("confirmdestructive") || message.includes("destructive")
  );
}

function changesFromLogs(
  auditEvents: readonly { readonly [k: string]: unknown }[],
): readonly ChangeItem[] {
  const out: ChangeItem[] = [];
  for (const event of auditEvents) {
    const detail = (event.detail ?? event) as Record<string, unknown>;
    const candidates = [
      detail.resourceChanges,
      detail.changes,
      detail.planChanges,
      detail.changeSummary,
    ];
    for (const candidate of candidates) {
      collectChanges(candidate, out);
    }
  }
  return out;
}

function collectChanges(candidate: unknown, out: ChangeItem[]): void {
  if (!candidate) return;
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      if (typeof item === "string") {
        out.push({ action: "update", label: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const action = normalizeAction(
        record.action ?? record.change ?? record.op,
      );
      const label = String(
        record.address ?? record.resource ?? record.name ?? record.type ?? "",
      );
      if (action && label) out.push({ action, label });
    }
    return;
  }
  if (typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    for (const action of ["create", "update", "delete"] as const) {
      const list = record[action];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const label =
          typeof item === "string"
            ? item
            : item && typeof item === "object"
              ? String(
                  (item as Record<string, unknown>).address ??
                    (item as Record<string, unknown>).name ??
                    "",
                )
              : "";
        if (label) out.push({ action, label });
      }
    }
  }
}

function normalizeAction(value: unknown): ChangeItem["action"] | undefined {
  if (Array.isArray(value)) {
    if (value.includes("delete")) return "delete";
    if (value.includes("create")) return "create";
    if (value.includes("update")) return "update";
  }
  if (value === "create" || value === "update" || value === "delete") {
    return value;
  }
  return undefined;
}

function connectionNamesFromLogs(
  auditEvents: readonly { readonly [k: string]: unknown }[],
): readonly string[] {
  const names = new Set<string>();
  for (const event of auditEvents) {
    const detail = (event.detail ?? event) as Record<string, unknown>;
    const connections =
      detail.connections ?? detail.resolvedConnections ?? detail.bindings;
    if (Array.isArray(connections)) {
      for (const item of connections) {
        if (typeof item === "string") names.add(item);
        else if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const providerLabel =
            typeof record.provider === "string" && record.provider.length > 0
              ? typeof record.alias === "string" && record.alias.length > 0
                ? `${record.provider}.${record.alias}`
                : record.provider
              : undefined;
          const label = providerLabel
            ? `${providerLabel}: ${record.mode ?? record.connectionId ?? "default"}`
            : (record.connectionId ?? record.id);
          if (typeof label === "string") names.add(label);
        }
      }
    } else if (connections && typeof connections === "object") {
      for (const [provider, value] of Object.entries(connections)) {
        if (typeof value === "string") names.add(`${provider}: ${value}`);
        else if (value && typeof value === "object") {
          const record = value as Record<string, unknown>;
          names.add(
            `${provider}: ${record.mode ?? record.connectionId ?? "default"}`,
          );
        }
      }
    }
  }
  return [...names];
}

function ChangesList(props: {
  readonly title: string;
  readonly items: readonly ChangeItem[];
}) {
  return (
    <div class="run-change-column">
      <h3>{props.title}</h3>
      <Show when={props.items.length > 0} fallback={<p class="muted">none</p>}>
        <ul class="run-change-list">
          <For each={props.items}>
            {(item) => (
              <li>
                <code>{item.label}</code>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function PolicySection(props: { readonly run: Run }) {
  return (
    <section class="detail-section">
      <h2>Policy</h2>
      <dl class="kv-list">
        <dt>Status</dt>
        <dd>
          <Show
            when={props.run.policyStatus}
            fallback={<span class="muted">not evaluated</span>}
          >
            <span class={`status-pill policy-${props.run.policyStatus}`}>
              {controlPolicyStatusLabel(props.run.policyStatus)}
            </span>
          </Show>
        </dd>
        <Show when={props.run.planDigest}>
          <dt>Plan digest</dt>
          <dd>
            <code>{props.run.planDigest}</code>
          </dd>
        </Show>
        <Show when={props.run.errorCode}>
          <dt>Error</dt>
          <dd>
            <code>{props.run.errorCode}</code>
          </dd>
        </Show>
      </dl>
    </section>
  );
}

function DiagnosticRow(props: { diagnostic: RunDiagnostic }) {
  return (
    <li class={`run-diagnostic run-diagnostic-${props.diagnostic.severity}`}>
      <span class="run-diagnostic-sev">{props.diagnostic.severity}</span>
      <span class="run-diagnostic-msg">{props.diagnostic.message}</span>
      <Show when={props.diagnostic.detail}>
        <pre class="run-diagnostic-detail">{props.diagnostic.detail}</pre>
      </Show>
    </li>
  );
}

function AuditEventRow(props: { event: Record<string, unknown> }) {
  const eventType = () =>
    String(
      props.event.type ?? props.event.action ?? props.event.message ?? "event",
    );
  const at = () => {
    const raw = props.event.at ?? props.event.createdAt;
    if (typeof raw === "number") return new Date(raw).toLocaleString("ja-JP");
    if (typeof raw === "string") return formatDateTime(raw);
    return "";
  };
  const detail = () => {
    const raw = props.event.detail ?? props.event.metadata;
    if (raw === undefined) return "";
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  };

  return (
    <li class="run-audit-row">
      <div class="run-audit-head">
        <code>{eventType()}</code>
        <Show when={at()}>
          {(value) => <span class="muted">{value()}</span>}
        </Show>
      </div>
      <Show when={detail()}>
        {(value) => <pre class="run-diagnostic-detail">{value()}</pre>}
      </Show>
    </li>
  );
}

function Inner() {
  const params = useParams();
  const runId = () => params.id ?? "";

  const [run, { refetch: refetchRun }] = createResource(runId, getRun);
  const [logs, { refetch: refetchLogs }] = createResource(runId, getRunLogs);
  // Pre-apply cost / credit-shortfall projection (backend-computed values only;
  // see CostNotice). Best-effort: if the route errors, the resource stays
  // undefined and the deploy UI behaves exactly as before (never breaks apply).
  const [cost] = createResource(runId, async (id) => {
    try {
      return await getRunCostInfo(id);
    } catch {
      return undefined;
    }
  });

  // Poll while the run is non-terminal so the screen advances on its own. The
  // effect re-runs whenever the run status changes; each run schedules a single
  // refetch and onCleanup clears it (on the next status change and on teardown),
  // so once the run reaches a terminal status no further poll is scheduled.
  createEffect(() => {
    const current = run.latest;
    if (!current || isTerminalRunStatus(current.status)) return;
    const timer = setTimeout(() => {
      void refetchRun();
      void refetchLogs();
    }, 3000);
    onCleanup(() => clearTimeout(timer));
  });

  const inputs = createMemo(() =>
    inputNamesFromLogs(logs()?.auditEvents ?? []),
  );
  const changes = createMemo(() => changesFromLogs(logs()?.auditEvents ?? []));
  const changeCounts = createMemo(() => {
    const items = changes();
    return {
      create: items.filter((item) => item.action === "create").length,
      update: items.filter((item) => item.action === "update").length,
      delete: items.filter((item) => item.action === "delete").length,
    };
  });
  const connections = createMemo(() =>
    connectionNamesFromLogs(logs()?.auditEvents ?? []),
  );

  const approve = createAction(async () => {
    await approveRun(runId());
    await Promise.all([refetchRun(), refetchLogs()]);
  });

  // --- Deploy (apply a reviewed plan) --------------------------------------
  // Only a finished, policy-passed `plan` Run is deployable. `drift_check` is a
  // read-only signal and is never applyable; `apply`/`destroy_*` Runs are not
  // re-applied from here. `applied` flips once the apply has been kicked off so
  // the success notice stays visible after the Run resource refetches.
  const [applied, setApplied] = createSignal(false);
  // Set when the backend reports the plan is destructive and needs an explicit
  // confirmation before it will apply.
  const [needsConfirm, setNeedsConfirm] = createSignal(false);

  const isDeployableRun = (r: Run): boolean =>
    r.type === "plan" &&
    r.status === "succeeded" &&
    r.policyStatus === "pass" &&
    !applied();

  const deploy = createAction(async (confirmDestructive?: boolean) => {
    try {
      await createApplyRun(runId(), { confirmDestructive });
    } catch (error) {
      // A destructive plan needs an explicit confirmation: surface the
      // confirmation step instead of a raw error, then let the operator retry.
      if (
        error instanceof ControlApiError &&
        error.status === 409 &&
        isDestructiveConfirmationRequired(error)
      ) {
        setNeedsConfirm(true);
        return;
      }
      throw error;
    }
    setNeedsConfirm(false);
    setApplied(true);
    await Promise.all([refetchRun(), refetchLogs()]);
  });

  // Billing blocks apply (enforce-mode credit shortfall / plan limit). Only the
  // backend's `blocked` flag gates the button; absence of cost info never does.
  const costInfo = () => cost.latest;
  const costBlocked = () => costInfo()?.blocked === true;

  return (
    <AppShell>
      <div class="page-header">
        <h1>Plan の確認</h1>
        <p class="page-sub">
          Run の変更内容・診断・ポリシー結果を確認し、 承認します。
        </p>
        <div class="page-actions">
          <a href="/installations" class="btn btn-secondary">
            一覧へ
          </a>
        </div>
      </div>

      <Switch>
        <Match when={run.loading}>
          <div class="grid-skel">
            <div class="skel-block tall" />
          </div>
        </Match>
        <Match when={run.error}>
          <section class="empty-state error-state">
            <p>取得に失敗しました — {(run.error as ControlApiError).message}</p>
          </section>
        </Match>
        <Match when={run()}>
          {(r) => (
            <>
              <section class="detail-section">
                <h2>
                  Run
                  <StatusPill class={controlRunStatusClass(r().status)}>
                    {controlRunStatusLabel(r().status)}
                  </StatusPill>
                </h2>
                <dl class="kv-list">
                  <dt>Run ID</dt>
                  <dd>
                    <code>{r().id}</code>
                  </dd>
                  <dt>種別</dt>
                  <dd>
                    <code>{r().type}</code>
                  </dd>
                  <dt>ポリシー</dt>
                  <dd>
                    <Show
                      when={r().policyStatus}
                      fallback={<span class="muted">—</span>}
                    >
                      <span class={`status-pill policy-${r().policyStatus}`}>
                        {controlPolicyStatusLabel(r().policyStatus)}
                      </span>
                    </Show>
                  </dd>
                  <Show when={r().installationId}>
                    <dt>Installation</dt>
                    <dd>
                      <code>{r().installationId}</code>
                    </dd>
                  </Show>
                  <Show when={r().sourceSnapshotId}>
                    <dt>Source snapshot</dt>
                    <dd>
                      <code>{r().sourceSnapshotId}</code>
                    </dd>
                  </Show>
                  <Show when={r().dependencySnapshotId}>
                    <dt>Dependency snapshot</dt>
                    <dd>
                      <code>{r().dependencySnapshotId}</code>
                    </dd>
                  </Show>
                  <Show when={r().baseStateGeneration !== undefined}>
                    <dt>Base state generation</dt>
                    <dd>
                      <code>{r().baseStateGeneration}</code>
                    </dd>
                  </Show>
                  <Show when={r().planDigest}>
                    <dt>Plan digest</dt>
                    <dd>
                      <code>{r().planDigest}</code>
                    </dd>
                  </Show>
                  <dt>Created</dt>
                  <dd>{formatDateTime(r().createdAt)}</dd>
                  <dt>Started</dt>
                  <dd>{formatDateTime(r().startedAt)}</dd>
                  <dt>Finished</dt>
                  <dd>{formatDateTime(r().finishedAt)}</dd>
                  <Show when={r().errorCode}>
                    <dt>エラー</dt>
                    <dd>
                      <code>{r().errorCode}</code>
                    </dd>
                  </Show>
                </dl>

                <Show when={r().status === "waiting_approval"}>
                  <div class="form-actions run-approve">
                    <button
                      class="btn btn-primary"
                      type="button"
                      disabled={approve.busy()}
                      onClick={() => void approve.run()}
                    >
                      {approve.busy() ? "承認中..." : "この Run を承認"}
                    </button>
                  </div>
                </Show>
                <Show when={approve.error()}>
                  {(m) => <p class="sign-in-error">{m()}</p>}
                </Show>

                {/* Deploy: apply this reviewed plan. Shown only for a finished,
                    問題のない plan。破壊的な変更がある場合は確認してから実行。 */}
                <Show when={applied()}>
                  <p class="run-apply-done">
                    デプロイを開始しました。反映までしばらくお待ちください。
                  </p>
                </Show>
                <Show when={!applied() && isDeployableRun(r())}>
                  <div class="run-deploy-block">
                    {/* Pre-apply cost / credit-shortfall (backend values only). */}
                    <Show
                      when={(() => {
                        const c = costInfo();
                        return c && hasCostToShow(c) ? c : undefined;
                      })()}
                    >
                      {(c) => <CostNotice cost={c()} />}
                    </Show>
                    <div class="form-actions run-deploy">
                      <Show
                        when={needsConfirm()}
                        fallback={
                          <button
                            class="btn btn-primary"
                            type="button"
                            disabled={deploy.busy() || costBlocked()}
                            onClick={() => void deploy.run(undefined)}
                          >
                            {deploy.busy()
                              ? "実行中..."
                              : costBlocked()
                                ? "残高不足のため実行できません"
                                : "デプロイを実行"}
                          </button>
                        }
                      >
                        <p class="run-deploy-warn">
                          この変更には既存リソースの置き換え・削除が含まれます。
                          実行するとデータが失われる場合があります。
                        </p>
                        <div class="form-actions">
                          <button
                            class="btn btn-secondary"
                            type="button"
                            disabled={deploy.busy()}
                            onClick={() => setNeedsConfirm(false)}
                          >
                            やめる
                          </button>
                          <button
                            class="btn btn-danger"
                            type="button"
                            disabled={deploy.busy() || costBlocked()}
                            onClick={() => void deploy.run(true)}
                          >
                            {deploy.busy()
                              ? "実行中..."
                              : costBlocked()
                                ? "残高不足のため実行できません"
                                : "破壊的な変更を承知のうえで実行"}
                          </button>
                        </div>
                      </Show>
                    </div>
                  </div>
                </Show>
                <Show when={deploy.error()}>
                  {(m) => <p class="sign-in-error">{m()}</p>}
                </Show>
              </section>

              {/* Inputs (dependency-injected names; best-effort from logs). */}
              <section class="detail-section">
                <h2>Changes</h2>
                <div class="run-summary-strip">
                  <span>
                    Create <strong>{changeCounts().create}</strong>
                  </span>
                  <span>
                    Update <strong>{changeCounts().update}</strong>
                  </span>
                  <span>
                    Delete <strong>{changeCounts().delete}</strong>
                  </span>
                </div>
                <div class="run-change-grid">
                  <ChangesList
                    title="Create"
                    items={changes().filter((item) => item.action === "create")}
                  />
                  <ChangesList
                    title="Update"
                    items={changes().filter((item) => item.action === "update")}
                  />
                  <ChangesList
                    title="Delete"
                    items={changes().filter((item) => item.action === "delete")}
                  />
                </div>
              </section>

              <section class="detail-section">
                <h2>Inputs</h2>
                <Show
                  when={inputs().length > 0}
                  fallback={
                    <p class="muted">
                      依存からの注入入力は検出されませんでした。
                    </p>
                  }
                >
                  <ul class="run-inputs">
                    <For each={inputs()}>
                      {(n) => (
                        <li>
                          <code>{n}</code>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>

              <section class="detail-section">
                <h2>Connections</h2>
                <Show
                  when={connections().length > 0}
                  fallback={<p class="muted">接続解決情報はありません。</p>}
                >
                  <ul class="run-inputs">
                    <For each={connections()}>
                      {(n) => (
                        <li>
                          <code>{n}</code>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>

              <PolicySection run={r()} />

              {/* Changes summary + diagnostics. */}
              <section class="detail-section">
                <h2>Diagnostics</h2>
                <Switch>
                  <Match when={logs.loading}>
                    <div class="grid-skel">
                      <div class="skel-block" />
                    </div>
                  </Match>
                  <Match when={logs.error}>
                    <p class="sign-in-error">
                      ログ取得に失敗しました —{" "}
                      {(logs.error as ControlApiError).message}
                    </p>
                  </Match>
                  <Match when={logs()}>
                    {(l) => (
                      <Show
                        when={l().diagnostics.length > 0}
                        fallback={<p class="muted">診断はありません。</p>}
                      >
                        <ul class="run-diagnostics">
                          <For each={l().diagnostics}>
                            {(d) => <DiagnosticRow diagnostic={d} />}
                          </For>
                        </ul>
                      </Show>
                    )}
                  </Match>
                </Switch>
              </section>

              <section class="detail-section">
                <h2>Audit trail</h2>
                <Show
                  when={(logs()?.auditEvents ?? []).length > 0}
                  fallback={<p class="muted">audit event はありません。</p>}
                >
                  <ul class="run-audit-list">
                    <For each={logs()?.auditEvents ?? []}>
                      {(event) => <AuditEventRow event={event} />}
                    </For>
                  </ul>
                </Show>
              </section>
            </>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}
