import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { AlertCircle, ExternalLink, ShieldAlert } from "lucide-solid";
import {
  approveRun,
  ControlApiError,
  createApplyRun,
  getRun,
  getRunCostInfo,
  getRunLogs,
  planCapsule,
  extractRunId,
  listActivity,
  listStateVersions,
  openRunStream,
  type Run,
} from "../../lib/control-api.ts";
import { t } from "../../i18n/index.ts";
import { Badge, Button, Checkbox, Spinner } from "../../components/ui/index.ts";
import { fetchFailedMessage, friendlyError } from "../../lib/error-copy.ts";
import { createLastGoodValue } from "../../lib/resource-read.ts";
import {
  formatUsdMicros,
  readRunCost,
  runCostDisplayHasContent,
  runCostDisplayState,
  type RunCostDisplayState,
} from "../../lib/run-cost.ts";
import CostSummary from "../../components/run/CostSummary.tsx";
import PlanResourceList from "../../components/run/PlanResourceList.tsx";
import { runFailureHint } from "../../lib/run-errors.ts";
import { runStatusLabel } from "../../lib/labels.ts";
import {
  stateVersionReadinessAfterApply,
  type StateVersionReadiness,
} from "../../lib/capsules-ui.ts";
import { installRunNeedsFallbackRead } from "./install-run-polling.ts";

interface Props {
  readonly planRunId: string;
  readonly initialRunId?: string;
  readonly onState?: (state: "installing" | "failed" | "ready") => void;
  readonly capsuleId: string;
  readonly onDone: () => void;
  readonly onRestart?: () => Promise<void>;
  readonly restartLabel?: string;
  /** Discards a never-applied attempt; omitted where the app is already installed. */
  readonly onDiscard?: () => Promise<void>;
}

const READINESS_READ_ATTEMPTS = 3;
const READINESS_RETRY_DELAY_MS = 1_000;

export function installRunStatusTone(
  type: string,
  status: string,
  readiness: StateVersionReadiness | undefined,
): "danger" | "ok" | "info" {
  if (status === "failed" || status === "cancelled" || status === "expired") {
    return "danger";
  }
  if (type === "apply" && readiness === "activation_failed") return "danger";
  if (status === "succeeded" && (type !== "apply" || readiness === "ready")) {
    return "ok";
  }
  return "info";
}

export interface BoundedReadOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface InstallReadinessReaders {
  readonly listStateVersions: (
    capsuleId: string,
    opts?: { readonly signal?: AbortSignal },
  ) => ReturnType<typeof listStateVersions>;
  readonly listActivity: (
    workspaceId: string,
    limit?: number,
    opts?: { readonly signal?: AbortSignal },
  ) => ReturnType<typeof listActivity>;
}

type InstallReadinessResult =
  | { readonly kind: "state"; readonly value: StateVersionReadiness }
  | { readonly kind: "read-failed"; readonly cause: unknown };

function isAbortError(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

function throwReadAbort(signal: AbortSignal): never {
  if (isAbortError(signal.reason)) throw signal.reason;
  throw new DOMException("Request was aborted.", "AbortError");
}

const defaultReadinessReaders: InstallReadinessReaders = {
  listStateVersions,
  listActivity,
};

/**
 * Retry a read a finite number of times. Readiness is a derived read model,
 * so a short transient D1/Activity failure is worth retrying, but a failed
 * read must eventually remain observable to the UI instead of spinning.
 */
export async function boundedRead<T>(
  read: () => Promise<T>,
  options: BoundedReadOptions = {},
): Promise<T> {
  const attempts = Math.max(
    1,
    Math.floor(options.attempts ?? READINESS_READ_ATTEMPTS),
  );
  const delayMs = Math.max(
    0,
    Math.floor(options.delayMs ?? READINESS_RETRY_DELAY_MS),
  );
  const sleep =
    options.sleep ??
    ((duration: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, duration)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throwReadAbort(options.signal);
    try {
      return await read();
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      if (options.signal?.aborted) throwReadAbort(options.signal);
      lastError = cause;
      if (attempt + 1 < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

/** Read post-apply lifecycle evidence for one InstallExecution run. */
export async function readInstallReadiness(
  key: string,
  readers: InstallReadinessReaders = defaultReadinessReaders,
  retry: BoundedReadOptions = {},
): Promise<StateVersionReadiness> {
  const parsed = JSON.parse(key) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    !parsed.every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new Error("Install readiness key is invalid");
  }
  const [workspaceId, capsuleId, applyRunId] = parsed as [
    string,
    string,
    string,
  ];
  return await boundedRead(async () => {
    const [versions, activity] = await Promise.all([
      readers.listStateVersions(capsuleId, { signal: retry.signal }),
      readers.listActivity(workspaceId, 100, { signal: retry.signal }),
    ]);
    return stateVersionReadinessAfterApply(
      versions.find((version) => version.createdByRunId === applyRunId),
      activity,
      capsuleId,
    );
  }, retry);
}

export default function InstallExecution(props: Props) {
  const [runId, setRunId] = createSignal(props.initialRunId ?? props.planRunId);
  const [run, { mutate, refetch }] = createResource(runId, async (id) => {
    const value = await getRun(id);
    if (value.id !== id || value.capsuleId !== props.capsuleId) throw new Error(t("installStore.recoveryUnverified"));
    return value;
  });
  // Never `run()` / `run.latest`: both THROW once a load has failed, and the
  // 3s fallback read below means one 5xx mid-install replaced the whole app
  // with the root reload card. A failed refetch keeps the last good run.
  const runLatest = createLastGoodValue(run, (r) => r.id === runId());
  const [applying, setApplying] = createSignal(false);
  const [applyUnconfirmed, setApplyUnconfirmed] = createSignal(false);
  const [logsOpen, setLogsOpen] = createSignal(false);
  const [logs, { refetch: refetchLogs }] = createResource(
    () => logsOpen() ? runId() : false, async (id) => ({ runId: id, logs: await getRunLogs(id) }),
  );
  const logLatest = createLastGoodValue(logs, (value) => value.runId === runId());
  createEffect(() => {
    if (!logsOpen()) return;
    const timer = setInterval(() => { if (!logs.loading) void refetchLogs(); }, 3_000);
    onCleanup(() => clearInterval(timer));
  });
  const [approving, setApproving] = createSignal(false);
  const [confirmed, setConfirmed] = createSignal(false);
  const [restarting, setRestarting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [hasSeenApply, setHasSeenApply] = createSignal(false);
  createEffect(() => { if (runLatest()?.type === "apply") setHasSeenApply(true); });

  createEffect(() => {
    const id = runId();
    const close = openRunStream(id, {
      onRun: (next) => {
        if (next.id !== runId() || next.capsuleId !== props.capsuleId) return;
        mutate(next);
        // A failed read's error outlives `mutate`; re-read so the pushed
        // status shows now rather than at the next fallback read.
        if (run.error) void refetch();
      },
    });
    const timer = globalThis.setInterval(() => {
      const latest = runLatest();
      // A pending fallback read already has its own deadline. Keep one read
      // in flight so later ticks cannot replace its eventual result/error.
      if (!run.loading && installRunNeedsFallbackRead(latest)) {
        void refetch();
      }
    }, 3_000);
    onCleanup(() => {
      close();
      globalThis.clearInterval(timer);
    });
  });

  const readinessKey = () => {
    const latest = runLatest();
    return latest?.type === "apply" && latest.status === "succeeded"
      ? JSON.stringify([latest.workspaceId, props.capsuleId, latest.id])
      : null;
  };
  let activeReadinessController: AbortController | undefined;
  const [readiness, { refetch: refetchReadiness }] = createResource(
    readinessKey,
    async (key): Promise<InstallReadinessResult> => {
      activeReadinessController?.abort();
      const controller = new AbortController();
      activeReadinessController = controller;
      try {
        return {
          kind: "state",
          value: await readInstallReadiness(key, defaultReadinessReaders, {
            signal: controller.signal,
          }),
        };
      } catch (cause) {
        // controlFetch already redirects expired sessions to sign-in. Keep
        // that authority transition (and resource cancellation) intact; only
        // ordinary readback failures are represented as local retry state.
        if (
          isAbortError(cause) ||
          (cause instanceof ControlApiError && cause.status === 401)
        ) {
          throw cause;
        }
        if (cause instanceof ControlApiError || cause instanceof TypeError) {
          return { kind: "read-failed", cause };
        }
        throw cause;
      } finally {
        if (activeReadinessController === controller) {
          activeReadinessController = undefined;
        }
      }
    },
  );
  createEffect(() => {
    if (readinessKey() !== null) return;
    activeReadinessController?.abort();
    activeReadinessController = undefined;
  });
  onCleanup(() => activeReadinessController?.abort());

  // Raw `.latest` on purpose: ordinary read failures come back as
  // `read-failed` (inline retry), but an UNEXPECTED error is rethrown by the
  // fetcher so it escapes to the page error boundary — fail closed, never an
  // Open link for an install whose readiness is unknown.
  const readinessState = () => {
    const result = readiness.latest;
    return result?.kind === "state" ? result.value : undefined;
  };

  const readinessFailure = createMemo(() => {
    if (readiness.loading) return undefined;
    const result = readiness.latest;
    return result?.kind === "read-failed"
      ? friendlyError(result.cause, t)
      : undefined;
  });

  createEffect(() => {
    if (!readinessKey()) return;
    if (readiness.loading) return;
    if (readinessFailure()) return;
    const state = readinessState();
    if (state === "ready") {
      props.onDone();
      return;
    }
    if (state === "activation_failed") {
      setError(t("installStore.activationFailed"));
      return;
    }
    const timer = globalThis.setTimeout(() => void refetchReadiness(), 3_000);
    onCleanup(() => globalThis.clearTimeout(timer));
  });

  const summary = () => runLatest()?.summary;
  const countsKnown = () => Boolean(summary());
  const destructive = () => {
    const latest = runLatest();
    return (
      !countsKnown() ||
      (summary()?.destroy ?? 0) > 0 ||
      latest?.requiresApproval === true
    );
  };
  const planReady = () => {
    const latest = runLatest();
    return (
      latest?.type === "plan" &&
      latest.status === "succeeded" &&
      latest.policyStatus === "pass"
    );
  };

  const approve = async () => {
    setApproving(true);
    setError(null);
    try {
      mutate(await approveRun(runId(), { reason: "dashboard install review" }));
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setApproving(false);
    }
  };

  const install = async () => {
    if (applying() || applyUnconfirmed() || !planReady() || (destructive() && !confirmed())) return;
    setApplying(true);
    setError(null);
    try {
      const envelope = await createApplyRun(runId(), { timeoutMs: 30_000 });
      mutate(undefined);
      setRunId(envelope.run.id);
    } catch (cause) {
      // A timeout after POST is indeterminate. Do not retry from this surface;
      // the run detail remains the recovery/audit path.
      if (!(cause instanceof ControlApiError) || cause.status === 0 || cause.status >= 500) {
        setApplyUnconfirmed(true);
        setError(t("installStore.applyUnconfirmed"));
      } else setError(friendlyError(cause, t).message);
    } finally {
      setApplying(false);
    }
  };

  // Apply starts only from the "Allow and install" click on the reviewed Plan.
  // Nothing applies automatically, and no consent survives a reload or URL.
  // Unknown POSTs are held.
  let observedInitialRun = props.initialRunId ?? props.planRunId;
  createEffect(() => {
    const id = props.initialRunId ?? props.planRunId;
    if (id === observedInitialRun) return;
    observedInitialRun = id;
    setConfirmed(false); setApplyUnconfirmed(false); setError(null);
    mutate(undefined); setRunId(id);
  });
  const retryFailedApply = async () => {
    setRestarting(true); setError(null);
    try {
      const id = extractRunId(await planCapsule(props.capsuleId));
      if (!id) throw new Error(t("installStore.planMissing"));
      setConfirmed(false); setApplyUnconfirmed(false); mutate(undefined); setRunId(id);
    } catch (cause) { setError(friendlyError(cause, t).message); }
    finally { setRestarting(false); }
  };

  const retryReadiness = () => {
    setError(null);
    void refetchReadiness();
  };

  const restartWithLatestSource = async () => {
    setRestarting(true);
    setError(null);
    try {
      await props.onRestart?.();
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setRestarting(false);
    }
  };

  // The review shows what the Plan will do in the user's cloud and what it is
  // estimated to cost. A failed cost read is shown as unknown, never as free.
  const reviewedPlanRunId = () => {
    const latest = runLatest();
    return latest?.type === "plan" && latest.status === "succeeded" ? latest.id : undefined;
  };
  const [planCost] = createResource(reviewedPlanRunId, (id) =>
    readRunCost(() => getRunCostInfo(id)),
  );
  const costState = (): RunCostDisplayState | undefined => {
    const read = planCost.error ? { status: "unavailable" as const } : planCost.latest;
    return read ? runCostDisplayState(read) : undefined;
  };
  const costLine = (state: RunCostDisplayState): string | undefined => {
    if (runCostDisplayHasContent(state)) return undefined;
    return state.kind === "rated_zero"
      ? t("installStore.costRatedZero", { amount: formatUsdMicros(0) })
      : t("installStore.costNotApplicable");
  };

  const [discarding, setDiscarding] = createSignal(false);
  const discard = async () => {
    setDiscarding(true);
    try {
      await props.onDiscard?.();
    } finally {
      setDiscarding(false);
    }
  };
  // Discarding is offered only before anything was applied.
  const discardButton = () => (
    <Show when={props.onDiscard && !hasSeenApply()}>
      <Button
        type="button"
        variant="ghost"
        busy={discarding()}
        disabled={applying() || discarding()}
        onClick={() => void discard()}
      >
        {t("installStore.discard")}
      </Button>
    </Show>
  );

  const failed = () => {
    const status = runLatest()?.status;
    return status === "failed" || status === "cancelled" || status === "expired";
  };

  createEffect(() => {
    props.onState?.(failed() || error() ? "failed" : planReady() ? "ready" : "installing");
  });

  return (
    <section class="iv-execution" aria-labelledby="iv-review-title">
      <Show when={run.loading && !run.error && !runLatest()}>
        <div class="iv-status" role="status">
          <Spinner size={18} />
          <div>
            <strong>{t("installStore.reviewing")}</strong>
            <span>{t("installStore.reviewingHint")}</span>
          </div>
        </div>
      </Show>

      {/* First read failed: say so and offer a retry. The fallback read keeps
          trying every 3s, so the review appears on its own once it loads. */}
      <Show when={run.error && !runLatest()}>
        <div class="iv-status" role="alert">
          <AlertCircle size={18} />
          <div>
            <strong>{t("run.loadFailedTitle")}</strong>
            <span>{fetchFailedMessage(run.error, t)}</span>
          </div>
          <Button
            type="button"
            variant="secondary"
            busy={run.loading}
            onClick={() => void refetch()}
          >
            {t("common.retry")}
          </Button>
        </div>
      </Show>

      <Show when={runLatest()}>
        {(current) => (
          <>
            <div class="iv-review-head">
              <div>
                <h2 id="iv-review-title">
                  {current().type === "apply"
                    ? t("installStore.installing")
                    : t("installStore.reviewTitle")}
                </h2>
                <p>
                  {current().type === "apply"
                    ? t("installStore.installingHint")
                    : t("installStore.reviewHint")}
                </p>
              </div>
              <Badge
                tone={installRunStatusTone(
                  current().type,
                  current().status,
                  readinessState(),
                )}
              >
                {current().type === "plan" && current().status === "succeeded"
                  ? t("installStore.reviewReady")
                  : runStatusLabel(current().status)}
              </Badge>
            </div>

            <Show when={current().type === "plan" && summary()}>
              <dl class="iv-change-counts" aria-label={t("installStore.changes")}>
                <div>
                  <dt>{t("installStore.createCount")}</dt>
                  <dd>{summary()?.add ?? 0}</dd>
                </div>
                <div>
                  <dt>{t("installStore.updateCount")}</dt>
                  <dd>{summary()?.change ?? 0}</dd>
                </div>
                <div>
                  <dt>{t("installStore.deleteCount")}</dt>
                  <dd>{summary()?.destroy ?? 0}</dd>
                </div>
              </dl>
            </Show>

            <Show when={reviewedPlanRunId()}>
              <section class="iv-sheet-block" data-testid="install-plan-resources">
                <PlanResourceList resources={current().planResources ?? []} sortByAction />
              </section>
              <section class="iv-sheet-block" data-testid="install-plan-cost" aria-labelledby="iv-cost-title">
                <h3 id="iv-cost-title">{t("installStore.costTitle")}</h3>
                <Show when={costState()} fallback={<Spinner size={16} />}>
                  {(state) => (
                    <>
                      <CostSummary state={state()} />
                      <Show when={costLine(state())}>
                        {(line) => <p class="iv-muted">{line()}</p>}
                      </Show>
                    </>
                  )}
                </Show>
              </section>
            </Show>

            <Show when={current().status === "waiting_approval"}>
              <div class="iv-action-row">
                <Button
                  type="button"
                  variant="primary"
                  busy={approving()}
                  onClick={() => void approve()}
                >
                  {t("installStore.approve")}
                </Button>
                <Button
                  href={`/runs/${encodeURIComponent(current().id)}`}
                  variant="ghost"
                  icon={<ExternalLink size={16} />}
                >
                  {t("installStore.runDetails")}
                </Button>
              </div>
            </Show>

            <Show when={planReady()}>
              <Show when={destructive()}>
                <div class="iv-review-warning">
                  <ShieldAlert size={20} aria-hidden="true" />
                  <div>
                    <strong>{t("installStore.confirmTitle")}</strong>
                    <p>{t("installStore.confirmHint")}</p>
                    <Checkbox
                      checked={confirmed()}
                      onChange={(event) => setConfirmed(event.currentTarget.checked)}
                      label={t("installStore.confirm")}
                    />
                  </div>
                </div>
              </Show>
              <div class="iv-action-row">
                <Button
                  type="button"
                  variant="primary"
                  size="lg"
                  busy={applying()}
                  disabled={applyUnconfirmed() || (destructive() && !confirmed())}
                  onClick={() => void install()}
                >
                  {t("installStore.allowInstall")}
                </Button>
                {discardButton()}
                <Button
                  href={`/runs/${encodeURIComponent(current().id)}`}
                  variant="ghost"
                  icon={<ExternalLink size={16} />}
                >
                  {t("installStore.runDetails")}
                </Button>
              </div>
            </Show>

            <Show
              when={
                current().type === "plan" &&
                current().status === "succeeded" &&
                !planReady()
              }
            >
              <div class="iv-error" role="alert">
                <AlertCircle size={18} aria-hidden="true" />
                <div>
                  <strong>{t("installStore.planBlocked")}</strong>
                  <p>{t("installStore.planBlockedHint")}</p>
                  <div class="iv-action-row">
                    <Button
                      href={`/runs/${encodeURIComponent(current().id)}`}
                      variant="secondary"
                      icon={<ExternalLink size={16} />}
                    >
                      {t("installStore.runDetails")}
                    </Button>
                    {discardButton()}
                  </div>
                </div>
              </div>
            </Show>

            <Show
              when={
                current().type === "apply" &&
                !failed() &&
                !readinessFailure() &&
                readinessState() !== "activation_failed"
              }
            >
              <div class="iv-status" role="status" aria-live="polite">
                <Spinner size={18} />
                <div>
                  <strong>
                    {current().status === "succeeded"
                      ? t("installStore.finalizing")
                      : t("installStore.installing")}
                  </strong>
                  <span>
                    {current().status === "succeeded"
                      ? t("installStore.finalizingHint")
                      : t("installStore.installingHint")}
                  </span>
                </div>
              </div>
            </Show>

            <Show
              when={
                current().type === "apply" &&
                !readiness.loading &&
                readinessFailure()
              }
            >
              {(failure) => (
                <div class="iv-error" role="alert">
                  <AlertCircle size={18} aria-hidden="true" />
                  <div>
                    <strong>{t("installStore.readinessFailed")}</strong>
                    <p>{failure().message}</p>
                    <Show when={failure().detail}>
                      {(detail) => (
                        <details class="wb-inline-details">
                          <summary>{t("common.details")}</summary>
                          <pre class="wa-pre">{detail()}</pre>
                        </details>
                      )}
                    </Show>
                    <div class="iv-action-row">
                      <Button
                        type="button"
                        variant="secondary"
                        busy={readiness.loading}
                        disabled={readiness.loading}
                        onClick={retryReadiness}
                      >
                        {t("common.retry")}
                      </Button>
                      <Button
                        href={`/runs/${encodeURIComponent(current().id)}`}
                        variant="ghost"
                        icon={<ExternalLink size={16} />}
                      >
                        {t("installStore.runDetails")}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </Show>

            <Show when={failed()}>
              <div class="iv-error" role="alert">
                <strong>{t("installStore.runFailed")}</strong>
                <p>{runFailureHint(current().errorCode)}</p>
                <div class="iv-action-row">
                  <Show when={current().type === "apply"}>
                    <Button type="button" variant="primary" busy={restarting()} onClick={() => void retryFailedApply()}>{t("installStore.retryInstall")}</Button>
                  </Show>
                  <Show when={current().type === "plan"}>
                    <Button
                      type="button"
                      variant="primary"
                      busy={restarting()}
                      disabled={restarting()}
                      onClick={() => void (props.onRestart && !hasSeenApply() ? restartWithLatestSource() : retryFailedApply())}
                    >
                      {props.onRestart && !hasSeenApply() ? (props.restartLabel ?? t("installStore.restartWithLatestSource")) : t("installStore.retryInstall")}
                    </Button>
                  </Show>
                  <Button
                    href={`/runs/${encodeURIComponent(current().id)}`}
                    variant="secondary"
                    icon={<ExternalLink size={16} />}
                  >
                    {t("installStore.runDetails")}
                  </Button>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>

      <details class="iv-advanced" onToggle={(event) => setLogsOpen(event.currentTarget.open)}>
        <summary>{t("installStore.logs")}</summary>
        <Show when={logs.loading && !logLatest()}><Spinner size={16} /></Show>
        <Show when={logs.error}><p role="alert">{fetchFailedMessage(logs.error, t)}</p></Show>
        <Show when={!logs.error && logLatest()}>{(value) => <pre class="iv-log-lines" data-testid="install-run-logs">{
          value().logs.diagnostics.map((d) => `[${d.severity}] ${d.message}${d.detail ? `\n${d.detail}` : ""}`).join("\n") || t("installStore.noLogs")
        }</pre>}</Show>
      </details>

      <Show when={error() && !readinessFailure()}>
        {(message) => (
          <div class="iv-error" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <p>{message()}</p>
          </div>
        )}
      </Show>
    </section>
  );
}
