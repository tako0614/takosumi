/**
 * History: this app's events — install, updates, settings changes, version
 * changes, failed attempts, plans a policy stopped or that wait for an
 * approval, uninstall — newest first, read from the app's own Runs page by
 * page ("Show more"). Each event opens the run detail page for the deep dive
 * (failure reason, logs); a policy event names its reasons in place.
 */
import { For, type JSX, Show } from "solid-js";
import { ChevronRight } from "lucide-solid";
import { Badge, Button, Skeleton } from "../../components/ui/index.ts";
import PolicyReasonList from "../../components/run/PolicyReasonList.tsx";
import type { AppHistoryEvent, AppHistoryKind } from "../../lib/app-page.ts";
import { type MessageKey, t } from "../../i18n/index.ts";
import { AppSection, RelativeTime } from "./app-ui.tsx";

const KIND_LABEL: Readonly<Record<AppHistoryKind, MessageKey>> = {
  install: "app.history.install",
  update: "app.history.update",
  version: "app.history.version",
  settings: "app.history.settings",
  change: "app.history.change",
  recovered: "app.history.recovered",
  uninstall: "app.history.uninstall",
  apply_failed: "app.history.applyFailed",
  uninstall_failed: "app.history.uninstallFailed",
  review_failed: "app.history.reviewFailed",
  applying: "app.history.applying",
  policy_blocked: "app.history.policyBlocked",
  approval_waiting: "app.history.approvalWaiting",
};

function failed(kind: AppHistoryKind): boolean {
  return kind === "apply_failed" || kind === "uninstall_failed" || kind === "review_failed" ||
    kind === "policy_blocked";
}

export default function AppHistorySection(props: {
  readonly events: readonly AppHistoryEvent[];
  readonly loading: boolean;
  /** The first page could not be read. */
  readonly failed: boolean;
  readonly onReload: () => void;
  /** The server has older events to read. */
  readonly hasMore: boolean;
  readonly moreBusy: boolean;
  readonly moreError?: string;
  readonly onMore: () => void;
}): JSX.Element {
  return (
    <AppSection id="history" title={t("app.history.title")} testId="app-history">
      <Show when={!props.loading} fallback={<Skeleton variant="row" count={3} />}>
        <Show
          when={!props.failed}
          fallback={
            <div class="ap-row-actions">
              <p class="wa-error" role="alert">{t("app.history.loadFailed")}</p>
              <Button variant="secondary" size="sm" type="button" onClick={() => props.onReload()}>
                {t("common.retry")}
              </Button>
            </div>
          }
        >
          <Show
            when={props.events.length > 0}
            fallback={<p class="ap-muted">{t("app.history.empty")}</p>}
          >
            <ol class="ap-history" data-testid="app-history-list">
              <For each={props.events}>
                {(event) => (
                  <li class="ap-history-row" data-history-kind={event.kind}>
                    <div class="ap-list-main">
                      <strong>
                        {t(KIND_LABEL[event.kind])}
                        <Show when={event.version}>
                          {(version) => (
                            <>
                              {" "}
                              <code>{version()}</code>
                            </>
                          )}
                        </Show>
                      </strong>
                      <span class="ap-muted">
                        <RelativeTime iso={event.at} />
                      </span>
                      <Show when={event.policyReasons}>
                        {(reasons) => <PolicyReasonList reasons={reasons()} title={false} class="ap-history-reasons" />}
                      </Show>
                    </div>
                    <Show when={failed(event.kind)}>
                      <Badge tone="danger">{t("app.history.failedBadge")}</Badge>
                    </Show>
                    <Show when={event.kind === "applying"}>
                      <Badge tone="info">{t("app.history.runningBadge")}</Badge>
                    </Show>
                    <Show when={event.kind === "approval_waiting"}>
                      <Badge tone="warn">{t("app.history.waitingBadge")}</Badge>
                    </Show>
                    <a
                      class="ap-history-link"
                      href={`/runs/${encodeURIComponent(event.runId)}`}
                      aria-label={t("app.history.detailsAria", { event: t(KIND_LABEL[event.kind]) })}
                    >
                      {t("app.history.details")}
                      <ChevronRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                )}
              </For>
            </ol>
          </Show>
          <Show when={props.hasMore}>
            <div class="ap-row-actions">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                busy={props.moreBusy}
                disabled={props.moreBusy}
                onClick={() => props.onMore()}
              >
                {t("app.history.more")}
              </Button>
            </div>
          </Show>
          <Show when={props.moreError}>
            {(message) => <p class="wa-error" role="alert">{message()}</p>}
          </Show>
        </Show>
      </Show>
    </AppSection>
  );
}
