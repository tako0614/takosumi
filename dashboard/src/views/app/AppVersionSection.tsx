/**
 * Version: which version of the app is installed, whether a newer one exists,
 * and the ways to change it — update, automatic updates, going back to a
 * previous version, or naming a version. Every change opens the same in-page
 * review before anything is applied.
 */
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { RefreshCw, RotateCcw } from "lucide-solid";
import { Button, Checkbox, FormField, Input, Skeleton } from "../../components/ui/index.ts";
import type {
  CapsuleAppVersion,
  PublicStateVersion,
} from "../../lib/control-api.ts";
import { repositoryLabel, versionLabel } from "../../lib/app-page.ts";
import { t } from "../../i18n/index.ts";
import { AppSection, RelativeTime } from "./app-ui.tsx";

const PREVIOUS_VERSIONS_SHOWN = 5;

export default function AppVersionSection(props: {
  /** The server's version facts: current, newest, update, autoUpdate. */
  readonly version: CapsuleAppVersion;
  /** The server could not read part of the version facts. */
  readonly versionIncomplete: boolean;
  readonly currentStateVersion?: PublicStateVersion;
  readonly stateVersions: readonly PublicStateVersion[];
  readonly stateVersionsLoading: boolean;
  readonly stateVersionsFailed: boolean;
  /** Version applied by each StateVersion, where it is known. */
  readonly versionLabels: ReadonlyMap<string, string>;
  readonly revisionReady: boolean;
  readonly reviewBusy: boolean;
  readonly starting: boolean;
  readonly error?: string;
  readonly notice?: string;
  readonly onUpdate: (ref?: string) => void;
  readonly onRollback: (stateVersionId: string) => void;
  readonly autoUpdateBusy: boolean;
  readonly autoUpdateError?: string;
  readonly onAutoUpdate: (enabled: boolean) => void;
  readonly review: JSX.Element;
}): JSX.Element {
  const [requestedRef, setRequestedRef] = createSignal("");
  const [showAllPrevious, setShowAllPrevious] = createSignal(false);
  const current = () => versionLabel(props.version.current?.ref, props.version.current?.commit);
  // A newer commit of the same ref, or an app it uses changed (stale).
  const updateAvailable = () => props.version.updateAvailable || props.version.stale;
  const dependencyChanged = () => props.version.stale && !props.version.updateAvailable;
  const newVersion = () =>
    props.version.updateAvailable && props.version.latest
      ? versionLabel(props.version.latest.ref, props.version.latest.commit)
      : undefined;
  // Previous applied versions, newest first. The current one is not offered.
  const previous = createMemo(() =>
    [...props.stateVersions]
      .filter((version) => version.id !== props.currentStateVersion?.id)
      .sort((a, b) => b.generation - a.generation),
  );
  const shownPrevious = () =>
    showAllPrevious() ? previous() : previous().slice(0, PREVIOUS_VERSIONS_SHOWN);
  const review = props.review;

  return (
    <AppSection
      id="version"
      title={t("app.version.title")}
      subtitle={t("app.version.subtitle")}
      testId="app-version"
    >
      <dl class="ap-facts">
        <div>
          <dt>{t("app.version.current")}</dt>
          <dd>
            <Show
              when={current()}
              fallback={
                <span class="ap-muted" data-incomplete={props.versionIncomplete ? "version" : undefined}>
                  {props.versionIncomplete ? t("app.incomplete.version") : t("app.version.unknown")}
                </span>
              }
            >
              {(label) => <code data-testid="app-current-version">{label()}</code>}
            </Show>
          </dd>
        </div>
        <Show when={props.version.repository?.url}>
          {(url) => (
            <div>
              <dt>{t("app.version.source")}</dt>
              <dd>
                <code>{repositoryLabel(url())}</code>
              </dd>
            </div>
          )}
        </Show>
        <Show when={props.currentStateVersion}>
          {(version) => (
            <div>
              <dt>{t("app.version.appliedAt")}</dt>
              <dd>
                <RelativeTime iso={version().createdAt} />
              </dd>
            </div>
          )}
        </Show>
      </dl>

      <div class="ap-callout" classList={{ "ap-callout-info": updateAvailable() }} data-testid="app-update">
        <div>
          <strong>
            {updateAvailable()
              ? dependencyChanged()
                ? t("app.version.dependencyChanged")
                : t("app.version.updateAvailable")
              : t("app.version.checkTitle")}
          </strong>
          <Show when={newVersion()}>
            {(label) => (
              <p>
                {t("app.version.newVersion")}{" "}
                <code data-testid="app-new-version">{label()}</code>
              </p>
            )}
          </Show>
          <Show when={!updateAvailable()}>
            <p>{t("app.version.checkHint")}</p>
          </Show>
        </div>
        <Button
          variant={updateAvailable() ? "primary" : "secondary"}
          type="button"
          icon={<RefreshCw size={16} />}
          busy={props.starting}
          disabled={props.reviewBusy || !props.revisionReady}
          onClick={() => props.onUpdate()}
        >
          {updateAvailable() ? t("app.version.update") : t("app.version.check")}
        </Button>
      </div>

      <Show when={props.error}>
        {(message) => <p class="wa-error" role="alert">{message()}</p>}
      </Show>
      <Show when={props.notice}>
        {(message) => <p class="ap-notice" role="status">{message()}</p>}
      </Show>
      {review}

      <div class="ap-subsection">
        <h3>{t("app.version.autoTitle")}</h3>
        <Checkbox
          checked={props.version.autoUpdate === true}
          disabled={props.autoUpdateBusy}
          onChange={(event) => props.onAutoUpdate(event.currentTarget.checked)}
          label={t("app.version.autoLabel")}
        />
        <p class="ap-muted">{t("app.version.autoHint")}</p>
        <Show when={props.autoUpdateError}>
          {(message) => <p class="wa-error" role="alert">{message()}</p>}
        </Show>
      </div>

      <div class="ap-subsection">
        <h3>{t("app.version.previousTitle")}</h3>
        <Show
          when={!props.stateVersionsLoading || props.stateVersions.length > 0}
          fallback={<Skeleton variant="row" count={2} />}
        >
          <Show
            when={!props.stateVersionsFailed}
            fallback={<p class="wa-error" role="alert">{t("app.version.previousLoadFailed")}</p>}
          >
            <Show
              when={previous().length > 0}
              fallback={<p class="ap-muted">{t("app.version.previousEmpty")}</p>}
            >
              <ul class="ap-list" data-testid="app-previous-versions">
                <For each={shownPrevious()}>
                  {(version) => {
                    const label = () => props.versionLabels.get(version.id);
                    return (
                      <li class="ap-list-row">
                        <div class="ap-list-main">
                          <strong>
                            <Show when={label()} fallback={t("app.version.previousUnnamed")}>
                              {(text) => <code>{text()}</code>}
                            </Show>
                          </strong>
                          <span class="ap-muted">
                            {t("app.version.appliedLabel")} <RelativeTime iso={version.createdAt} />
                          </span>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          type="button"
                          icon={<RotateCcw size={14} />}
                          disabled={props.reviewBusy}
                          onClick={() => props.onRollback(version.id)}
                        >
                          {t("app.version.rollback")}
                        </Button>
                      </li>
                    );
                  }}
                </For>
              </ul>
              <Show when={!showAllPrevious() && previous().length > PREVIOUS_VERSIONS_SHOWN}>
                <Button variant="ghost" size="sm" type="button" onClick={() => setShowAllPrevious(true)}>
                  {t("app.version.previousMore", { n: previous().length - PREVIOUS_VERSIONS_SHOWN })}
                </Button>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>

      <form
        class="ap-subsection ap-version-form"
        onSubmit={(event) => {
          event.preventDefault();
          const ref = requestedRef().trim();
          if (ref) props.onUpdate(ref);
        }}
      >
        <h3>{t("app.version.pinTitle")}</h3>
        <FormField label={t("app.version.pinLabel")} hint={t("app.version.pinHint")}>
          <Input
            value={requestedRef()}
            placeholder={props.version.current?.ref ?? props.version.repository?.defaultRef}
            spellcheck={false}
            autocomplete="off"
            onInput={(event) => setRequestedRef(event.currentTarget.value)}
          />
        </FormField>
        <div class="ap-row-actions">
          <Button
            variant="secondary"
            type="submit"
            disabled={props.reviewBusy || !props.revisionReady || !requestedRef().trim()}
          >
            {t("app.version.pinReview")}
          </Button>
        </div>
      </form>
    </AppSection>
  );
}

