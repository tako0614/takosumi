import Wordmark from "./brand/Wordmark";

export default function Footer() {
  return (
    <footer class="site-footer">
      <div class="container footer-inner">
        <div><Wordmark size={24} /><p>使いたい OSS を、自分の場所へ。</p></div>
        <nav aria-label="フッター">
          <a href="#apps">アプリを選ぶ</a>
          <a href="https://app.takosumi.com/new">Git URL から追加</a>
          <a href="/docs/">ドキュメント</a>
          <a href="https://github.com/tako0614/takosumi">GitHub</a>
        </nav>
        <small>© Takosumi contributors · AGPL-3.0</small>
      </div>
    </footer>
  );
}
