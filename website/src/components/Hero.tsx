import CodeBlock from "./CodeBlock";
import InkSplash from "./brand/InkSplash";

export default function Hero() {
  return (
    <section class="hero">
      <InkSplash class="hero-splash" variant={1} />
      <div class="container hero-grid">
        <div class="hero-copy">
          <span class="eyebrow">墨 · open source · v0.17</span>
          <h1>
            <span class="hero-line">どこの cloud にも</span>
            <span class="hero-line grad-text">同じ 1 行で</span>
            <span class="hero-line">deploy。</span>
          </h1>
          <p class="lede">
            AWS、 Cloudflare、 Kubernetes、 docker、 自前 VM —— 全部に{" "}
            <code>takosumi deploy</code>{" "}
            1 コマンドで届く。 引っ越しは manifest を 1 行変えるだけ。
          </p>
          <div class="cta-row">
            <a
              class="btn btn-primary"
              href="/docs/getting-started/quickstart"
              rel="external"
            >
              5 分で動かす →
            </a>
            <a
              class="btn btn-secondary"
              href="https://github.com/tako0614/takosumi"
              rel="noopener"
            >
              GitHub
            </a>
          </div>
        </div>
        <div class="hero-terminal">
          <CodeBlock terminal>
            <span class="k">$</span> deno install -gA -n takosumi \{"\n"}
            {" ".repeat(2)}jsr:@takos/takosumi-cli{"\n"}
            <span class="k">$</span> takosumi deploy ./manifest.yml{"\n"}
            <span class="c">{" ".repeat(2)}✓ web → http://localhost:18080</span>
            {"\n"}
            <span class="c">
              {" ".repeat(2)}↳ swap "provider:" line to ship
            </span>
            {"\n"}
            <span class="c">
              {" ".repeat(4)}the same thing on Fargate / k3s.
            </span>
          </CodeBlock>
        </div>
      </div>
      <div class="hero-scroll" aria-hidden="true">
        scroll
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
    </section>
  );
}
