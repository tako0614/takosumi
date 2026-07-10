/**
 * Shared, layout-agnostic TCS store browser. Built in the dashboard so the takos
 * product can reuse it via the `@takosumi/dashboard/*` alias. It owns repository
 * discovery (search / sort / multi-server aggregation / detail) but NOT
 * installing; each host injects the single add flow it wants to open.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import {
  initTcsState,
  loadMoreTcs,
  sortTcsItems,
  type AggregatedTcsListing,
  type TcsAggregateState,
  type TcsLocale,
} from "../../lib/tcs-aggregate.ts";
import {
  addTcsServer,
  getTcsServers,
  removeTcsServer,
} from "../../lib/tcs-servers.ts";
import type { TcsListing, TcsSort } from "../../lib/tcs-client.ts";
import "./StoreBrowser.css";

const STR = {
  tagline: {
    ja: "追加できるサービスを探す",
    en: "Find services to add",
  },
  search: { ja: "サービスを検索…", en: "Search services…" },
  sortUpdated: { ja: "更新順", en: "Recently updated" },
  sortName: { ja: "名前順", en: "Name" },
  storeFilter: { ja: "表示ストア", en: "Store" },
  allStores: { ja: "すべてのストア", en: "All stores" },
  loadMore: { ja: "もっと読み込む", en: "Load more" },
  none: { ja: "該当するサービスがありません", en: "No matching services" },
  loadFailed: {
    ja: "ストアに接続できませんでした。",
    en: "The store could not be reached.",
  },
  retry: { ja: "再試行", en: "Retry" },
  sortLabel: { ja: "並び順", en: "Sort" },
  servers: { ja: "ストア取得元", en: "Store sources" },
  serversAdvanced: { ja: "詳細", en: "Advanced" },
  addServer: { ja: "追加", en: "Add" },
  serverPlaceholder: {
    ja: "https://store.example.com",
    en: "https://store.example.com",
  },
  defaultStore: { ja: "既定のストア", en: "Default store" },
  remove: { ja: "削除", en: "Remove" },
  unreachable: { ja: "接続不可", en: "unreachable" },
  alsoOn: { ja: "他にもあり", en: "also elsewhere" },
  install: { ja: "追加", en: "Add" },
  close: { ja: "閉じる", en: "Close" },
  source: { ja: "取得元の詳細", en: "Source details" },
  technicalDetails: {
    ja: "取得元",
    en: "Source",
  },
  sourceLocation: { ja: "取得元", en: "Source" },
  folder: { ja: "フォルダ", en: "Folder" },
  openRepo: { ja: "リポジトリ", en: "Repository" },
} as const;

function s(key: keyof typeof STR, locale: TcsLocale): string {
  return STR[key][locale];
}
function pick(t: { ja: string; en: string }, locale: TcsLocale): string {
  return (locale === "ja" ? t.ja : t.en) || t.en || t.ja;
}
function repoUrl(git: string): string | undefined {
  const stripped = git.replace(/\.git$/i, "").trim();
  try {
    const url = new URL(stripped);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
function listingSearchText(listing: TcsListing, locale: TcsLocale): string {
  return [
    pick(listing.name, locale),
    pick(listing.description, locale),
    listing.suggestedName,
    listing.provider,
    listing.category,
    ...(listing.badges ?? []),
    listing.source.git,
  ]
    .join(" ")
    .toLowerCase();
}

/** Monogram fallback (1–2 chars) for a listing whose repo declares no icon. */
function monogramInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const compact = trimmed.replace(/[^\p{L}\p{N}]+/gu, "");
  return (compact.slice(0, 2) || trimmed.slice(0, 1)).toUpperCase();
}

function listingIcon(listing: TcsListing, locale: TcsLocale) {
  return (
    <span class="tcs-app-icon" aria-hidden="true">
      <Show
        when={listing.iconUrl}
        fallback={
          <span class="tcs-app-mono">
            {monogramInitials(pick(listing.name, locale))}
          </span>
        }
      >
        {(src) => <img src={src()} alt="" loading="lazy" />}
      </Show>
    </span>
  );
}

const EMPTY: TcsAggregateState = {
  servers: [],
  sort: "updated",
  locale: "ja",
  limitPerServer: 24,
  cursors: {},
  items: [],
  status: [],
  done: true,
  loading: false,
};

export interface StoreBrowserProps {
  readonly locale: TcsLocale;
  readonly onConfigure: (listing: TcsListing) => void;
  readonly showSourceControls?: boolean;
  readonly showSortControl?: boolean;
  readonly loadRemoteOnMount?: boolean;
}

export const StoreBrowser: Component<StoreBrowserProps> = (props) => {
  const [sort, setSort] = createSignal<TcsSort>("updated");
  const [searchInput, setSearchInput] = createSignal("");
  const [activeQuery, setActiveQuery] = createSignal("");
  const [activeStore, setActiveStore] = createSignal("");
  const [agg, setAgg] = createSignal<TcsAggregateState>(EMPTY);
  const [selected, setSelected] = createSignal<AggregatedTcsListing | null>(
    null,
  );
  const [showServers, setShowServers] = createSignal(false);
  const [serverDraft, setServerDraft] = createSignal("");
  const showSourceControls = () => props.showSourceControls ?? true;
  const showSortControl = () => props.showSortControl ?? true;

  const setSearchValue = (value: string) => {
    setSearchInput(value);
    setActiveQuery(value.trim());
  };

  let reqToken = 0;
  async function rebuild() {
    const token = ++reqToken;
    const base = initTcsState(getTcsServers(), {
      sort: sort(),
      locale: props.locale,
      q: activeQuery() || undefined,
    });
    setAgg({ ...base, loading: true });
    const next = await loadMoreTcs(base);
    if (token === reqToken) setAgg(next);
  }

  onMount(() => {
    if (props.loadRemoteOnMount ?? true) void rebuild();
  });
  // Re-sort (cheap) on locale change without a refetch.
  createEffect(() => {
    const loc = props.locale;
    setAgg((p) => ({
      ...p,
      locale: loc,
      items: sortTcsItems(p.items, p.sort, loc),
    }));
  });
  createEffect(() => {
    const selected = activeStore();
    if (!selected) return;
    const stillPresent = agg().status.some((st) => st.base === selected);
    if (!stillPresent) setActiveStore("");
  });

  const onSearch = (e: Event) => {
    e.preventDefault();
    setActiveQuery(searchInput().trim());
    void rebuild();
  };
  const onSort = (v: TcsSort) => {
    setSort(v);
    void rebuild();
  };
  const onLoadMore = async () => {
    // Same request token as rebuild(): a stale load-more result must not
    // clobber a newer search/sort/server rebuild.
    const token = ++reqToken;
    setAgg((p) => ({ ...p, loading: true }));
    const next = await loadMoreTcs(agg());
    if (token === reqToken) setAgg(next);
  };
  const onAddServer = (e: Event) => {
    e.preventDefault();
    if (addTcsServer(serverDraft())) {
      setServerDraft("");
      void rebuild();
    }
  };
  const onRemoveServer = (base: string) => {
    removeTcsServer(base);
    void rebuild();
  };

  // Store nodes are the single source of installable listings; the dashboard
  // no longer hardcodes a built-in template list.
  const allItems = createMemo(() =>
    sortTcsItems(agg().items, sort(), props.locale),
  );

  const storeChoices = createMemo(() => agg().status.map((st) => st.base));

  const listingForActiveStore = (
    listing: AggregatedTcsListing,
  ): AggregatedTcsListing => {
    const base = activeStore();
    if (
      !base ||
      !listing.seenOn.includes(base) ||
      listing.primaryServer === base
    ) {
      return listing;
    }
    const status = agg().status.find((st) => st.base === base);
    return {
      ...listing,
      primaryServer: base,
      primaryDefault: status?.isDefault ?? false,
    };
  };

  const displayed = createMemo(() =>
    allItems()
      .filter(
        (l) =>
          (!activeStore() || l.seenOn.includes(activeStore())) &&
          (!activeQuery() ||
            listingSearchText(l, props.locale).includes(
              activeQuery().toLowerCase(),
            )),
      )
      .map((listing) => listingForActiveStore(listing)),
  );

  const installButton = (listing: TcsListing) => {
    return (
      <button
        type="button"
        class="tcs-btn tcs-primary"
        onClick={() => props.onConfigure(listing)}
      >
        {s("install", props.locale)}
      </button>
    );
  };


  return (
    <div class="tcs-root">
      <div class="tcs-controls">
        <form class="tcs-search" onSubmit={onSearch}>
          <input
            name="storeSearch"
            type="search"
            value={searchInput()}
            onInput={(e) => setSearchValue(e.currentTarget.value)}
            placeholder={s("search", props.locale)}
            aria-label={s("search", props.locale)}
          />
        </form>
        <Show when={showSortControl()}>
          <select
            name="storeSort"
            class="tcs-sort"
            aria-label={s("sortLabel", props.locale)}
            value={sort()}
            onChange={(e) => onSort(e.currentTarget.value as TcsSort)}
          >
            <option value="updated">{s("sortUpdated", props.locale)}</option>
            <option value="name">{s("sortName", props.locale)}</option>
          </select>
        </Show>
        <Show when={storeChoices().length > 1}>
          <label class="tcs-select-label">
            <span>{s("storeFilter", props.locale)}</span>
            <select
              name="storeSource"
              class="tcs-sort"
              value={activeStore()}
              onChange={(e) => setActiveStore(e.currentTarget.value)}
            >
              <option value="">{s("allStores", props.locale)}</option>
              <For each={storeChoices()}>
                {(base) => <option value={base}>{base}</option>}
              </For>
            </select>
          </label>
        </Show>
        <Show when={showSourceControls()}>
          <button
            type="button"
            class="tcs-btn"
            aria-expanded={showServers()}
            onClick={() => setShowServers((v) => !v)}
          >
            {s("serversAdvanced", props.locale)}: {s("servers", props.locale)} (
            {agg().status.length})
          </button>
        </Show>
      </div>

      <Show when={showSourceControls() && showServers()}>
        <div class="tcs-servers">
          <ul>
            <For each={agg().status}>
              {(st) => (
                <li>
                  <span
                    class="tcs-dot"
                    classList={{ ok: st.ok, bad: !st.ok }}
                  />
                  <span class="tcs-mono">
                    {st.isDefault ? s("defaultStore", props.locale) : st.base}
                  </span>
                  <Show when={!st.ok}>
                    <span class="tcs-muted">
                      {s("unreachable", props.locale)}
                    </span>
                  </Show>
                  <Show when={!st.isDefault}>
                    <button
                      type="button"
                      class="tcs-btn tcs-sm"
                      onClick={() => onRemoveServer(st.base)}
                    >
                      {s("remove", props.locale)}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <form class="tcs-add" onSubmit={onAddServer}>
            <input
              name="storeServerUrl"
              type="url"
              value={serverDraft()}
              onInput={(e) => setServerDraft(e.currentTarget.value)}
              placeholder={s("serverPlaceholder", props.locale)}
              aria-label={s("serverPlaceholder", props.locale)}
            />
            <button type="submit" class="tcs-btn tcs-sm">
              {s("addServer", props.locale)}
            </button>
          </form>
        </div>
      </Show>

      <Show
        when={displayed().length > 0}
        fallback={
          <Show
            when={
              !agg().loading &&
              agg().status.length > 0 &&
              agg().status.every((st) => !st.ok)
            }
            fallback={
              <Show
                when={agg().loading}
                fallback={<p class="tcs-empty">{s("none", props.locale)}</p>}
              >
                <div class="tcs-grid" aria-hidden="true">
                  <For each={[0, 1, 2, 3, 4, 5]}>
                    {() => <div class="tcs-card tcs-card-skeleton" />}
                  </For>
                </div>
              </Show>
            }
          >
            <div class="tcs-empty">
              <p class="tcs-err">{s("loadFailed", props.locale)}</p>
              <button
                type="button"
                class="tcs-btn"
                onClick={() => void rebuild()}
              >
                {s("retry", props.locale)}
              </button>
            </div>
          </Show>
        }
      >
        <div class="tcs-grid">
          <For each={displayed()}>
            {(listing) => (
              <div class="tcs-card" data-tcs-listing-id={listing.id}>
                <div class="tcs-card-top">
                  {listingIcon(listing, props.locale)}
                  <div class="tcs-card-main">
                    <button
                      type="button"
                      class="tcs-card-open"
                      onClick={() => setSelected(listing)}
                    >
                      <h3>{pick(listing.name, props.locale)}</h3>
                      <p>{pick(listing.description, props.locale)}</p>
                    </button>
                  </div>
                </div>
                <Show when={listing.seenOn.length > 1}>
                  <div class="tcs-card-meta">
                    <span class="tcs-tag tcs-muted">
                      +{listing.seenOn.length - 1} {s("alsoOn", props.locale)}
                    </span>
                  </div>
                </Show>
                <div class="tcs-card-actions">{installButton(listing)}</div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={!agg().done}>
        <div class="tcs-loadmore">
          <button
            type="button"
            class="tcs-btn"
            disabled={agg().loading}
            onClick={onLoadMore}
          >
            {agg().loading ? "…" : s("loadMore", props.locale)}
          </button>
        </div>
      </Show>

      <Show when={selected()}>
        {(listing) => {
          // Dialog semantics for the detail drawer: focus moves in on open
          // (so Escape reaches it), Escape closes, focus restores on close.
          let drawerRef: HTMLElement | undefined;
          const previous =
            typeof document !== "undefined"
              ? (document.activeElement as HTMLElement | null)
              : null;
          onMount(() => queueMicrotask(() => drawerRef?.focus()));
          const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
              setSelected(null);
              return;
            }
            // Trap Tab inside the modal drawer: an aria-modal dialog must not
            // let focus escape to the page behind it. Only currently-visible
            // controls count (collapsed <details> contents stay excluded).
            if (e.key === "Tab" && drawerRef) {
              const focusables = Array.from(
                drawerRef.querySelectorAll<HTMLElement>(
                  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
                ),
              ).filter((el) => el.offsetParent !== null);
              const active = document.activeElement as HTMLElement | null;
              if (focusables.length === 0) {
                e.preventDefault();
                drawerRef.focus();
                return;
              }
              const first = focusables[0];
              const last = focusables[focusables.length - 1];
              if (e.shiftKey && (active === first || active === drawerRef)) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
              }
            }
          };
          if (typeof document !== "undefined") {
            document.addEventListener("keydown", onKeyDown);
          }
          onCleanup(() => {
            if (typeof document !== "undefined") {
              document.removeEventListener("keydown", onKeyDown);
            }
            previous?.focus?.();
          });
          return (
          <div class="tcs-overlay" onClick={() => setSelected(null)}>
            <aside
              class="tcs-detail"
              role="dialog"
              aria-modal="true"
              aria-label={pick(listing().name, props.locale)}
              tabindex="-1"
              ref={drawerRef}
              onClick={(e) => e.stopPropagation()}
            >
              <header>
                <div class="tcs-detail-title">
                  {listingIcon(listing(), props.locale)}
                  <div>
                    <h3>{pick(listing().name, props.locale)}</h3>
                  </div>
                </div>
                <button
                  type="button"
                  class="tcs-btn tcs-sm"
                  onClick={() => setSelected(null)}
                >
                  {s("close", props.locale)}
                </button>
              </header>
              <p class="tcs-muted">
                {pick(listing().description, props.locale)}
              </p>
              <div class="tcs-detail-actions">
                {installButton(listing())}
              </div>
              <details class="tcs-advanced">
                <summary>{s("technicalDetails", props.locale)}</summary>
                <section>
                  <h5>{s("source", props.locale)}</h5>
                  <dl class="tcs-detail-list">
                    <div>
                      <dt>{s("sourceLocation", props.locale)}</dt>
                      <dd class="tcs-mono tcs-break">{listing().source.git}</dd>
                    </div>
                    <Show when={listing().source.path}>
                      {(path) => (
                        <div>
                          <dt>{s("folder", props.locale)}</dt>
                          <dd class="tcs-mono tcs-break">{path()}</dd>
                        </div>
                      )}
                    </Show>
                  </dl>
                  <Show
                    when={repoUrl(listing().source.git)}
                    fallback={
                      <span class="tcs-mono tcs-break">
                        {listing().source.git}
                      </span>
                    }
                  >
                    {(href) => (
                      <a
                        class="tcs-link"
                        href={href()}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {s("openRepo", props.locale)} ↗
                      </a>
                    )}
                  </Show>
                </section>
              </details>
            </aside>
          </div>
          );
        }}
      </Show>
    </div>
  );
};
