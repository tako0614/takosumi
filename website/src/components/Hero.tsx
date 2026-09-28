import CurlRule from "./CurlRule";

/** Page head: the mark's face tile + product name, one factual paragraph,
 *  a plain fact line, the primary links — then the real dashboard bleeding
 *  off the right viewport edge. */
export default function Hero() {
  return (
    <section class="page-head">
      <div class="container">
        <div class="head-brand">
          <img
            class="head-mark"
            src="/tako.png"
            alt=""
            width="660"
            height="660"
            decoding="async"
          />
          <h1 class="page-title">Takosumi</h1>
        </div>
        <p class="page-desc">
          Git-based OpenTofu control
          plane。アプリやインフラを、ブラウザから自分のクラウドへ公開・管理する。接続・状態・履歴・監査をひとつの場所で扱う。
        </p>
        <p class="page-facts">
          AGPL-3.0 · github.com/tako0614/takosumi · OpenTofu · Cloudflare / AWS
          / GCP / VM
        </p>
        <div class="page-actions">
          <a class="btn" href="https://app.takosumi.com/" rel="noopener">
            Takosumi を開く
          </a>
          <a href="/docs/getting-started/quickstart" rel="external">
            セルフホストで始める
          </a>
          <a href="https://github.com/tako0614/takosumi" rel="noopener">
            GitHub
          </a>
        </div>
      </div>
      <CurlRule />
    </section>
  );
}
