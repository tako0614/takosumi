export default function EndCTA() {
  return (
    <section class="end-cta">
      <div class="container">
        <h2>始めよう。</h2>
        <p class="lede" style="margin-left: auto; margin-right: auto;">
          Cloud ならブラウザから。セルフホストなら自分のインフラに。
        </p>
        <div class="cta-row" style="justify-content: center;">
          <a
            class="btn btn-primary"
            href="https://app.takosumi.com/"
            rel="noopener"
          >
            Takosumi Cloud を開く
          </a>
          <a
            class="btn btn-secondary"
            href="/docs/getting-started/quickstart"
            rel="external"
          >
            セルフホストする
          </a>
          <a class="btn btn-secondary" href="/docs/" rel="external">
            ドキュメント
          </a>
        </div>
      </div>
    </section>
  );
}
