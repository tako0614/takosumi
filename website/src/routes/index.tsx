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
        <a class="featured-action" href={props.app.install} aria-label={props.app.name + "の追加画面を開く"}>
          追加画面を開く <Arrow />
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
          <a class="nav-apps" href="#apps">アプリを探す</a>
          <a href="/docs/">ドキュメント</a>
          <a class="nav-login" href="https://app.takosumi.com/">使ってみる <Arrow /></a>
        </nav>
      </header>

      <main id="main">
        <section class="hero site-width" aria-labelledby="site-title">
          <div class="hero-copy">
            <div class="hero-identity"><img class="hero-mark" src="/tako.png" alt="" width="64" height="64" /><h1 id="site-title">Takosumi</h1></div>
            <p class="hero-lead">公開されたオープンソースを、アプリのように入れて使う。</p>
            <p class="hero-description">アプリを選んで接続と設定を入れ、作られるものを確かめてから追加します。<br class="desktop-break" />画面のあるアプリは、ワークスペースのホームから開けます。</p>
            <div class="hero-actions">
              <a class="button button-primary" href="#apps">アプリを探す <span aria-hidden="true">↓</span></a>
              <a class="button button-secondary" href="https://app.takosumi.com/new">Git URL から追加 <Arrow /></a>
            </div>
          </div>
          <figure class="hero-product">
            <DashboardShot capture={DASHBOARD_CAPTURES.home} alt="Takosumi のホーム画面。ワークスペースに Takos、Takos Office、Yurucommu のアプリと追加操作が並ぶ" class="launcher-shot" priority />
            <figcaption><span class="caption-dot" aria-hidden="true" /> Takosumi ダッシュボードの公開用サンプル画面</figcaption>
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
              <div class="install-intro">
                <h2 id="install-title">追加する前に、<br />作られるものを確かめる。</h2>
                <p>アプリを選ぶと、Takosumi は使う commit を固定してから、次の順に進みます。</p>
              </div>
              <ol class="add-steps">
                <li><h3>接続と設定</h3><p>必要な接続を選び、アプリが求める項目を入れます。</p></li>
                <li><h3>追加前の確認</h3><p>作成・変更・削除されるリソースの数を見ます。削除や作り直しを含む変更は、承認するまで進みません。</p></li>
                <li><h3>追加する</h3><p>押したときに初めて反映されます。画面のあるアプリは、ホームから開けるようになります。</p></li>
              </ol>
            </div>
            <figure class="install-product">
              <DashboardShot capture={DASHBOARD_CAPTURES.install} alt="Takosumi のストア。Takos、Takos Office、Yurucommu にそれぞれ追加ボタンがあり、Git リポジトリからも追加できる" class="install-shot" />
              <figcaption>ストアでアプリを選ぶ画面（Takosumi ダッシュボードを公開用デモデータで撮影）</figcaption>
            </figure>
          </div>
        </section>

        <section class="after-section site-width" aria-labelledby="after-title">
          <div class="after-intro">
            <h2 id="after-title">入れたあとの、<br />更新と記録。</h2>
            <p>ホームからアプリを開き、設定や更新が必要になったら同じワークスペースへ戻ります。</p>
          </div>
          <div class="after-steps">
            <div><h3>危ない更新は止まる</h3><p>新しい版への更新でも自動更新でも、作り直しや削除を含む変更は、確認するまで反映されません。</p></div>
            <div><h3>何が起きたかを残す</h3><p>どの commit を誰が反映し、何が変わったかを履歴に残します。</p></div>
            <div><h3>鍵は読み出せない形で</h3><p>接続の API token は書き込み専用で保存され、反映を実行している間の処理にだけ渡されます。</p></div>
          </div>
        </section>

        <section class="closing-section" aria-labelledby="closing-title">
          <div class="site-width closing-content">
            <div>
              <h2 id="closing-title">まず、一つ追加してみる。</h2>
              <p>公式ホスティングは Pre-GA です。Linux マシンと Docker などを用意すれば、クラウドの認証情報なしで手元でも試せます。</p>
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
        <div><span>Takosumi</span><small>© contributors</small></div>
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
