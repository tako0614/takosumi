/**
 * Product visuals — faithful, simplified renderings of the real Takosumi
 * dashboard. The page argues that Takosumi is a real product; these show it.
 * Vocabulary, statuses, layout, and verb choices mirror the real views:
 *
 *  - dashboard/src/views/apps/AppListView.tsx        "あなたのアプリ" launcher
 *  - dashboard/src/views/account/components/shell/    sidebar nav + workspace
 *  - dashboard/src/views/runs/RunView.tsx            変更の確認 / 変更予定
 *  - dashboard/src/views/runs/RunsListView.tsx       デプロイ履歴
 *  - dashboard/src/views/apps/WorkloadDetailView.tsx 更新履歴 (Generation)
 *
 * Rendered in the site's own --tg-* tokens — a content-fidelity layer, not a
 * re-skin of the dashboard. Elements that look interactive are inert spans:
 * this is an illustration, so nothing here pretends to be clickable.
 */
import { For, type JSX } from "solid-js";

/* ---------- shared bits ---------- */

function Badge(props: {
  tone: "ok" | "warn" | "danger" | "muted";
  children: JSX.Element;
}) {
  return <span class={`pv-badge pv-badge-${props.tone}`}>{props.children}</span>;
}

/* ---------- (a) dashboard home — the app launcher ---------- */

interface Tile {
  readonly mono: string;
  readonly name: string;
  readonly attention?: boolean;
}

// Real ecosystem services (same set as the belt below). Monograms follow the
// dashboard's appMonogram rule: word-aware initials, uppercase.
const TILES: readonly Tile[] = [
  { mono: "TA", name: "takos" },
  { mono: "TO", name: "takos-office" },
  { mono: "TC", name: "takos-computer" },
  { mono: "YU", name: "yurucommu" },
  { mono: "RM", name: "road-to-me", attention: true },
];

export function ProductHome() {
  return (
    <section id="product" class="product-reveal">
      <div class="container">
        <h2>開いたら、この画面。</h2>
        <p class="lede">
          Takosumi を開くと、自分のサービスが並ぶダッシュボードが出てきます。
          公開リンク・更新・履歴の確認は、ここから。
        </p>
        <figure class="pv" aria-label="Takosumi ダッシュボードのホーム画面">
          <div class="pv-shell">
            <div class="pv-side">
              <div class="pv-brand">
                <img src="/tako.png" alt="" width="20" height="20" />
                <span>Takosumi</span>
              </div>
              <div class="pv-ws">
                <span class="pv-ws-avatar" aria-hidden="true">個</span>
                <span class="pv-ws-name">個人</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
              </div>
              <nav class="pv-nav" aria-label="ダッシュボードのナビゲーション">
                <span class="pv-nav-item is-active">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
                  ホーム
                </span>
                <span class="pv-nav-item">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7l1.5-4h13L20 7"/><path d="M4 7h16v3a3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1-3 3 3 3 0 0 1-3-3V7z"/><path d="M5 13.5V20h14v-6.5"/><path d="M9.5 20v-4h5v4"/></svg>
                  ストア
                </span>
                <span class="pv-nav-item">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>
                  設定
                </span>
              </nav>
            </div>
            <div class="pv-main">
              <div class="pv-main-head">
                <h3>あなたのアプリ</h3>
                <span class="pv-count">{TILES.length}</span>
              </div>
              <ul class="pv-tiles">
                <For each={TILES}>
                  {(t) => (
                    <li class="pv-tile">
                      <span class="pv-tile-icon" aria-hidden="true">
                        <span class="pv-tile-mono">{t.mono}</span>
                        {t.attention && <i class="pv-tile-dot" />}
                      </span>
                      <span class="pv-tile-name">
                        {t.name}
                        {t.attention && <span class="sr-only">要対応</span>}
                      </span>
                      <span class="pv-tile-manage">管理</span>
                    </li>
                  )}
                </For>
                <li class="pv-tile pv-tile-add">
                  <span class="pv-tile-icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
                  </span>
                  <span class="pv-tile-name">追加</span>
                </li>
              </ul>
            </div>
          </div>
        </figure>
      </div>
    </section>
  );
}

/* ---------- (b) plan review — the 変更の確認 run screen ---------- */

interface PlanRow {
  readonly action: "作成" | "変更" | "削除";
  readonly tone: "ok" | "warn" | "danger";
  readonly name: string;
  readonly address: string;
}

// Real resource types from the repo's OpenTofu modules; display names follow
// the dashboard's planResourceDisplayLabel (last type segment, capitalized).
const PLAN_ROWS: readonly PlanRow[] = [
  { action: "作成", tone: "ok", name: "Workers Script", address: "cloudflare_workers_script.yurucommu" },
  { action: "変更", tone: "warn", name: "Workers Script Subdomain", address: "cloudflare_workers_script_subdomain.yurucommu" },
  { action: "作成", tone: "ok", name: "Edge Object Bucket", address: "takoform_edge_object_bucket.yurucommu_data" },
  { action: "削除", tone: "danger", name: "Pages Project", address: "cloudflare_pages_project.yurucommu_legacy" },
];

export function PlanReview() {
  return (
    <figure class="pv pv-run" aria-label="変更の確認画面">
      <div class="pv-run-head">
        <span class="pv-crumb">デプロイ履歴</span>
        <div class="pv-run-title">
          <h3>変更の確認</h3>
          <Badge tone="warn">承認待ち</Badge>
        </div>
      </div>
      <div class="pv-card">
        <p class="pv-summary">
          この変更の実行には承認が必要です。内容を確認して承認してください。
        </p>
        <div class="pv-counts">
          <span class="pv-count-item">作成 <strong class="pv-num-ok">2</strong></span>
          <span class="pv-count-item">変更 <strong class="pv-num-warn">1</strong></span>
          <span class="pv-count-item">削除 <strong class="pv-num-danger">1</strong></span>
        </div>
        <div class="pv-actions">
          <span class="pv-btn pv-btn-primary">この変更を承認</span>
          <span class="pv-btn pv-btn-ghost">サービスへ戻る</span>
        </div>
      </div>
      <div class="pv-card">
        <div class="pv-card-head">
          <div>
            <span class="pv-kicker">確認</span>
            <h4>変更予定</h4>
          </div>
          <Badge tone="muted">{PLAN_ROWS.length} 件</Badge>
        </div>
        <ul class="pv-res">
          <For each={PLAN_ROWS}>
            {(r) => (
              <li>
                <Badge tone={r.tone}>{r.action}</Badge>
                <span class="pv-res-main">
                  <strong>{r.name}</strong>
                  <code>{r.address}</code>
                </span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </figure>
  );
}

/* ---------- (c) run + state history ---------- */

interface RunRow {
  readonly title: string;
  readonly service: string;
  readonly status: string;
  readonly tone: "ok" | "warn" | "danger";
  readonly when: string;
  readonly action: string;
}

const RUN_ROWS: readonly RunRow[] = [
  { title: "デプロイ", service: "yurucommu", status: "成功", tone: "ok", when: "2026/09/20 14:32", action: "詳細" },
  { title: "変更の確認", service: "takos", status: "デプロイ待ち", tone: "warn", when: "2026/09/19 11:08", action: "確認する" },
  { title: "デプロイに失敗しました", service: "takos-office", status: "失敗", tone: "danger", when: "2026/09/18 16:41", action: "詳細" },
  { title: "デプロイ", service: "takos", status: "成功", tone: "ok", when: "2026/09/15 09:27", action: "詳細" },
];

const STATE_ROWS = [
  { when: "2026/09/20 14:33", label: "現在", tone: "ok" as const, restore: false },
  { when: "2026/09/15 09:28", label: "Generation 5", tone: "muted" as const, restore: true },
  { when: "2026/08/30 18:45", label: "Generation 4", tone: "muted" as const, restore: true },
];

export function RunHistory() {
  return (
    <figure class="pv pv-history" aria-label="デプロイ履歴と状態の履歴">
      <div class="pv-card">
        <div class="pv-card-head">
          <h4>デプロイ履歴</h4>
        </div>
        <ul class="pv-runs">
          <For each={RUN_ROWS}>
            {(r) => (
              <li>
                <span class="pv-run-main">
                  <strong>{r.title}</strong>
                  <span class="pv-sub">{r.service}</span>
                </span>
                <Badge tone={r.tone}>{r.status}</Badge>
                <time>{r.when}</time>
                <span class="pv-btn-sm">{r.action}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="pv-card">
        <div class="pv-card-head">
          <h4>更新履歴</h4>
          <span class="pv-sub">yurucommu</span>
        </div>
        <ul class="pv-states">
          <For each={STATE_ROWS}>
            {(s) => (
              <li>
                <time>{s.when}</time>
                <Badge tone={s.tone}>{s.label}</Badge>
                {s.restore && <span class="pv-restore">以前の状態に戻す</span>}
              </li>
            )}
          </For>
        </ul>
      </div>
    </figure>
  );
}
