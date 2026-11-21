import {
  createMemo,
  createUniqueId,
  For,
  type JSX,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Plus, Search, Settings2, X } from "lucide-solid";
import HomeAppGrid from "./HomeAppGrid.tsx";
import { createHomeLibrary, type HomeApp } from "../../lib/home-apps.ts";
import Page from "../account/components/auth/Page.tsx";
import IncomingOwnershipTransfers from "./IncomingOwnershipTransfers.tsx";
import AppFace from "../../components/AppFace.tsx";
import { resolveAppIcon } from "../../lib/app-face.ts";
import { type AppState } from "../../lib/app-page.ts";
import { homeAppOpens, homeAppWaiting } from "../../lib/home-launcher.ts";
import { type MessageKey, t } from "../../i18n/index.ts";
import { Button, Input, Toast } from "../../components/ui/index.ts";
import { fetchFailedMessage } from "../../lib/error-copy.ts";
import { appPageHref } from "../../lib/app-links.ts";
import { screenOpenRoute } from "../../lib/open-choice-state.ts";
import { openRouteAnchor, openRouteAria } from "../../lib/app-launch-link.ts";

type MarkKind = "alert" | "info" | "warn" | "quiet";
const STATE_MARK: Readonly<Partial<Record<AppState, { readonly label: MessageKey; readonly kind: MarkKind }>>> = {
  needs_attention: { label: "apps.state.needsAttention", kind: "alert" },
  update_available: { label: "apps.state.updateAvailable", kind: "info" },
  installing: { label: "apps.state.installing", kind: "info" },
  uninstalling: { label: "apps.state.uninstalling", kind: "warn" },
  stopped: { label: "apps.state.stopped", kind: "quiet" },
};

export default function AppListView() {
  return <Page title={t("apps.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const { home, firstPage, cursor, apps, names, query, setQuery, term, matches,
    setVisible, screens, loadingMore, moreFailed, failedScreens, retryVisible, refresh, loadNext,
    searching, searchComplete } = createHomeLibrary();
  const titleId = createUniqueId();
  let searchInput: HTMLInputElement | undefined;
  function clearSearch() { setQuery(""); searchInput?.focus(); }

  return (
    <>
      <IncomingOwnershipTransfers appNames={names()} onChanged={refresh} />
      <div data-testid="home-apps">
        <Switch>
          <Match when={home.loading && !firstPage()}><LauncherSkeleton /></Match>
          <Match when={home.error}>
            <Toast tone="error">{fetchFailedMessage(home.error, t)}
              <Button variant="secondary" size="sm" type="button" onClick={() => void refresh()}>{t("common.retry")}</Button>
              <Show when={term()}>
                <Button variant="secondary" size="sm" type="button" onClick={clearSearch}>{t("apps.clearSearch")}</Button>
              </Show>
            </Toast>
          </Match>
          <Match when={firstPage()}>
            <Show when={apps().length > 0 || cursor() || term()} fallback={<AppStartPanel />}>
              <div class="av-section-head">
                <h1 id={titleId}>{t("apps.sectionYours")}</h1>
                <Show when={!cursor()}>
                  <span class="av-section-head-count">{apps().length}</span>
                </Show>
              </div>
              <div class="av-home-search" role="search" aria-label={t("apps.search")}>
                <Search size={18} aria-hidden="true" />
                <Input
                  ref={searchInput}
                  type="search"
                  maxLength={200}
                  aria-label={t("apps.search")}
                  placeholder={t("apps.search")}
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") clearSearch(); }}
                />
                <Show when={query()}>
                  <button type="button" aria-label={t("apps.clearSearch")} onClick={clearSearch}>
                    <X size={18} aria-hidden="true" />
                  </button>
                </Show>
              </div>
              <Show when={firstPage()?.surfacesFailed || failedScreens()}>
                <Toast tone="error">
                  {t("apps.listIncomplete")}
                  <Button variant="secondary" size="sm" type="button" onClick={() => firstPage()?.surfacesFailed ? void refresh() : retryVisible()}>{t("common.retry")}</Button>
                </Toast>
              </Show>
              <Show when={moreFailed()}>
                <Toast tone="error">
                  {t("apps.moreFailed")}
                  <Button variant="secondary" size="sm" type="button" onClick={() => void loadNext()}>{t("common.retry")}</Button>
                </Toast>
              </Show>
              <Show when={term() && !matches().length && searchComplete()}>
                <p class="av-search-empty" role="status">{t("apps.noMatches")}</p>
              </Show>
              <HomeAppGrid
                apps={matches()} labelId={titleId}
                onVisible={setVisible}
                onNearEnd={() => { if (cursor() && !moreFailed() && !home.loading) void loadNext(); }}
                render={(app, position) => <HomeAppTile position={position} name={names().get(app.id) ?? app.name} app={{ ...app, ...screens().get(app.id)?.detail }} />}
                footer={!term() ? (position) => <li style={position()}><a class="av-tile av-tile-add" href="/new">
                  <span class="av-tile-icon" aria-hidden="true"><Plus /></span>
                  <span class="av-tile-name">{t("apps.browse")}</span>
                </a></li> : undefined}
              />
              <Show when={loadingMore() || searching()}><p class="av-home-loading" role="status">{t("common.loading")}</p></Show>
            </Show>
          </Match>
        </Switch>
      </div>
    </>
  );
}

function kindClass(kind: string | undefined): string {
  return kind === "site" || kind === "storage" || kind === "worker"
    ? `av-tile-k-${kind}`
    : "av-tile-k-default";
}

function HomeAppTile(props: { readonly name: string; readonly app: HomeApp; readonly position: () => JSX.CSSProperties }) {
  const name = () => props.name;
  const icon = createMemo(() => {
    const surface = props.app.surfaces[0];
    return surface ? resolveAppIcon(surface.icon, surface.url) : {};
  });
  const mark = () => STATE_MARK[props.app.state];
  const shared = () => props.app.role === "member";
  const captionId = createUniqueId();
  const describedBy = () => (mark() || shared() ? captionId : undefined);
  const route = createMemo(() => {
    const surface = homeAppOpens(props.app) ? props.app.surfaces[0] : undefined;
    return surface ? screenOpenRoute(props.app.id, surface) : undefined;
  });
  const pageHref = () => appPageHref(props.app.id);
  const anchor = createMemo(() => { const open = route(); return open && openRouteAnchor(open); });
  const settings = () => props.app.state === "ready" || props.app.state === "update_available";

  return (
    <li
      style={props.position()}
      data-testid="home-app"
      data-app-state={props.app.state}
      data-app-opens={Boolean(route()) ? "true" : "false"}
      data-capsule-id={props.app.id}
    >
      <span class="av-tile-wrap">
        <a
          class="av-tile"
          classList={{ "av-tile-waiting": homeAppWaiting(props.app) }}
          href={anchor()?.href ?? pageHref()}
          target={anchor()?.target}
          rel={anchor()?.rel}
          data-open-route={route()?.kind}
          aria-label={route() ? openRouteAria(route()!, name()) : name()}
          aria-describedby={describedBy()}
          title={name()}
        >
          <span class="av-tile-face">
            <AppFace
              class="av-tile-icon"
              imageFrameClass="av-tile-icon-image"
              monogramFrameClass={kindClass(props.app.category)}
              imageClass="av-tile-image"
              emojiClass="av-tile-emoji"
              monogramClass="av-tile-mono"
              name={name()}
              iconUrl={props.app.iconUrl ?? icon().imageSrc}
              emoji={icon().emoji}
            />
            <Show when={mark()}>
              {(state) => <span class={`av-tile-dot av-tile-dot-${state().kind}`} aria-hidden="true" />}
            </Show>
          </span>
          <span class="av-tile-label">
            <span class="av-tile-name">{name()}</span>
            <Show when={describedBy()}>
              <span class="av-tile-captions" id={captionId}>
                <Show when={mark()}>
                  {(state) => <span class={`av-tile-state av-tile-state-${state().kind}`}>{t(state().label)}</span>}
                </Show>
                <Show when={shared()}>
                  <span class="av-tile-state">{props.app.ownerDisplayName ? t("app.sharing.sharedBy", { name: props.app.ownerDisplayName }) : t("apps.shared")}</span>
                </Show>
              </span>
            </Show>
          </span>
        </a>
        <Show when={settings() || route()}>
          <span class="av-tile-actions">
            <a
              class="av-tile-manage"
              href={settings() ? appPageHref(props.app.id, "settings") : pageHref()}
              aria-label={t(settings() ? "apps.settingsAria" : "apps.manageAria", { name: name() })}
            >
              <Settings2 size={13} aria-hidden="true" />
              <span>{t(settings() ? "app.settings.title" : "apps.manage")}</span>
            </a>
          </span>
        </Show>
      </span>
    </li>
  );
}

function LauncherSkeleton() {
  return (
    <ul class="av-launcher" aria-hidden="true">
      <For each={[0, 1, 2, 3, 4, 5]}>
        {() => <li><span class="av-tile"><span class="tg-skel av-tile-skel" /></span></li>}
      </For>
    </ul>
  );
}

function AppStartPanel() {
  return (
    <section class="av-start" aria-label={t("apps.start.aria")}>
      <div class="av-start-copy">
        <h1 class="av-start-title">{t("apps.start.titleEmpty")}</h1>
      </div>
      <a href="/new" class="av-start-action">
        <span>{t("apps.start.optionStore")}</span>
      </a>
    </section>
  );
}
