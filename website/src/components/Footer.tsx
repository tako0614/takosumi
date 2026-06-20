import Wordmark from "./brand/Wordmark";

export default function Footer() {
  return (
    <footer class="site">
      <div class="container">
        <div style="display: flex; align-items: center; gap: 12px;">
          <Wordmark variant="geometric" size={20} />
          <span class="copy">© Takosumi contributors — AGPL-3.0</span>
        </div>
        <nav aria-label="Footer">
          <a href="/docs/" rel="external">
            ドキュメント
          </a>
          <a href="https://github.com/tako0614/takosumi" rel="noopener">
            GitHub
          </a>
          <a href="https://app.takosumi.com/" rel="noopener">
            ダッシュボード
          </a>
        </nav>
      </div>
    </footer>
  );
}
