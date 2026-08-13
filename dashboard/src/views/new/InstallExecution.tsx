import {
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { AlertCircle, ExternalLink, ShieldAlert } from "lucide-solid";
import {
  approveRun,
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
import { stateVersionReadinessAfterApply } from "../../lib/capsules-ui.ts";

interface Props {
  readonly planRunId: string;
  readonly capsuleId: string;
  readonly onDone: () => void;
}

const TERMINAL = new Set<Run["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export default function InstallExecution(props: Props) {
  const [runId, setRunId] = createSignal(props.planRunId);
  const [run, { mutate, refetch }] = createResource(runId, getRun);
  const [applying, setApplying] = createSignal(false);
  const [approving, setApproving] = createSignal(false);
  const [confirmed, setConfirmed] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const id = runId();
    let streamOpen = false;
    const close = openRunStream(id, {
      onOpen: () => {
        streamOpen = true;
      },
      onRun: (next) => {
        mutate(next);
      },
      onError: () => {
        streamOpen = false;
      },
    });
    const timer = globalThis.setInterval(() => {
      const latest = run.latest;
      if (!streamOpen && (!latest || !TERMINAL.has(latest.status))) {
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
    async (key) => {
      const [workspaceId, capsuleId, applyRunId] = JSON.parse(key) as [
        string,
        string,
        string,
      ];
      const [versions, activity] = await Promise.all([
        listStateVersions(capsuleId),
        listActivity(workspaceId, 100),
      ]);
      return stateVersionReadinessAfterApply(
        versions.find((version) => version.createdByRunId === applyRunId),
        activity,
        capsuleId,
      );
    },
  );

  createEffect(() => {
    if (!readinessKey()) return;
    if (readiness.error) {
      setError(t("installStore.readinessFailed"));
      return;
    }
    const state = readiness.latest;
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
                tone={
                  failed()
                    ? "danger"
                    : current().status === "succeeded"
                      ? "ok"
                      : "info"
                }
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
                readiness.latest !== "activation_failed"
              }
            >
              <div class="iv-status" role="status" aria-live="polite">
                <Spinner size={18} />
                <div>
                  <strong>{t("installStore.installing")}</strong>
                  <span>{t("installStore.installingHint")}</span>
                </div>
              </div>
            </Show>

            <Show when={failed()}>
              <div class="iv-error" role="alert">
                <strong>{t("installStore.runFailed")}</strong>
                <p>{current().errorCode ?? t("installStore.runFailedHint")}</p>
                <Button
                  href={`/runs/${encodeURIComponent(current().id)}`}
                  variant="secondary"
                  icon={<ExternalLink size={16} />}
                >
                  {t("installStore.runDetails")}
                </Button>
              </div>
            </Show>
          </>
        )}
      </Show>

      <Show when={error()}>
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
