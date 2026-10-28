/**
 * What needs the person, or is under way, for one installed app — exactly
 * as the control plane reports it in the app view (`GET /capsules/:id/app`):
 * its ordered problems, a scheduled or running uninstall, a change waiting
 * for review, and work in progress. The header carries the one primary
 * action the server chose; a card here repeats an action only when it is
 * not that primary one. Reviews opened from here render in this section.
 */
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import { ExternalLink } from "lucide-solid";
import { Button } from "../../components/ui/index.ts";
import type {
  CapsuleAppAction,
  CapsuleAppProblem,
  CapsuleAppView,
  RunType,
} from "../../lib/control-api.ts";
import { appViewIncomplete, primaryProblem, providerName } from "../../lib/app-page.ts";
import { appUninstallBanner, appUninstallExportNote } from "../../lib/capsule-uninstall.ts";
import { runFailureHint } from "../../lib/run-errors.ts";
import { t, type MessageKey } from "../../i18n/index.ts";
import { AppSection } from "./app-ui.tsx";
import RunPolicyReasons from "./RunPolicyReasons.tsx";

export interface AttentionActions {
  readonly retry: (problem: CapsuleAppProblem) => void;
  readonly retryScreen: (problem: CapsuleAppProblem) => void;
  readonly fixConnection: () => void;
  readonly continueInstall: () => void;
  readonly cancelUninstall: () => void;
  readonly uninstallNow: () => void;
  readonly openReview: (runId: string, runType: RunType) => void;
}

const CONNECTION_STATUS: Readonly<Record<string, MessageKey>> = {
  missing: "app.problem.connectionMissing",
  revoked: "app.problem.connectionRevoked",
  expired: "app.problem.connectionExpired",
  error: "app.problem.connectionError",
};

/** The action a problem card offers for its own problem. */
const PROBLEM_ACTION: Readonly<Partial<Record<CapsuleAppProblem["code"], CapsuleAppAction>>> = {
  connection_unavailable: "fix_connection",
  policy_blocked: "retry",
  run_failed: "retry",
  capsule_error: "retry",
  install_incomplete: "continue_install",
  screen_unavailable: "retry_screen",
};

/** Problems the uninstall card tells, not a card of their own. */
const UNINSTALL_CODES = new Set<CapsuleAppProblem["code"]>([
  "uninstall_scheduled",
  "uninstall_blocked",
  "uninstall_failed",
]);

/** What a problem is, stable across polls of the same app view. */
export function problemKey(problem: CapsuleAppProblem): string {
  return [
    problem.code,
    problem.runId ?? "",
    problem.provider ?? "",
    problem.connectionId ?? "",
    problem.screenFailure?.id ?? "",
  ].join("\u0000");
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function sameProblem(a: CapsuleAppProblem | undefined, b: CapsuleAppProblem | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
}

function failedRunTitle(problem: CapsuleAppProblem): MessageKey {
  if (problem.runType === "destroy_plan" || problem.runType === "destroy_apply") {
    return "app.problem.uninstallFailed";
  }
  return problem.runType === "apply" ? "app.problem.applyFailed" : "app.problem.reviewFailed";
}

export default function AppAttentionSection(props: {
  readonly app: CapsuleAppView;
  readonly displayName: string;
  /** A review or change is being started, so other changes wait. */
  readonly busy: boolean;
  /** Which action is starting right now, for its busy spinner. */
  readonly startingAction?: CapsuleAppAction;
  readonly uninstallBusy: boolean;
  readonly uninstallError?: string;
  readonly screenRetryBusy: boolean;
  readonly screenRetryMessage?: string;
  readonly error?: string;
  readonly notice?: string;
  /** The run of the review open in this section, if any. */
  readonly reviewRunId?: string;
  readonly review: JSX.Element;
  readonly actions: AttentionActions;
}): JSX.Element {
  const app = () => props.app;
  const first = () => primaryProblem(app());
  /** True when this card's action is the header's primary action. */
  const isPrimary = (problem: CapsuleAppProblem, action: CapsuleAppAction | undefined) => {
    const primary = first();
    return action !== undefined && app().primaryAction === action &&
      primary !== undefined && problemKey(primary) === problemKey(problem);
  };
  const cards = () => app().problems.filter((problem) => !UNINSTALL_CODES.has(problem.code));
  const cardKeys = createMemo(() => cards().map(problemKey), undefined, { equals: sameKeys });
  const cardByKey = () => new Map(cards().map((problem) => [problemKey(problem), problem]));
  const scheduled = () => app().uninstall.scheduled;
  const uninstallFailed = () => app().problems.find((problem) => problem.code === "uninstall_failed");
  const uninstallBlocked = () => app().problems.find((problem) => problem.code === "uninstall_blocked");
  const showUninstallCard = () => Boolean(scheduled() || uninstallFailed() || uninstallBlocked());
  const pendingReview = () => {
    const review = app().progress.review;
    // A review the server is waiting on that is not already open here.
    return review && review.runId !== props.reviewRunId && app().state === "installed"
      ? review
      : undefined;
  };
  const preparing = () =>
    app().progress.revisionPreparing && !app().progress.run && !app().progress.review &&
    props.reviewRunId === undefined;
  const screenProblemsUnknown = () => appViewIncomplete(app(), "screen_problems");
  const hasError = () => app().problems.some((problem) => problem.severity === "error");
  const visible = () =>
    app().state !== "uninstalled" &&
    (cards().length > 0 || showUninstallCard() || Boolean(pendingReview()) || preparing() ||
      screenProblemsUnknown() || props.reviewRunId !== undefined ||
      Boolean(props.error) || Boolean(props.notice));

  const banner = () => appUninstallBanner(app(), props.displayName);
  const exportNote = () => appUninstallExportNote(app());
  // Teardown that is running (and not stopped) cannot be interrupted here.
  const teardownRunning = () =>
    scheduled()?.phase === "destroying" && !scheduled()?.blocked && !uninstallFailed();
  const offerCancel = () =>
    scheduled()?.cancellable === true && app().primaryAction !== "cancel_uninstall";
  const offerUninstallNow = () =>
    !teardownRunning() && app().primaryAction !== "uninstall_now" &&
    app().state !== "uninstalling";

  const detailsLink = (runId: string) => (
    <Button variant="secondary" href={`/runs/${encodeURIComponent(runId)}`} icon={<ExternalLink size={16} />}>
      {t("app.problem.details")}
    </Button>
  );
  const serverSaid = (code: string | undefined) => (
    <Show when={code}>
      {(value) => (
        <p class="ap-detail">
          {t("app.problem.serverSaid")} <code>{value()}</code>
        </p>
      )}
    </Show>
  );
  const actionButton = (problem: CapsuleAppProblem) => {
    const action = PROBLEM_ACTION[problem.code];
    if (!action || isPrimary(problem, action)) return null;
    switch (action) {
      case "fix_connection":
        return (
          <Button variant="secondary" type="button" onClick={() => props.actions.fixConnection()}>
            {t("app.action.fixConnection")}
          </Button>
        );
      case "continue_install":
        return (
          <Button
            variant="secondary"
            type="button"
            busy={props.startingAction === "continue_install"}
            disabled={props.busy}
            onClick={() => props.actions.continueInstall()}
          >
            {t("app.problem.continueInstall")}
          </Button>
        );
      case "retry_screen":
        return (
          <Button
            variant="secondary"
            type="button"
            busy={props.screenRetryBusy}
            disabled={props.screenRetryBusy}
            onClick={() => props.actions.retryScreen(problem)}
          >
            {t("app.problem.screenRetry")}
          </Button>
        );
      default:
        return (
          <Button
            variant="secondary"
            type="button"
            busy={props.startingAction === "retry"}
            disabled={props.busy}
            onClick={() => props.actions.retry(problem)}
          >
            {/* Without a run to repeat, an installed app's version is planned again. */}
            {t(!problem.runId && app().applied ? "app.problem.retryInstalled" : "app.problem.retry")}
          </Button>
        );
    }
  };

  return (
    <Show when={visible()}>
      <AppSection
        id="attention"
        title={
          hasError()
            ? t("app.problem.title")
            : showUninstallCard()
              ? t("app.uninstall.title")
              : t("app.progress.title")
        }
        testId="app-problems"
      >
        <div class="ap-problems">
          <Show when={showUninstallCard()}>
            <article class="ap-problem ap-problem-warn" data-problem="uninstall">
              <strong>{banner()}</strong>
              <Show when={uninstallFailed()}>
                {(problem) => <p>{runFailureHint(problem().errorCode)}</p>}
              </Show>
              <Show when={uninstallBlocked()?.reason}>{(reason) => serverSaid(reason())}</Show>
              <Show when={exportNote()}>{(note) => <p>{note()}</p>}</Show>
              <div class="ap-row-actions">
                <Show when={offerCancel()}>
                  <Button
                    variant="secondary"
                    type="button"
                    busy={props.uninstallBusy}
                    disabled={props.uninstallBusy}
                    onClick={() => props.actions.cancelUninstall()}
                  >
                    {t("app.uninstall.cancel")}
                  </Button>
                </Show>
                <Show
                  when={uninstallFailed()}
                  fallback={
                    <Show when={offerUninstallNow()}>
                      <Button
                        variant="secondary"
                        type="button"
                        busy={props.startingAction === "uninstall_now"}
                        disabled={props.busy}
                        onClick={() => props.actions.uninstallNow()}
                      >
                        {t("app.uninstall.now")}
                      </Button>
                    </Show>
                  }
                >
                  {(problem) => (
                    <>
                      <Show when={!isPrimary(problem(), "retry")}>
                        <Button
                          variant="secondary"
                          type="button"
                          busy={props.startingAction === "retry"}
                          disabled={props.busy}
                          onClick={() => props.actions.retry(problem())}
                        >
                          {t("app.problem.retry")}
                        </Button>
                      </Show>
                      <Show when={problem().runId}>{(runId) => detailsLink(runId())}</Show>
                    </>
                  )}
                </Show>
              </div>
              <Show when={props.uninstallError}>
                {(message) => <p class="wa-error" role="alert">{message()}</p>}
              </Show>
            </article>
          </Show>

          {/* Keyed by what each problem is, not by object identity: a poll
              that returns the same problems keeps the cards (and focus). */}
          <For each={cardKeys()}>
            {(key) => {
              const problem = createMemo(() => cardByKey().get(key), undefined, { equals: sameProblem });
              return (
                <Show when={problem()}>
                  {(problem) => (
              <article class="ap-problem" data-problem={problem().code}>
                <Switch>
                  <Match when={problem().code === "connection_unavailable"}>
                    <strong>{t("app.problem.connection")}</strong>
                    <p>
                      {t("app.problem.connectionHint", {
                        provider: problem().provider ? providerName(problem().provider!) : t("common.unknown"),
                        status: t(CONNECTION_STATUS[problem().connectionStatus ?? ""] ?? "app.problem.connectionError"),
                      })}
                    </p>
                  </Match>
                  <Match when={problem().code === "policy_blocked"}>
                    <strong>{t("app.problem.policyBlocked")}</strong>
                    <p>{t("app.problem.policyBlockedHint")}</p>
                    <Show when={problem().runId}>
                      {(runId) => (
                        <RunPolicyReasons runId={runId()} capsuleId={app().capsuleId} reportLoadFailure />
                      )}
                    </Show>
                  </Match>
                  <Match when={problem().code === "run_failed"}>
                    <strong>{t(failedRunTitle(problem()))}</strong>
                    <p>{runFailureHint(problem().errorCode)}</p>
                    {serverSaid(problem().errorCode)}
                  </Match>
                  <Match when={problem().code === "capsule_error"}>
                    <strong>{t("app.problem.error")}</strong>
                    <p>{t("app.problem.errorHint")}</p>
                  </Match>
                  <Match when={problem().code === "install_incomplete"}>
                    <strong>{t("app.problem.installIncomplete")}</strong>
                    <p>{t("app.problem.installIncompleteHint")}</p>
                  </Match>
                  <Match when={problem().code === "screen_unavailable"}>
                    <strong>{t("app.problem.screen")}</strong>
                    <p>{t("app.problem.screenHint")}</p>
                    {serverSaid(problem().screenFailure?.errorCode)}
                  </Match>
                  <Match when={true}>
                    {/* A problem a newer server reports: say only that there is one. */}
                    <strong>{t("app.problem.error")}</strong>
                    {serverSaid(problem().code)}
                  </Match>
                </Switch>
                <div class="ap-row-actions">
                  {actionButton(problem())}
                  <Show when={problem().runId}>{(runId) => detailsLink(runId())}</Show>
                </div>
                <Show when={problem().code === "screen_unavailable" && props.screenRetryMessage}>
                  <p role="status">{props.screenRetryMessage}</p>
                </Show>
              </article>
                  )}
                </Show>
              );
            }}
          </For>

          <Show when={screenProblemsUnknown()}>
            <p class="ap-muted" role="status" data-incomplete="screen_problems">
              {t("app.incomplete.screen_problems")}
            </p>
          </Show>

          <Show when={pendingReview()}>
            {(review) => (
              <article class="ap-problem ap-problem-info" data-problem="review-waiting">
                <strong>{t("app.progress.reviewWaiting")}</strong>
                <p>{t("app.progress.reviewWaitingHint")}</p>
                <div class="ap-row-actions">
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={props.busy}
                    onClick={() => props.actions.openReview(review().runId, review().runType)}
                  >
                    {t("app.action.review")}
                  </Button>
                </div>
              </article>
            )}
          </Show>

          <Show when={preparing()}>
            <p class="ap-notice" role="status" data-progress="preparing">{t("app.progress.preparing")}</p>
          </Show>

          <Show when={props.error}>
            {(message) => <p class="wa-error" role="alert">{message()}</p>}
          </Show>
          <Show when={props.notice}>
            {(message) => <p class="ap-notice" role="status">{message()}</p>}
          </Show>
          {props.review}
        </div>
      </AppSection>
    </Show>
  );
}
