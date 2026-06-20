import SplatField from "./SplatField";
import { useParallax } from "~/lib/interactions";

export default function Hero() {
  let splatRef: HTMLDivElement | undefined;
  useParallax(() => splatRef, 0.16);

  return (
    <section class="hero hero-simple">
      <div ref={splatRef} class="hero-splat-wrap" aria-hidden="true">
        <SplatField density="hero" />
      </div>
      <div class="container hero-center">
        <h1>
          <span class="hero-line">your service,</span>
          <span class="hero-line grad-text">your server.</span>
        </h1>
        <p class="lede">
          Git のインフラコードを、好きなクラウドに。
          <br />
          <em class="em">鍵も、状態も、履歴も</em>、ぜんぶ自分の手元に。
        </p>
        <div class="cta-row">
          <a
            class="btn btn-primary"
            href="/docs/getting-started/quickstart"
            rel="external"
          >
            セルフホストで始める
          </a>
          <a class="btn btn-secondary" href="#pricing">
            Cloud の案内を見る
          </a>
        </div>
      </div>
      <a class="hero-scroll" href="#why" aria-label="下へスクロール">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </a>
    </section>
  );
}
