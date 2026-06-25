/**
 * Shared, layout-agnostic TCS store browser. Built in the dashboard so the takos
 * product can reuse it via the `@takosumi/dashboard/*` alias. It owns browsing
 * (search / filter / sort / multi-server aggregation / detail) but NOT installing
 * — each host injects `onInstall` (quick install) and `onConfigure` (full flow),
 * so the same UI drives the control-plane install and the takos app install.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
  type Component,
} from "solid-js";
import {
  initTcsState,
  loadMoreTcs,
  mergeTcsListingBatches,
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

type Status = {
  state: "idle" | "installing" | "done" | "error";
  message?: string;
};

const STR = {
  tagline: {
    ja: "追加できるサービスを探す",
    en: "Find services to add",
  },
  search: { ja: "サービスを検索…", en: "Search services…" },
  all: { ja: "すべて", en: "All" },
  sortUpdated: { ja: "更新順", en: "Recently updated" },
  sortName: { ja: "名前順", en: "Name" },
  loadMore: { ja: "もっと読み込む", en: "Load more" },
  none: { ja: "該当するサービスがありません", en: "No matching services" },
  servers: { ja: "ストアサーバー", en: "Store servers" },
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
  installing: { ja: "追加中…", en: "Adding…" },
  installed: { ja: "追加開始", en: "Started" },
  configure: { ja: "追加する", en: "Add" },
  close: { ja: "閉じる", en: "Close" },
  source: { ja: "提供元", en: "Source" },
  inputs: { ja: "設定項目", en: "Settings" },
  required: { ja: "必須", en: "required" },
  openRepo: { ja: "リポジトリ", en: "Repository" },
} as const;

function s(key: keyof typeof STR, locale: TcsLocale): string {
  return STR[key][locale];
}
function pick(t: { ja: string; en: string }, locale: TcsLocale): string {
  return (locale === "ja" ? t.ja : t.en) || t.en || t.ja;
}
function repoUrl(git: string, ref: string, path: string): string {
  const base = git.replace(/\.git$/i, "");
  if (/github\.com/i.test(base) && ref) {
    return `${base}/tree/${ref}${path ? `/${path}` : ""}`;
  }
  return base;
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
  readonly localListings?: readonly TcsListing[];
  readonly onInstall: (listing: TcsListing) => Promise<void> | void;
  readonly onConfigure: (listing: TcsListing) => void;
  readonly canQuickInstall?: (listing: TcsListing) => boolean;
}

export const StoreBrowser: Component<StoreBrowserProps> = (props) => {
  const [sort, setSort] = createSignal<TcsSort>("updated");
  const [searchInput, setSearchInput] = createSignal("");
  const [activeQuery, setActiveQuery] = createSignal("");
  const [fCategory, setFCategory] = createSignal("");
  const [fKind, setFKind] = createSignal("");
  const [agg, setAgg] = createSignal<TcsAggregateState>(EMPTY);
  const [selected, setSelected] = createSignal<AggregatedTcsListing | null>(
    null,
  );
  const [showServers, setShowServers] = createSignal(false);
  const [serverDraft, setServerDraft] = createSignal("");
  const [installState, setInstallState] = createSignal<Record<string, Status>>(
    {},
  );

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

  onMount(rebuild);
  // Re-sort (cheap) on locale change without a refetch.
  createEffect(() => {
    const loc = props.locale;
    setAgg((p) => ({
      ...p,
      locale: loc,
      items: sortTcsItems(p.items, p.sort, loc),
    }));
  });

  const onSearch = (e: Event) => {
    e.preventDefault();
    setActiveQuery(searchInput().trim());
    setFCategory("");
    setFKind("");
    void rebuild();
  };
  const onSort = (v: TcsSort) => {
    setSort(v);
    void rebuild();
  };
  const onLoadMore = async () => {
    setAgg((p) => ({ ...p, loading: true }));
    setAgg(await loadMoreTcs(agg()));
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

  async function handleInstall(listing: TcsListing) {
    setInstallState((p) => ({ ...p, [listing.id]: { state: "installing" } }));
    try {
      await props.onInstall(listing);
      setInstallState((p) => ({ ...p, [listing.id]: { state: "done" } }));
    } catch (err) {
      setInstallState((p) => ({
        ...p,
        [listing.id]: {
          state: "error",
          message: String((err as Error)?.message ?? err),
        },
      }));
    }
  }

  const allItems = createMemo(() =>
    sortTcsItems(
      mergeTcsListingBatches(
        mergeTcsListingBatches(
          [],
          [
            {
              base: "takosumi",
              isDefault: true,
              items: props.localListings ?? [],
            },
          ],
        ),
        agg().items.map((item) => ({
          base: item.primaryServer,
          isDefault: item.primaryDefault,
          items: [item],
        })),
      ),
      sort(),
      props.locale,
    ),
  );

  const facet = (key: "category" | "kind") =>
    createMemo(() => {
      const set = new Set<string>();
      for (const i of allItems()) set.add(i[key]);
      return [...set].sort();
    });
  const categories = facet("category");
  const kinds = facet("kind");

  const displayed = createMemo(() =>
    allItems().filter(
      (l) =>
        (!fCategory() || l.category === fCategory()) &&
        (!fKind() || l.kind === fKind()),
    ),
  );

  const installButton = (listing: TcsListing) => {
    const st = () => installState()[listing.id]?.state ?? "idle";
    const canQuickInstall = props.canQuickInstall?.(listing) ?? false;
    return (
      <Show
        when={canQuickInstall}
        fallback={
          <button
            type="button"
            class="tcs-btn tcs-primary"
            onClick={() => props.onConfigure(listing)}
          >
            {s("configure", props.locale)} →
          </button>
        }
      >
        <button
          type="button"
          class="tcs-btn tcs-primary"
          disabled={st() === "installing" || st() === "done"}
          onClick={() => handleInstall(listing)}
        >
          {st() === "installing"
            ? s("installing", props.locale)
            : st() === "done"
              ? s("installed", props.locale) + " ✓"
              : s("install", props.locale)}
        </button>
        <Show when={st() === "error"}>
          <span class="tcs-err">{installState()[listing.id]?.message}</span>
        </Show>
      </Show>
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
            onInput={(e) => setSearchInput(e.currentTarget.value)}
            placeholder={s("search", props.locale)}
          />
        </form>
        <select
          name="storeSort"
          class="tcs-sort"
          value={sort()}
          onChange={(e) => onSort(e.currentTarget.value as TcsSort)}
        >
          <option value="updated">{s("sortUpdated", props.locale)}</option>
          <option value="name">{s("sortName", props.locale)}</option>
        </select>
        <button
          type="button"
          class="tcs-btn"
          onClick={() => setShowServers((v) => !v)}
        >
          {s("servers", props.locale)} ({agg().status.length})
        </button>
      </div>

      <Show when={showServers()}>
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
            />
            <button type="submit" class="tcs-btn tcs-sm">
              {s("addServer", props.locale)}
            </button>
          </form>
        </div>
      </Show>

      <div class="tcs-filters">
        <button
          type="button"
          class="tcs-chip"
          classList={{ active: !fCategory() }}
          onClick={() => setFCategory("")}
        >
          {s("all", props.locale)}
        </button>
        <For each={categories()}>
          {(c) => (
            <button
              type="button"
              class="tcs-chip"
              classList={{ active: fCategory() === c }}
              onClick={() => setFCategory(fCategory() === c ? "" : c)}
            >
              {c}
            </button>
          )}
        </For>
        <For each={kinds()}>
          {(k) => (
            <button
              type="button"
              class="tcs-chip tcs-kind"
              classList={{ active: fKind() === k }}
              onClick={() => setFKind(fKind() === k ? "" : k)}
            >
              {k}
            </button>
          )}
        </For>
      </div>

      <Show
        when={displayed().length > 0}
        fallback={
          <p class="tcs-empty">
            {agg().loading ? "…" : s("none", props.locale)}
          </p>
        }
      >
        <div class="tcs-grid">
          <For each={displayed()}>
            {(listing) => (
              <div class="tcs-card">
                <div class="tcs-card-head">
                  <span class="tcs-badge">
                    {pick(listing.badge, props.locale)}
                  </span>
                  <Show when={listing.badges?.includes("official")}>
                    <span class="tcs-badge tcs-official">official</span>
                  </Show>
                </div>
                <button
                  type="button"
                  class="tcs-card-open"
                  onClick={() => setSelected(listing)}
                >
                  <h4>{pick(listing.name, props.locale)}</h4>
                  <p>{pick(listing.description, props.locale)}</p>
                </button>
                <div class="tcs-card-meta">
                  <span class="tcs-tag">{listing.provider}</span>
                  <span class="tcs-tag">{listing.kind}</span>
                  <Show when={listing.seenOn.length > 1}>
                    <span class="tcs-tag tcs-muted">
                      +{listing.seenOn.length - 1} {s("alsoOn", props.locale)}
                    </span>
                  </Show>
                </div>
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
        {(listing) => (
          <div class="tcs-overlay" onClick={() => setSelected(null)}>
            <aside class="tcs-detail" onClick={(e) => e.stopPropagation()}>
              <header>
                <h3>{pick(listing().name, props.locale)}</h3>
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
              <div class="tcs-detail-actions">{installButton(listing())}</div>
              <section>
                <h5>{s("source", props.locale)}</h5>
                <div class="tcs-mono tcs-break">{listing().source.git}</div>
                <div class="tcs-mono tcs-muted">
                  {listing().source.resolvedCommit ?? listing().source.ref}
                  {listing().source.path ? ` · ${listing().source.path}` : ""}
                </div>
                <a
                  class="tcs-link"
                  href={repoUrl(
                    listing().source.git,
                    listing().source.resolvedCommit ?? listing().source.ref,
                    listing().source.path,
                  )}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {s("openRepo", props.locale)} ↗
                </a>
              </section>
              <Show when={listing().inputs.length > 0}>
                <section>
                  <h5>{s("inputs", props.locale)}</h5>
                  <ul class="tcs-bare">
                    <For each={listing().inputs}>
                      {(input) => (
                        <li>
                          <span class="tcs-mono">{input.name}</span>
                          <Show when={input.required}>
                            <span class="tcs-tag tcs-muted">
                              {s("required", props.locale)}
                            </span>
                          </Show>
                          <span class="tcs-muted">
                            {" "}
                            {pick(input.label, props.locale)}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
            </aside>
          </div>
        )}
      </Show>
    </div>
  );
};
