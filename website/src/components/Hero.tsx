import CodeBlock from "./CodeBlock";
import InkSplash from "./brand/InkSplash";

export default function Hero() {
  return (
    <section class="hero">
      <InkSplash class="hero-splash" variant={1} />
      <div class="container hero-grid">
        <div class="hero-copy">
          <span class="eyebrow">
            墨 · open source · operator-owned · for everyone
          </span>
          <h1>
            <span class="hero-line">全部、 ひとつの入口で。</span>
            <span class="hero-line grad-text">全部、 選んだ実行先に。</span>
            <span class="hero-line">誰でも、 含めて。</span>
          </h1>
          <p class="lede">
            chat も、 docs も、 agent も、 SNS も、 自分の DB も —— 1 つの{" "}
            Takosumi の上で。cloud でも、VM でも、cluster でも、同じ Space
            が動きます。
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
            <span class="k">$</span> takosumi space create my-home{"\n"}
            <span class="c">{" ".repeat(2)}✓ chat (takos)</span>
            {"\n"}
            <span class="c">{" ".repeat(2)}✓ docs (takos-docs)</span>
            {"\n"}
            <span class="c">{" ".repeat(2)}✓ agent (takos-agent)</span>
            {"\n"}
            <span class="c">{" ".repeat(2)}✓ files (object-store)</span>
            {"\n"}
            <span class="c">
              {" ".repeat(2)}↳ on Cloudflare / AWS / docker / k8s
            </span>
            {"\n"}
            <span class="c">
              {" ".repeat(4)}— same Space, operator-owned runtime.
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
