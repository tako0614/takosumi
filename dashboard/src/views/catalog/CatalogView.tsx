/**
 * Capsule Catalog view — the "選んで入れる" (browse & install) front door.
 *
 * Root bottleneck this fixes: the dashboard's first required input used to be a
 * raw Git URL, an immediate wall for non-engineers. This view lists curated,
 * genuinely-installable entries as cards; each install button deep-links into
 * the existing `/install` flow with `git` / `ref` / `path` pre-filled (the
 * InstallFromGitView `readPrefill()` reader picks them up). Coming-soon entries
 * render WITHOUT an install button so we never ship a dead button (see the
 * honesty contract in `catalog-data.ts`).
 *
 * Reuses existing dashboard CSS (`provider-grid` / `provider-card` /
 * `status-pill` / `btn-*`) so it matches the rest of the SPA with no new CSS.
 */
import { type Component, createMemo, createResource, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import {
  Boxes,
  Cloud,
  Database,
  FileText,
  Globe,
  type LucideProps,
  MessageSquare,
  Presentation,
  Rocket,
  Server,
  Sparkles,
  Table,
  Terminal,
  Users,
} from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import StatusPill from "../account/components/StatusPill.tsx";
import { listConnections } from "../../lib/control-api.ts";
import { currentSpaceId } from "../control/space-state.ts";
import {
  CATALOG,
  type CatalogCategory,
  type CatalogEntry,
  type CatalogIconKey,
  CATEGORY_ICON_KEY,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  installHref,
} from "./catalog-data.ts";

/**
 * Resolve a data-side icon key to a lucide-solid component. Lives in the view
 * (client-only) so `catalog-data.ts` stays icon-free and unit-testable under a
 * non-DOM `bun test` runner.
 */
const ICONS: Record<CatalogIconKey, Component<LucideProps>> = {
  chat: MessageSquare,
  r2: Database,
  site: Globe,
  worker: Server,
  s3: Cloud,
  users: Users,
  rocket: Rocket,
  docs: FileText,
  slide: Presentation,
  excel: Table,
  computer: Terminal,
  sparkles: Sparkles,
  database: Database,
  server: Server,
  boxes: Boxes,
};

export default function CatalogView() {
  return <Page title="アプリを選ぶ">{() => <Inner />}</Page>;
}

/**
 * Whether the current Space already has a (usable) connection for a provider.
 * `"unknown"` means we could not load the list (no Space selected yet, or the
 * request failed), so the view shows the connect link unconditionally rather
 * than guessing the user is already set up.
 */
type ConnectionPresence = (provider: string) => boolean | "unknown";

function Inner() {
  // Load the current Space's connections so install cards can tell a beginner
  // whether they STILL need to connect a cloud provider, or are already set up.
  // Keyed on the shared current-Space id; when no Space is picked the resource
  // stays unresolved and `hasConnection` returns "unknown" (link always shown).
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [connections] = createResource(spaceId, listConnections);

  const hasConnection: ConnectionPresence = (provider) => {
    if (connections.loading || connections.error) return "unknown";
    const list = connections.latest;
    if (list === undefined) return "unknown";
    return list.some(
      (connection) =>
        connection.provider === provider && connection.status !== "revoked",
    );
  };

  const grouped = createMemo<
    readonly {
      category: CatalogCategory;
      entries: readonly CatalogEntry[];
    }[]
  >(() =>
    CATEGORY_ORDER.map((category) => ({
      category,
      entries: CATALOG.filter((entry) => entry.category === category),
    })).filter((group) => group.entries.length > 0),
  );

  return (
    <AppShell>
      <div class="page-header">
        <h1>アプリを選ぶ</h1>
        <p class="page-sub">
          一覧から選んで「インストール」を押すだけで導入できます。Git の URL
          を入力する必要はありません。
        </p>
        <div class="page-actions">
          <A href="/install" class="btn btn-secondary">
            URL を指定して導入
          </A>
        </div>
      </div>

      <For each={grouped()}>
        {(group) => (
          <section class="detail-section">
            <div class="section-heading-row">
              <div class="catalog-section-head">
                <CategoryIcon category={group.category} />
                <h2>{CATEGORY_LABELS[group.category]}</h2>
              </div>
            </div>
            <div class="provider-grid">
              <For each={group.entries}>
                {(entry) => (
                  <CatalogCard entry={entry} hasConnection={hasConnection} />
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </AppShell>
  );
}

function CategoryIcon(props: { category: CatalogCategory }) {
  const Icon = ICONS[CATEGORY_ICON_KEY[props.category]];
  return <Icon size={18} aria-hidden="true" />;
}

function CatalogCard(props: {
  entry: CatalogEntry;
  hasConnection: ConnectionPresence;
}) {
  const entry = () => props.entry;
  const Icon = ICONS[props.entry.icon];
  return (
    <article class="provider-card catalog-card" data-catalog-id={entry().id}>
      <div class="provider-card-head">
        <div class="catalog-card-title">
          <span class="catalog-card-icon">
            <Icon size={20} aria-hidden="true" />
          </span>
          <h3>{entry().title}</h3>
        </div>
        <Show
          when={entry().installable}
          fallback={
            <StatusPill class="status-installing">準備中</StatusPill>
          }
        >
          <StatusPill class="status-ready">入れられます</StatusPill>
        </Show>
      </div>

      <p class="catalog-card-summary">{entry().summary}</p>

      <Show when={entry().installable} fallback={<ComingSoonFooter entry={entry()} />}>
        <InstallableFooter entry={entry()} hasConnection={props.hasConnection} />
      </Show>
    </article>
  );
}

function InstallableFooter(props: {
  entry: CatalogEntry;
  hasConnection: ConnectionPresence;
}) {
  const entry = () => props.entry;
  return (
    <div class="catalog-card-footer">
      <Show when={entry().note}>
        {(note) => <p class="muted catalog-card-note">{note()}</p>}
      </Show>
      <Show when={entry().requiresConnection}>
        {(needed) => (
          <ConnectNote
            label={needed().label}
            connected={props.hasConnection(needed().provider)}
          />
        )}
      </Show>
      <div class="catalog-card-actions">
        <A
          href={installHref(entry())}
          class="btn btn-primary btn-sm"
          data-testid={`install-${entry().id}`}
        >
          インストール
        </A>
        <CapsuleDetails entry={entry()} />
      </div>
    </div>
  );
}

/**
 * The actionable "where do I connect?" line. The root UX gap was that cards
 * told a beginner a cloud connection is required but never linked to where it
 * happens. This always renders a real `<A href="/connections">` link; when we
 * can see the Space already has that provider's connection we soften it to a
 * reassurance, otherwise we lead with "先に <label> に接続する".
 */
function ConnectNote(props: {
  label: string;
  connected: boolean | "unknown";
}) {
  return (
    <p class="muted catalog-card-note">
      <Show
        when={props.connected === true}
        fallback={
          <>
            <A href="/connections" class="link">
              先に {props.label} に接続する
            </A>
            <span> （接続のページが開きます）</span>
          </>
        }
      >
        <span>{props.label} に接続済みです。</span>{" "}
        <A href="/connections" class="link">
          接続を確認する
        </A>
      </Show>
    </p>
  );
}

function ComingSoonFooter(props: { entry: CatalogEntry }) {
  const entry = () => props.entry;
  return (
    <div class="catalog-card-footer">
      <Show when={entry().comingSoonReason}>
        {(reason) => <p class="muted catalog-card-note">{reason()}</p>}
      </Show>
      <button class="btn btn-secondary btn-sm" type="button" disabled>
        準備中
      </button>
    </div>
  );
}

/**
 * Collapsed technical detail (Git URL / ref / path). Internal vocabulary stays
 * hidden behind a <details> so a non-engineer never sees it up front, but it is
 * available for anyone who wants to verify the source.
 */
function CapsuleDetails(props: { entry: CatalogEntry }) {
  const entry = () => props.entry;
  return (
    <details class="catalog-card-detail">
      <summary>取得元を表示</summary>
      <dl class="kv-list catalog-card-kv">
        <dt>Git</dt>
        <dd>
          <code>{entry().gitUrl}</code>
        </dd>
        <dt>Ref</dt>
        <dd>
          <code>{entry().ref}</code>
        </dd>
        <dt>Path</dt>
        <dd>
          <code>{entry().path}</code>
        </dd>
      </dl>
    </details>
  );
}
