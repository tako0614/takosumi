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
  createMemo,
  createResource,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { useParams } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import {
  approveRun,
  type ControlApiError,
  getRun,
  getRunLogs,
  type Run,
  type RunDiagnostic,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  controlPolicyStatusLabel,
  controlRunStatusLabel,
} from "../../lib/status-labels.ts";

export default function ControlRunView() {
  return <Page title="Plan の確認">{() => <Inner />}</Page>;
}

function RunStatusPill(props: { status: Run["status"] }) {
  const cls = createMemo(() => {
    switch (props.status) {
      case "succeeded":
        return "status-ready";
      case "running":
      case "queued":
      case "waiting_approval":
        return "status-installing";
      case "failed":
      case "expired":
        return "status-error";
      case "cancelled":
        return "status-suspended";
      default:
        return "";
    }
  });
  return (
    <span class={`status-pill ${cls()}`}>
      {controlRunStatusLabel(props.status)}
    </span>
  );
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

function Inner() {
  const params = useParams();
  const runId = () => params.id ?? "";

  const [run, { refetch: refetchRun }] = createResource(runId, getRun);
  const [logs, { refetch: refetchLogs }] = createResource(runId, getRunLogs);

  const inputs = createMemo(() =>
    inputNamesFromLogs(logs()?.auditEvents ?? [])
  );

  const approve = createAction(async () => {
    await approveRun(runId());
    await Promise.all([refetchRun(), refetchLogs()]);
  });

  return (
    <AppShell>
      <div class="page-header">
        <h1>Plan の確認</h1>
        <p class="page-sub">
          Run の変更内容・診断・ポリシー結果を確認し、 承認します。
        </p>
        <div class="page-actions">
          <a href="/installations" class="btn btn-secondary">一覧へ</a>
        </div>
      </div>

      <Switch>
        <Match when={run.loading}>
          <div class="grid-skel"><div class="skel-block tall" /></div>
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
                  <RunStatusPill status={r().status} />
                </h2>
                <dl class="kv-list">
                  <dt>Run ID</dt>
                  <dd><code>{r().id}</code></dd>
                  <dt>種別</dt>
                  <dd><code>{r().type}</code></dd>
                  <dt>ポリシー</dt>
                  <dd>
                    <Show when={r().policyStatus} fallback={<span class="muted">—</span>}>
                      <span
                        class={`status-pill policy-${r().policyStatus}`}
                      >
                        {controlPolicyStatusLabel(r().policyStatus)}
                      </span>
                    </Show>
                  </dd>
                  <Show when={r().installationId}>
                    <dt>Installation</dt>
                    <dd><code>{r().installationId}</code></dd>
                  </Show>
                  <Show when={r().planDigest}>
                    <dt>Plan digest</dt>
                    <dd><code>{r().planDigest}</code></dd>
                  </Show>
                  <Show when={r().errorCode}>
                    <dt>エラー</dt>
                    <dd><code>{r().errorCode}</code></dd>
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
              </section>

              {/* Inputs (dependency-injected names; best-effort from logs). */}
              <section class="detail-section">
                <h2>注入される入力</h2>
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
                      {(n) => <li><code>{n}</code></li>}
                    </For>
                  </ul>
                </Show>
              </section>

              {/* Changes summary + diagnostics. */}
              <section class="detail-section">
                <h2>変更内容と診断</h2>
                <Switch>
                  <Match when={logs.loading}>
                    <div class="grid-skel"><div class="skel-block" /></div>
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
            </>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}
