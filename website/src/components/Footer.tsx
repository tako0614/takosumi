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
          <a href="/#pricing">料金</a>
          <a href="/docs/support">サポート</a>
          <a href="/docs/legal/terms-of-service">利用規約</a>
          <a href="/docs/legal/privacy-policy">プライバシー</a>
          <a href="/docs/legal/refund-policy">返金</a>
          <a href="/docs/legal/cancellation-policy">キャンセル</a>
          <a href="https://github.com/tako0614/takosumi" rel="noopener">
            GitHub
          </a>
          <a href="https://app.takosumi.com/" rel="noopener">
            Takosumi Cloud
          </a>
        </nav>
      </div>
    </footer>
  );
}
