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

function FeaturedAppRow(props: { app: FeaturedApp }) {
  const source = new URL(props.app.install).searchParams;
  const repo = source.get("git")!.replace(/\.git$/, "");
  const path = source.get("path")!;
  const ref = source.get("ref")!;
  const moduleUrl = repo + "/tree/" + encodeURIComponent(ref) + (path === "." ? "" : "/" + path);
  const capture = CAPTURES[props.app.id];
  const darkCapture = "dark" in capture ? capture.dark : undefined;

  return (
    <article class="featured-app" id={"app-" + props.app.id}>
      <div class="featured-app-main">
        <div class="featured-icon"><AppIcon id={props.app.id} /></div>
        <div class="featured-copy">
          <h3>{props.app.name}</h3>
          <p>{props.app.summary} {props.app.use}</p>
        </div>
        <a class="featured-action" href={props.app.install} aria-label={props.app.name + "のインストール設定へ進む"}>
          インストール設定へ <Arrow />
        </a>
      </div>
      <details class="featured-details">
        <summary>接続と公開元を確認</summary>
        <div class="featured-details-body">
          <p>{props.app.prerequisite}</p>
          <div class="featured-links">
            <a href={moduleUrl}>Git の OpenTofu 定義 <Arrow /></a>
            <a href={props.app.site}>{props.app.name} のサイト <Arrow /></a>
          </div>
          <figure>
            <picture>
              {darkCapture && <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset={darkCapture.mobile.src} width={darkCapture.mobile.width} height={darkCapture.mobile.height} />}
              <source media="(max-width: 640px)" srcset={capture.mobile.src} width={capture.mobile.width} height={capture.mobile.height} />
              {darkCapture && <source media="(prefers-color-scheme: dark)" srcset={darkCapture.desktop.src} width={darkCapture.desktop.width} height={darkCapture.desktop.height} />}
              <img src={capture.desktop.src} width={capture.desktop.width} height={capture.desktop.height} alt={props.app.name + "の公開用デモ画面"} loading="lazy" />
            </picture>
            <figcaption>公開用のデモデータを使ったアプリ画面です。</figcaption>
          </figure>
        </div>
      </details>
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
          <a href="#apps">アプリを探す</a>
          <a href="/docs/">ドキュメント</a>
          <a class="nav-login" href="https://app.takosumi.com/">使ってみる <Arrow /></a>
        </nav>
      </header>

      <main id="main">
        <section class="hero site-width" aria-labelledby="site-title">
          <div class="hero-copy">
            <h1 id="site-title">Takosumi</h1>
            <p class="hero-lead">公開されたアプリを、<br />自分の環境へ。</p>
            <p class="hero-description">Git の OpenTofu 定義を読み込み、接続先と設定を確認してインストール。入れたアプリも、変更も、ひとつのワークスペースから見渡せます。</p>
            <div class="hero-actions">
              <a class="button button-primary" href="#apps">アプリを見つける <Arrow /></a>
              <a class="text-link" href="https://app.takosumi.com/new">Git URL から追加 <Arrow /></a>
            </div>
          </div>
          <figure class="hero-product">
            <DashboardShot capture={DASHBOARD_CAPTURES.home} alt="Takosumi のダッシュボード。ワークスペース内のインストール済みアプリと追加操作が並ぶ" class="launcher-shot" priority />
            <figcaption><span class="caption-dot" aria-hidden="true" /> Takosumi のダッシュボード（デモ画面）</figcaption>
          </figure>
        </section>

        <section id="apps" class="apps-section site-width" aria-labelledby="apps-title">
          <div class="section-heading">
            <div>
              <h2 id="apps-title">使うものを選ぶ。</h2>
              <p>それぞれの公開 Git リポジトリにある OpenTofu 定義から始められます。好きなソースを自分で指定することもできます。</p>
            </div>
            <a class="text-link" href="https://app.takosumi.com/new">自分の Git URL を指定 <Arrow /></a>
          </div>
          <div class="featured-list">
            <For each={FEATURED_APPS}>{app => <FeaturedAppRow app={app} />}</For>
          </div>
          <p class="section-note">ここで紹介するアプリは公開ソースへの入口です。利用には、アプリごとに必要な接続先と設定があります。</p>
        </section>

        <section class="install-section" aria-labelledby="install-title">
          <div class="site-width install-layout">
            <div class="install-copy">
              <p class="section-index">追加する</p>
              <h2 id="install-title">選んで、<br />自分の環境へ。</h2>
              <p>ストアでサービスを探すか、公開 Git リポジトリを指定して追加します。アプリごとに必要な接続先や設定は、追加後の画面で確認します。</p>
              <a class="text-link" href="/docs/concepts/sources.html">ソースとインストールの仕組み <Arrow /></a>
            </div>
            <figure class="install-product">
              <DashboardShot capture={DASHBOARD_CAPTURES.install} alt="Takosumi のストアでサービスを探し、公開 Git ソースを選ぶ画面" class="install-shot" />
              <figcaption>Takosumi のストアでソースを選ぶ画面</figcaption>
            </figure>
          </div>
        </section>

        <section class="after-section site-width" aria-labelledby="after-title">
          <div class="after-intro">
            <p class="section-index">使い続ける</p>
            <h2 id="after-title">入れたあとも、<br />ここから。</h2>
            <p>ホームからアプリを開き、設定や変更が必要になったら同じワークスペースへ戻れます。新しい Git の版を取り込むときも、確認した変更をもとに進めます。</p>
          </div>
          <div class="after-steps">
            <div><h3>変更を見る</h3><p>OpenTofu の plan で作成・変更・削除を確認し、承認してから適用します。</p></div>
            <div><h3>実行をたどる</h3><p>インストールや更新の実行履歴と結果を残し、あとから何が起きたか確認できます。</p></div>
            <div><h3>アプリを管理する</h3><p>インストール済みのアプリ、接続先、設定をワークスペースで整理できます。</p></div>
          </div>
        </section>

        <section class="closing-section" aria-labelledby="closing-title">
          <div class="site-width closing-content">
            <div>
              <h2 id="closing-title">自分のアプリを、<br />自分で選ぶ。</h2>
              <p>Takosumi は Git と OpenTofu で定義されたものを、自分の環境で使い続けるための場所です。</p>
            </div>
            <div class="closing-actions">
              <a class="button button-primary" href="https://app.takosumi.com/">Takosumi を使う <Arrow /></a>
              <a class="text-link" href="/docs/concepts/self-host.html">セルフホストについて <Arrow /></a>
            </div>
          </div>
        </section>
      </main>

      <AdringWidget />
      <footer class="site-footer site-width">
        <div><span>Takosumi</span><small>© contributors</small></div>
        <nav aria-label="フッター">
          <a href="/docs/">ドキュメント</a>
          <a href="https://app.takosumi.com/docs/pricing">料金</a>
          <a href="https://github.com/tako0614/takosumi">GitHub <Arrow /></a>
        </nav>
      </footer>
    </div>
  );
}
