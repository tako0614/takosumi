/**
 * History: this app's events — install, updates, settings changes, version
 * changes, uninstall — newest first. Each event with a run opens the run
 * detail page for the deep dive (failure reason, logs).
 */
import { createSignal, For, type JSX, Show } from "solid-js";
import { ChevronRight } from "lucide-solid";
import { Badge, Button, Skeleton } from "../../components/ui/index.ts";
import type { AppHistoryEvent, AppHistoryKind } from "../../lib/app-page.ts";
import { type MessageKey, t } from "../../i18n/index.ts";
import { AppSection, RelativeTime } from "./app-ui.tsx";

const HISTORY_SHOWN = 10;

const KIND_LABEL: Readonly<Record<AppHistoryKind, MessageKey>> = {
  install: "app.history.install",
  update: "app.history.update",
  version: "app.history.version",
  settings: "app.history.settings",
  change: "app.history.change",
  recovered: "app.history.recovered",
  uninstall: "app.history.uninstall",
  apply_failed: "app.history.applyFailed",
  review_failed: "app.history.reviewFailed",
  applying: "app.history.applying",
  uninstall_scheduled: "app.history.uninstallScheduled",
  uninstall_cancelled: "app.history.uninstallCancelled",
  uninstall_blocked: "app.history.uninstallBlocked",
};

function failed(kind: AppHistoryKind): boolean {
  return kind === "apply_failed" || kind === "review_failed" || kind === "uninstall_blocked";
}

export default function AppHistorySection(props: {
  readonly events: readonly AppHistoryEvent[];
  readonly loading: boolean;
  /** The run list hit its limit, so older failed attempts may be missing. */
  readonly partial: boolean;
}): JSX.Element {
  const [showAll, setShowAll] = createSignal(false);
  const shown = () => (showAll() ? props.events : props.events.slice(0, HISTORY_SHOWN));
  return (
    <AppSection id="app-history" title={t("app.history.title")} testId="app-history">
      <Show
        when={!props.loading || props.events.length > 0}
        fallback={<Skeleton variant="row" count={3} />}
      >
        <Show
          when={props.events.length > 0}
          fallback={<p class="ap-muted">{t("app.history.empty")}</p>}
        >
          <ol class="ap-history" data-testid="app-history-list">
            <For each={shown()}>
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
                  </div>
                  <Show when={failed(event.kind)}>
                    <Badge tone="danger">{t("app.history.failedBadge")}</Badge>
                  </Show>
                  <Show when={event.kind === "applying"}>
                    <Badge tone="info">{t("app.history.runningBadge")}</Badge>
                  </Show>
                  <Show when={event.runId}>
                    {(runId) => (
                      <a
                        class="ap-history-link"
                        href={`/runs/${encodeURIComponent(runId())}`}
                        aria-label={t("app.history.detailsAria", { event: t(KIND_LABEL[event.kind]) })}
                      >
                        {t("app.history.details")}
                        <ChevronRight size={14} aria-hidden="true" />
                      </a>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ol>
          <Show when={!showAll() && props.events.length > HISTORY_SHOWN}>
            <Button variant="ghost" size="sm" type="button" onClick={() => setShowAll(true)}>
              {t("app.history.more", { n: props.events.length - HISTORY_SHOWN })}
            </Button>
          </Show>
        </Show>
        <Show when={props.partial}>
          <p class="ap-muted">{t("app.history.partial")}</p>
        </Show>
      </Show>
    </AppSection>
  );
}
