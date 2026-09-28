import Wordmark from "./brand/Wordmark";

export default function Nav() {
  return (
    <header class="site-nav">
      <a class="skip-link" href="#main">本文へスキップ</a>
      <div class="container site-nav-inner">
        <Wordmark />
        <nav class="site-nav-links" aria-label="メイン">
          <a href="#apps">アプリ</a>
          <a href="#how">使い始めるまで</a>
          <a href="#pricing">料金</a>
          <a href="/docs/">ドキュメント</a>
        </nav>
        <a class="site-nav-cta" href="#apps">アプリを選ぶ <span aria-hidden="true">↗</span></a>
      </div>
    </header>
  );
}
