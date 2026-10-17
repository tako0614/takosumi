import { For } from "solid-js";
import AdringWidget from "~/components/AdringWidget";
import { FEATURED_APPS, type FeaturedApp } from "~/content/apps";
import { CAPTURES, DASHBOARD_CAPTURES } from "~/content/captures";

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function AppIcon(props: { id: FeaturedApp["id"] }) {
  return props.id === "office" ? (
    <span class="office-mark" aria-hidden="true">
      <img src="/apps/office-docs.svg" alt="" width="96" height="96" />
      <img src="/apps/office-sheet.svg" alt="" width="96" height="96" />
      <img src="/apps/office-slide.svg" alt="" width="96" height="96" />
    </span>
  ) : (
    <img src={props.id === "takos" ? "/apps/takos.png" : "/apps/yurucommu.svg"} alt="" width="128" height="128" />
  );
}

function DashboardShot(props: { capture: (typeof DASHBOARD_CAPTURES)[keyof typeof DASHBOARD_CAPTURES]; alt: string; class?: string; priority?: boolean }) {
  return (
    <div class={"dashboard-shot " + (props.class ?? "")}>
      <picture>
        <source media="(max-width: 640px) and (prefers-color-scheme: light)" srcset={props.capture.mobileLight.src} width={props.capture.mobileLight.width} height={props.capture.mobileLight.height} />
        <source media="(max-width: 640px)" srcset={props.capture.mobile.src} width={props.capture.mobile.width} height={props.capture.mobile.height} />
        <source media="(prefers-color-scheme: light)" srcset={props.capture.desktopLight.src} width={props.capture.desktopLight.width} height={props.capture.desktopLight.height} />
        <img src={props.capture.desktop.src} width={props.capture.desktop.width} height={props.capture.desktop.height} alt={props.alt} loading={props.priority ? "eager" : "lazy"} />
      </picture>
    </div>
  );
}

/** What each app's demo screen shows, for its alt text. */
const APP_SCREEN_ALT: Record<FeaturedApp["id"], string> = {
  takos: "Takos の会話画面。作業ノートと Office の更新から今週の進捗をまとめるよう頼まれ、2 件のツールを実行して結果をまとめている",
  yurucommu: "Yurucommu のホーム。ストーリーの下に、コミュニティの投稿が並んでいる",
  office: "Takos Office の文書エディター。「今週の進捗メモ」という文書を開いている",
};

function FeaturedAppRow(props: { app: FeaturedApp }) {
  const source = new URL(props.app.install).searchParams;
  const repo = source.get("git")!.replace(/\.git$/, "");
  const path = source.get("path")!;
  const ref = source.get("ref")!;
  const moduleUrl = repo + "/tree/" + encodeURIComponent(ref) + (path === "." ? "" : "/" + path);
  const repoName = new URL(repo).pathname.slice(1);
  const refLabel = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
  const capture = CAPTURES[props.app.id];
  const darkCapture = "dark" in capture ? capture.dark : undefined;

  return (
    <article class="featured-app" id={"app-" + props.app.id}>
      <div class="featured-copy">
        <div class="featured-title">
          <div class="featured-icon"><AppIcon id={props.app.id} /></div>
          <h3>{props.app.name}</h3>
        </div>
        <p class="featured-summary">{props.app.summary}{props.app.use}</p>
        <p class="featured-needs">{props.app.prerequisite}</p>
        <a class="featured-action" href={props.app.install} aria-label={props.app.name + "の追加画面を開く"}>
          追加画面を開く <Arrow />
        </a>
        <p class="featured-source">
          <a href={moduleUrl}>公開元<span class="featured-ref">（{repoName}・{refLabel}）</span><Arrow /></a>
          <a href={props.app.site}>{props.app.name} のサイト <Arrow /></a>
        </p>
      </div>
      <figure class="featured-screen">
        <picture>
          {darkCapture && <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset={darkCapture.mobile.src} width={darkCapture.mobile.width} height={darkCapture.mobile.height} />}
          <source media="(max-width: 640px)" srcset={capture.mobile.src} width={capture.mobile.width} height={capture.mobile.height} />
          {darkCapture && <source media="(prefers-color-scheme: dark)" srcset={darkCapture.desktop.src} width={darkCapture.desktop.width} height={darkCapture.desktop.height} />}
          <img src={capture.desktop.src} width={capture.desktop.width} height={capture.desktop.height} alt={APP_SCREEN_ALT[props.app.id]} loading="lazy" />
        </picture>
      </figure>
    </article>
  );
}

export default function Home() {
  return (
    <div class="site-shell">
      <a class="skip-link" href="#main">本文へスキップ</a>
      <header class="site-header site-width">
        <a class="brand" href="/" aria-label="Takosumi ホーム">
          <img src="/tako.png" alt="" width="32" height="32" />
          <span>Takosumi</span>
        </a>
        <nav aria-label="サイトナビゲーション">
          <a class="nav-apps" href="#apps">アプリを選ぶ</a>
          <a href="/docs/">ドキュメント</a>
          <a class="nav-login" href="https://app.takosumi.com/">使ってみる <Arrow /></a>
        </nav>
      </header>

      <main id="main">
        <section class="hero site-width" aria-labelledby="site-title">
          <div class="hero-copy">
            <div class="hero-identity"><img class="hero-mark" src="/tako.png" alt="" width="64" height="64" /><h1 id="site-title">Takosumi</h1></div>
            <p class="hero-lead">公開されたオープンソースを、アプリのように入れて使う。</p>
            <p class="hero-description">アプリを選んで接続と設定を入れ、作られるものを確かめてから追加します。<br class="desktop-break" />画面のあるものは、アプリとしてワークスペースのホームから開けます。</p>
            <div class="hero-actions">
              <a class="button button-primary" href="#apps">アプリを選ぶ <span aria-hidden="true">↓</span></a>
              <a class="button button-secondary" href="https://app.takosumi.com/new">Git URL から追加 <Arrow /></a>
            </div>
          </div>
          <figure class="hero-product">
            <DashboardShot capture={DASHBOARD_CAPTURES.home} alt="Takosumi のホーム画面。ワークスペースに Takos、Takos Office、Yurucommu のアプリと追加操作が並ぶ" class="launcher-shot" priority />
            <figcaption>Takosumi ダッシュボードのホーム（公開用のデモデータで撮影）</figcaption>
          </figure>
        </section>

        <section id="apps" class="apps-section site-width" aria-labelledby="apps-title">
          <div class="section-heading">
            <div>
              <h2 id="apps-title">アプリを選ぶ</h2>
              <p>どれも、公開されている Git リポジトリの OpenTofu 定義から追加します。ほかのソフトウェアも、Git URL を指定して追加できます。</p>
            </div>
            <a class="text-link" href="https://app.takosumi.com/new">自分の Git URL を指定 <Arrow /></a>
          </div>
          <div class="featured-list">
            <For each={FEATURED_APPS}>{app => <FeaturedAppRow app={app} />}</For>
          </div>
          <p class="section-note">アプリの画面は、公開用のデモデータで撮影したものです。</p>
        </section>

        <section class="install-section" aria-labelledby="install-title">
          <div class="site-width install-layout">
            <div class="install-copy">
              <div class="install-intro">
                <h2 id="install-title">追加する前に、作られるものを確かめる</h2>
                <p>アプリを選ぶと、Takosumi は使う commit を固定してから、次の順に進みます。</p>
              </div>
              <ol class="add-steps">
                <li><h3>接続と設定</h3><p>必要な接続を選び、アプリが求める項目を入れます。</p></li>
                <li><h3>追加前の確認</h3><p>作成・変更・削除されるリソースの数を見ます。削除や作り直しを含む変更は、承認するまで進みません。</p></li>
                <li><h3>追加する</h3><p>押したときに初めてデプロイされます。画面のあるものは、アプリとしてホームから開けるようになります。</p></li>
              </ol>
            </div>
            <figure class="install-product">
              <DashboardShot capture={DASHBOARD_CAPTURES.review} alt="Takos を追加する前の確認画面。構成 deploy/opentofu/cloudflare、このモジュールのプロバイダー、必要な接続 Cloudflare の下に、作成 13、変更 0、削除 0 と「追加する」ボタンが並ぶ" class="install-shot" />
              <figcaption>Takos を追加する前の確認画面（Takosumi ダッシュボードを公開用デモデータで撮影。件数は Takos v0.12.7 の Cloudflare 構成から算出）</figcaption>
            </figure>
          </div>
        </section>

        <section class="after-section site-width" aria-labelledby="after-title">
          <div class="after-intro">
            <h2 id="after-title">入れたあとの更新と記録</h2>
            <p>ホームからアプリを開き、設定や更新が必要になったら同じワークスペースへ戻ります。</p>
          </div>
          <div class="after-steps">
            <div><h3>危ない更新は止まる</h3><p>新しい版への更新でも自動更新でも、作り直しや削除を含む変更は、確認するまでデプロイされません。</p></div>
            <div><h3>何が起きたかを残す</h3><p>どの commit を誰がデプロイし、何が変わったかを履歴に残します。前の版に戻すときも、戻す変更を確認してからデプロイします。</p></div>
            <div><h3>鍵は読み出せない形で</h3><p>接続の API token は書き込み専用で保存され、変更の確認やデプロイを実行している間だけ、その処理に渡されます。</p></div>
          </div>
          <figure class="after-product">
            <DashboardShot capture={DASHBOARD_CAPTURES.updates} alt="Takos の「更新」タブ。追跡するバージョン v0.12.7 と「変更を確認」ボタンの下の更新履歴に、現在の版、第2版、第1版が日時つきで並び、第2版には「この状態に戻す」ボタンがある" class="updates-shot" />
            <figcaption>ワークロードの画面にある、Takos の「更新」タブ。デプロイした版が並び、前の版にはそこへ戻す操作がある（Takosumi ダッシュボードを公開用デモデータで撮影）</figcaption>
          </figure>
        </section>

        <section class="closing-section" aria-labelledby="closing-title">
          <div class="site-width closing-content">
            <div>
              <h2 id="closing-title">一つ追加してみる</h2>
              <p>公式ホスティングは正式提供前（Pre-GA）です。sudo が使える Linux マシンに Docker と Bun を入れれば、クラウドの認証情報なしで手元でも試せます。</p>
            </div>
            <div class="closing-actions">
              <a class="button button-primary" href="https://app.takosumi.com/">公式ホスティングで使う <Arrow /></a>
              <a class="text-link" href="/docs/getting-started/quickstart.html">手元で試す（クイックスタート） <Arrow /></a>
              <a class="text-link" href="/docs/concepts/self-host.html">セルフホストについて <Arrow /></a>
            </div>
          </div>
        </section>
      </main>

      <AdringWidget />
      <footer class="site-footer site-width">
        <div><span>Takosumi</span><small>© Takosumi contributors</small></div>
        <nav aria-label="フッター">
          <a href="/docs/">ドキュメント</a>
          <a href="/docs/en/" hreflang="en" lang="en">English docs</a>
          <a href="https://app.takosumi.com/docs/pricing">料金</a>
          <a href="https://github.com/tako0614/takosumi">GitHub <Arrow /></a>
        </nav>
      </footer>
    </div>
  );
}
