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
  listActivity,
  listStateVersions,
  openRunStream,
  type Run,
} from "../../lib/control-api.ts";
import { t } from "../../i18n/index.ts";
import { Badge, Button, Checkbox, Spinner } from "../../components/ui/index.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { runFailureHint } from "../../lib/run-errors.ts";
import {
  stateVersionReadinessAfterApply,
  type StateVersionReadiness,
} from "../../lib/capsules-ui.ts";
import { installRunNeedsFallbackRead } from "./install-run-polling.ts";

interface Props {
  readonly planRunId: string;
  readonly capsuleId: string;
  readonly onDone: () => void;
  readonly onRestart: () => Promise<void>;
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
}

export interface InstallReadinessReaders {
  readonly listStateVersions: typeof listStateVersions;
  readonly listActivity: typeof listActivity;
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
    try {
      return await read();
    } catch (cause) {
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
      readers.listStateVersions(capsuleId),
      readers.listActivity(workspaceId, 100),
    ]);
    return stateVersionReadinessAfterApply(
      versions.find((version) => version.createdByRunId === applyRunId),
      activity,
      capsuleId,
    );
  }, retry);
}

export default function InstallExecution(props: Props) {
  const [runId, setRunId] = createSignal(props.planRunId);
  const [run, { mutate, refetch }] = createResource(runId, getRun);
  const [applying, setApplying] = createSignal(false);
  const [approving, setApproving] = createSignal(false);
  const [confirmed, setConfirmed] = createSignal(false);
  const [restarting, setRestarting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const id = runId();
    const close = openRunStream(id, {
      onRun: (next) => {
        mutate(next);
      },
    });
    const timer = globalThis.setInterval(() => {
      const latest = run.latest;
      if (installRunNeedsFallbackRead(latest)) {
        void refetch();
      }
    }, 3_000);
    onCleanup(() => {
      close();
      globalThis.clearInterval(timer);
    });
  });

  const readinessKey = () => {
    const latest = run.latest;
    return latest?.type === "apply" && latest.status === "succeeded"
      ? JSON.stringify([latest.workspaceId, props.capsuleId, latest.id])
      : null;
  };
  const [readiness, { refetch: refetchReadiness }] = createResource(
    readinessKey,
    async (key): Promise<InstallReadinessResult> => {
      try {
        return { kind: "state", value: await readInstallReadiness(key) };
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
      }
    },
  );

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

  const summary = () => run.latest?.summary;
  const countsKnown = () => Boolean(summary());
  const destructive = () => {
    const latest = run.latest;
    return (
      !countsKnown() ||
      (summary()?.destroy ?? 0) > 0 ||
      latest?.requiresApproval === true
    );
  };
  const planReady = () => {
    const latest = run.latest;
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
    if (!planReady() || (destructive() && !confirmed())) return;
    setApplying(true);
    setError(null);
    try {
      const envelope = await createApplyRun(runId(), { timeoutMs: 30_000 });
      mutate(undefined);
      setRunId(envelope.run.id);
    } catch (cause) {
      // A timeout after POST is indeterminate. Do not retry from this surface;
      // the run detail remains the recovery/audit path.
      setError(friendlyError(cause, t).message);
    } finally {
      setApplying(false);
    }
  };

  const retryReadiness = () => {
    setError(null);
    void refetchReadiness();
  };

  const restartWithLatestSource = async () => {
    setRestarting(true);
    setError(null);
    try {
      await props.onRestart();
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setRestarting(false);
    }
  };

  const failed = () => {
    const status = run.latest?.status;
    return status === "failed" || status === "cancelled" || status === "expired";
  };

  return (
    <section class="iv-execution" aria-labelledby="iv-review-title">
      <Show when={run.loading && !run.latest}>
        <div class="iv-status" role="status">
          <Spinner size={18} />
          <div>
            <strong>{t("installStore.reviewing")}</strong>
            <span>{t("installStore.reviewingHint")}</span>
          </div>
        </div>
      </Show>

      <Show when={run.latest}>
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
                {current().status}
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
                  disabled={destructive() && !confirmed()}
                  onClick={() => void install()}
                >
                  {t("installStore.install")}
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
                  <Show when={current().type === "plan"}>
                    <Button
                      type="button"
                      variant="primary"
                      busy={restarting()}
                      disabled={restarting()}
                      onClick={() => void restartWithLatestSource()}
                    >
                      {t("installStore.restartWithLatestSource")}
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
