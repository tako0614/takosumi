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
  createUniqueId,
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
import { inertBackground } from "../../lib/modal-inert.ts";
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
  loadMore: { ja: "さらに読み込む", en: "Load more" },
  none: { ja: "該当するサービスがありません", en: "No matching services" },
  noneUnfetched: {
    ja: "読み込み済みの範囲には該当がありません。続きを読み込むか、Enter でストア全体を検索できます。",
    en: "No matches in what's loaded yet. Load more, or press Enter to search the whole store.",
  },
  loadFailed: {
    ja: "ストアに接続できませんでした。",
    en: "The store could not be reached.",
  },
  partialOutage: {
    ja: "一部のストアに接続できませんでした。表示が不完全な可能性があります。",
    en: "Some stores could not be reached; results may be incomplete.",
  },
  invalidServer: {
    ja: "http(s):// で始まる URL を入力してください。",
    en: "Enter a URL that starts with http(s)://.",
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
  unreachable: { ja: "接続不可", en: "Unreachable" },
  reachable: { ja: "接続済み", en: "Connected" },
  alsoOn: { ja: "他にもあり", en: "also elsewhere" },
  noStore: {
    ja: "ストアの取得元が設定されていません。",
    en: "No store source is configured.",
  },
  noStoreCta: { ja: "取得元を設定", en: "Configure a source" },
  install: { ja: "インストール", en: "Install" },
  installAria: { ja: "インストール: {name}", en: "Install {name}" },
  loadingAnnounce: { ja: "読み込み中…", en: "Loading…" },
  resultsAnnounce: {
    ja: "{n} 件のサービスが見つかりました",
    // Count-neutral: the STR table has no plural support.
    en: "Services found: {n}",
  },
  close: { ja: "閉じる", en: "Close" },
  source: { ja: "取得元の詳細", en: "Source details" },
  technicalDetails: {
    ja: "取得元",
    en: "Source",
  },
  sourceLocation: { ja: "取得元", en: "Source" },
  folder: { ja: "フォルダ", en: "Folder" },
  openRepo: { ja: "取得元を開く", en: "Open source" },
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
    listing.source.url,
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
  const [failed, setFailed] = createSignal(false);
  return (
    <span class="tcs-app-icon" aria-hidden="true">
      <Show
        when={listing.iconUrl && !failed() ? listing.iconUrl : undefined}
        fallback={
          <span class="tcs-app-mono">
            {monogramInitials(pick(listing.name, locale))}
          </span>
        }
      >
        {(src) => (
          <img
            src={src()}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
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
  const [serverError, setServerError] = createSignal(false);
  // Associates the invalid-server alert text with the URL input for AT.
  const serverErrorId = createUniqueId();
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
      setServerError(false);
      void rebuild();
    } else {
      // Rejected input previously did nothing at all (type="url" misses
      // e.g. ftp://) — say why the server was not added.
      setServerError(true);
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

  // One reachable store plus one unreachable one = a silently-incomplete grid.
  // Extracted so the visible notice and its persistent live region share it.
  const partialOutage = createMemo(
    () =>
      !agg().loading &&
      agg().status.some((st) => st.ok) &&
      agg().status.some((st) => !st.ok),
  );

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

  // The local substring filter is for INCREMENTAL typing only. Once a query has
  // been submitted, the aggregate already holds server-filtered results, and
  // re-testing them with `includes()` silently discarded matches the store had
  // found (a two-word query, or a match on a field the client does not index).
  const displayed = createMemo(() => {
    const submitted = agg().q ?? "";
    const localQuery = submitted === activeQuery() ? "" : activeQuery();
    return allItems()
      .filter(
        (l) =>
          (!activeStore() || l.seenOn.includes(activeStore())) &&
          (!localQuery ||
            listingSearchText(l, props.locale).includes(
              localQuery.toLowerCase(),
            )),
      )
      .map((listing) => listingForActiveStore(listing));
  });

  // Store-listing byline. Presentation only — publisher identity never grants
  // install authority.
  const publisherLabel = (listing: TcsListing): string => {
    const publisher = listing.publisher;
    if (!publisher) return "";
    return publisher.displayName?.trim() || `@${publisher.handle}`;
  };

  // App-store posture: the grid repeats one quiet action per card, and the
  // filled accent button is reserved for the detail drawer where a single
  // listing has the user's attention.
  const installButton = (listing: TcsListing, prominent = false) => {
    return (
      <button
        type="button"
        class={prominent ? "tcs-btn tcs-primary" : "tcs-btn tcs-install"}
        // Every card repeats the same visible "追加"/"Add"; the accessible
        // name carries the listing so the buttons are distinguishable.
        aria-label={s("installAria", props.locale).replace(
          "{name}",
          pick(listing.name, props.locale),
        )}
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
              {/* Mask the default store as 既定のストア, exactly like the
                  Store sources list — not its raw base URL. */}
              <For each={agg().status}>
                {(st) => (
                  <option value={st.base}>
                    {st.isDefault ? s("defaultStore", props.locale) : st.base}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>
        <Show when={showSourceControls()}>
          <button
            type="button"
            class="tcs-btn tcs-quiet"
            aria-expanded={showServers()}
            onClick={() => setShowServers((v) => !v)}
          >
            {s("servers", props.locale)} ({agg().status.length})
          </button>
        </Show>
      </div>

      {/* Persistently-mounted polite live region: search / sort / load
          outcomes are otherwise conveyed only by the grid repainting. */}
      <p class="sr-only" role="status" aria-live="polite">
        {agg().loading
          ? s("loadingAnnounce", props.locale)
          : displayed().length === 0
            ? s("none", props.locale)
            : s("resultsAnnounce", props.locale).replace(
                "{n}",
                String(displayed().length),
              )}
      </p>

      <Show when={showSourceControls() && showServers()}>
        <div class="tcs-servers">
          <ul>
            <For each={agg().status}>
              {(st) => (
                <li>
                  <span
                    class="tcs-dot"
                    classList={{ ok: st.ok, bad: !st.ok }}
                    aria-hidden="true"
                  />
                  {/* The green dot is color-only; mirror the ok state as
                      text (the bad state already shows "unreachable"). */}
                  <Show when={st.ok}>
                    <span class="sr-only">{s("reachable", props.locale)}</span>
                  </Show>
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
              onInput={(e) => {
                setServerDraft(e.currentTarget.value);
                setServerError(false);
              }}
              placeholder={s("serverPlaceholder", props.locale)}
              aria-label={s("serverPlaceholder", props.locale)}
              aria-invalid={serverError() ? "true" : undefined}
              aria-describedby={serverError() ? serverErrorId : undefined}
            />
            <button type="submit" class="tcs-btn tcs-sm">
              {s("addServer", props.locale)}
            </button>
          </form>
          <Show when={serverError()}>
            <p class="tcs-err" role="alert" id={serverErrorId}>
              {s("invalidServer", props.locale)}
            </p>
          </Show>
        </div>
      </Show>

      {/* Persistent polite region: the visible partial-outage notice below is
          conditionally mounted, and a role=status inserted together with its
          text can go unannounced — mount this empty and fill it instead. */}
      <p class="sr-only" role="status" aria-live="polite">
        <Show when={partialOutage()}>{s("partialOutage", props.locale)}</Show>
      </p>

      {/* One unreachable store among several silently dropped its listings
          (the only hint was a dot inside the collapsed Advanced panel). The
          announcement is handled by the persistent region above, so this
          visible notice carries no role. */}
      <Show when={partialOutage()}>
        <p class="tcs-partial">
          {s("partialOutage", props.locale)}{" "}
          <button
            type="button"
            class="tcs-btn tcs-sm"
            onClick={() => void rebuild()}
          >
            {s("retry", props.locale)}
          </button>
        </p>
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
                fallback={
                  <Show
                    when={agg().status.length > 0}
                    fallback={
                      // No store source is configured at all (self-host with
                      // no VITE_TAKOSUMI_TCS_STORE_URL). "No matching services"
                      // reads as an empty search result and offers nothing.
                      <p class="tcs-empty">
                        <span>{s("noStore", props.locale)}</span>
                        <Show when={showSourceControls()}>
                          <button
                            type="button"
                            class="tcs-btn"
                            onClick={() => setShowServers(true)}
                          >
                            {s("noStoreCta", props.locale)}
                          </button>
                        </Show>
                      </p>
                    }
                  >
                    <p class="tcs-empty">
                      {/* With unfetched pages left, a flat "no matches" is a
                          lie — the match may simply not be loaded yet. */}
                      {agg().done
                        ? s("none", props.locale)
                        : s("noneUnfetched", props.locale)}
                    </p>
                  </Show>
                }
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
                    {/* Heading OUTSIDE the button: a button's descendants are
                        presentational, so an <h2> nested in it vanishes from
                        the document outline. The button (named by the title
                        only) opens the detail drawer; the description is a
                        sibling, not swallowed by the button. */}
                    <h2 class="tcs-card-title">
                      <button
                        type="button"
                        class="tcs-card-open"
                        onClick={() => setSelected(listing)}
                      >
                        {pick(listing.name, props.locale)}
                      </button>
                    </h2>
                    <Show when={publisherLabel(listing)}>
                      {(publisher) => <p class="tcs-card-by">{publisher()}</p>}
                    </Show>
                    <p class="tcs-card-desc">
                      {pick(listing.description, props.locale)}
                    </p>
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
          // Dialog semantics for the detail drawer: the backgrounded app is
          // inert while open, focus moves in on open (so Escape reaches it),
          // Escape closes, focus restores on close.
          let overlayRef: HTMLDivElement | undefined;
          let drawerRef: HTMLElement | undefined;
          let restoreInert: (() => void) | undefined;
          const previous =
            typeof document !== "undefined"
              ? (document.activeElement as HTMLElement | null)
              : null;
          onMount(() => {
            if (overlayRef) restoreInert = inertBackground(overlayRef);
            queueMicrotask(() => drawerRef?.focus());
          });
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
            // Restore before refocusing: an inert element refuses focus.
            restoreInert?.();
            previous?.focus?.();
          });
          return (
            <div
              class="tcs-overlay"
              ref={overlayRef}
              onClick={() => setSelected(null)}
            >
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
                      <h2>{pick(listing().name, props.locale)}</h2>
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
                  {installButton(listing(), true)}
                </div>
                <details class="tcs-advanced">
                  <summary>{s("technicalDetails", props.locale)}</summary>
                  <section>
                    <h3>{s("source", props.locale)}</h3>
                    <dl class="tcs-detail-list">
                      <div>
                        <dt>{s("sourceLocation", props.locale)}</dt>
                        <dd class="tcs-mono tcs-break">
                          {listing().source.url}
                        </dd>
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
                      when={repoUrl(listing().source.url)}
                      fallback={
                        <span class="tcs-mono tcs-break">
                          {listing().source.url}
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
