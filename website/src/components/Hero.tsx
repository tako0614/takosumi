import CodeBlock from "./CodeBlock";

export default function Hero() {
  return (
    <section class="hero">
      <div class="container">
        <span class="eyebrow">v0.17 · open source</span>
        <h1>
          <span class="grad-text">どこの cloud にも</span>
          <br />
          同じ 1 行で deploy。
        </h1>
        <p class="lede">
          AWS、 Cloudflare、 Kubernetes、 docker、 自前 VM ——
          全部に <code>takosumi deploy</code> 1 コマンドで届く。
          引っ越しは manifest を 1 行変えるだけ。
        </p>
        <div class="cta-row">
          <a class="btn btn-primary" href="/docs/getting-started/quickstart">
            5 分で動かす →
          </a>
          <a class="btn btn-secondary" href="https://github.com/tako0614/takosumi" rel="noopener">
            GitHub
          </a>
        </div>
        <CodeBlock terminal>
          <span class="k">$</span> deno install -gA -n takosumi jsr:@takos/takosumi-cli{"\n"}
          <span class="k">$</span> takosumi deploy ./manifest.yml{"\n"}
          <span class="c">  ✓ deployed · http://localhost:18080</span>
        </CodeBlock>
      </div>
    </section>
  );
}
