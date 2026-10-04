import { createSignal, For, Show } from "solid-js";
import { FEATURED_APPS } from "~/content/apps";

type Step = "choose" | "configure" | "review" | "manage";
type App = (typeof FEATURED_APPS)[number];

const steps: { id: Step; label: string; number: string }[] = [
  { id: "choose", label: "アプリを選ぶ", number: "01" },
  { id: "configure", label: "接続を確認", number: "02" },
  { id: "review", label: "内容を確認", number: "03" },
  { id: "manage", label: "使い続ける", number: "04" },
];

function AppMark(props: { app: App; size?: number }) {
  return <span class={`demo-app-mark demo-app-mark-${props.app.id}`} aria-hidden="true">
    <img src={props.app.id === "takos" ? "/apps/takos.png" : props.app.id === "yurucommu" ? "/apps/yurucommu.svg" : "/apps/office-docs.svg"} alt="" width={props.size ?? 64} height={props.size ?? 64} />
  </span>;
}

export default function InstallDemo() {
  const [appId, setAppId] = createSignal<App["id"]>("takos");
  const [step, setStep] = createSignal<Step>("choose");
  const [installName, setInstallName] = createSignal("Takos");
  const app = () => FEATURED_APPS.find(item => item.id === appId()) ?? FEATURED_APPS[0];
  const currentIndex = () => steps.findIndex(item => item.id === step());

  return <div class="demo-wrap" aria-label="Takosumi の導入フローの操作できる概念デモ">
    <div class="demo-caption"><span class="demo-live-dot" /> 操作デモ <span class="demo-caption-note">実際のインストールは行いません</span></div>
    <div class="demo-shell">
      <aside class="demo-sidebar">
        <div class="demo-sidebar-brand"><img src="/tako.png" alt="" width="28" height="28" /><span>takosumi</span></div>
        <div class="demo-workspace"><span class="demo-workspace-avatar">W</span><span>My workspace<small>個人のワークスペース</small></span><span aria-hidden="true">⌄</span></div>
        <div class="demo-sidebar-group">WORKSPACE</div>
        <div class="demo-sidebar-item"><span aria-hidden="true">◫</span> ホーム</div>
        <div class="demo-sidebar-item is-active"><span aria-hidden="true">▦</span> アプリ</div>
        <div class="demo-sidebar-item"><span aria-hidden="true">◷</span> 実行履歴</div>
        <div class="demo-sidebar-bottom"><span class="demo-avatar">M</span><span>My account<small>設定</small></span></div>
      </aside>
      <div class="demo-main">
        <div class="demo-topbar"><span>ワークスペース <span aria-hidden="true">/</span> アプリを追加</span><span class="demo-topbar-status"><span /> デモ画面</span></div>
        <div class="demo-body">
          <div class="demo-heading"><div><p class="demo-eyebrow">ADD AN APP</p><h3>{step() === "manage" ? "アプリを管理する" : "アプリを追加する"}</h3><p>{step() === "manage" ? "インストール後はここからアプリや実行を確認できます。" : "公開ソースを選び、接続と変更内容を確認して進めます。"}</p></div><span class="demo-heading-symbol" aria-hidden="true">✳</span></div>
          <div class="demo-steps" aria-label="導入デモの段階">
            <For each={steps}>{item => <button type="button" class="demo-step" classList={{ "is-current": step() === item.id, "is-past": steps.findIndex(s => s.id === item.id) < currentIndex() }} aria-current={step() === item.id ? "step" : undefined} onClick={() => setStep(item.id)}><span>{item.number}</span>{item.label}</button>}</For>
          </div>
          <div class="demo-content" aria-live="polite">
            <Show when={step() === "choose"}>
              <div class="demo-content-head"><div><span class="demo-kicker">01 / SOURCE</span><h4>どのアプリを使いますか？</h4><p>公開されたソースから、使いたいものを選びます。</p></div><span class="demo-count">{FEATURED_APPS.length} APPS</span></div>
              <div class="demo-app-grid"><For each={FEATURED_APPS}>{item => <button type="button" class="demo-app-card" classList={{ selected: appId() === item.id }} aria-pressed={appId() === item.id} onClick={() => { setAppId(item.id); setInstallName(item.name); }}><AppMark app={item} /><span class="demo-app-meta"><strong>{item.name}</strong><small>{item.category}</small></span><span class="demo-app-check" aria-hidden="true">{appId() === item.id ? "✓" : "↗"}</span><span class="demo-app-description">{item.summary}</span></button>}</For></div>
              <div class="demo-content-footer"><span>自分の Git URL からも追加できます。</span><a href="https://app.takosumi.com/new">Git URL を指定 ↗</a></div>
            </Show>
            <Show when={step() === "configure"}>
              <div class="demo-content-head"><div><span class="demo-kicker">02 / CONNECTIONS</span><h4>{app().name} を準備する</h4><p>公開ソースを読み込み、必要な接続と入力値を確認します。</p></div><AppMark app={app()} /></div>
              <div class="demo-setting-list"><div><span class="demo-setting-icon">◈</span><span><strong>公開ソース</strong><small>Git リポジトリと固定された版</small></span><span class="demo-setting-value">公開済み</span></div><div><span class="demo-setting-icon">⌁</span><span><strong>接続先</strong><small>{app().prerequisite}</small></span><span class="demo-setting-value">確認が必要</span></div><div><span class="demo-setting-icon">⌘</span><label for="demo-install-name"><strong>アプリの表示名</strong><small>ワークスペースに表示する名前</small></label><input id="demo-install-name" class="demo-name-input" type="text" maxlength="40" value={installName()} onInput={event => setInstallName(event.currentTarget.value)} /></div></div>
            </Show>
            <Show when={step() === "review"}>
              <div class="demo-content-head"><div><span class="demo-kicker">03 / REVIEW</span><h4>変更を見てから進む</h4><p>実際の計画を確認し、納得してから適用します。</p></div><span class="demo-review-badge">確認ステップ</span></div>
              <div class="demo-review-card"><div class="demo-review-top"><AppMark app={app()} size={48} /><div><strong>{installName().trim() || app().name}</strong><small>{app().name} のインストール前の確認</small></div></div><div class="demo-review-row"><span>ソース</span><strong>公開 Git リポジトリ</strong></div><div class="demo-review-row"><span>接続と設定</span><strong>選択した環境で確認</strong></div><div class="demo-review-row"><span>変更内容</span><strong>plan を確認して適用</strong></div></div>
            </Show>
            <Show when={step() === "manage"}>
              <div class="demo-content-head"><div><span class="demo-kicker">04 / WORKSPACE</span><h4>入れたあとも、ここから。</h4><p>アプリを開き、更新や実行結果を確認できます。</p></div><span class="demo-review-badge">利用イメージ</span></div>
              <div class="demo-managed-card"><div class="demo-managed-identity"><AppMark app={app()} /><span><strong>{installName().trim() || app().name}</strong><small>{app().use}</small></span></div><div class="demo-managed-actions"><a href={app().site}>アプリのサイト ↗</a><a href={app().install}>導入設定へ ↗</a></div></div>
              <div class="demo-mini-panels"><div><span>実行履歴</span><strong>変更をたどる</strong><small>過去の実行と結果を確認</small></div><div><span>ソース</span><strong>版を管理する</strong><small>新しい版の変更を確認</small></div></div>
            </Show>
          </div>
          <div class="demo-actions"><button type="button" class="demo-back" disabled={currentIndex() === 0} onClick={() => setStep(steps[currentIndex() - 1].id)}>← 戻る</button><button type="button" class="demo-next" onClick={() => setStep(steps[(currentIndex() + 1) % steps.length].id)}>{step() === "manage" ? "最初に戻る" : "次へ進む"} <span aria-hidden="true">→</span></button></div>
        </div>
      </div>
    </div>
  </div>;
}
