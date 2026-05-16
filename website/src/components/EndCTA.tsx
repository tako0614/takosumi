import CodeBlock from "./CodeBlock";

export default function EndCTA() {
  return (
    <section class="end-cta">
      <div class="container">
        <span class="eyebrow">Get started</span>
        <h2>5 分で動かす。</h2>
        <p class="lede" style="margin-left: auto; margin-right: auto;">
          JSR から install、 manifest 1 本書いて <code>takosumi deploy</code>。
          それだけ。
        </p>
        <CodeBlock terminal class="terminal">
          <span class="k">$</span> deno install -gA -n takosumi jsr:@takos/takosumi-cli{"\n"}
          <span class="k">$</span> takosumi init ./manifest.yml{"\n"}
          <span class="k">$</span> takosumi deploy ./manifest.yml
        </CodeBlock>
        <div class="cta-row" style="justify-content: center;">
          <a class="btn btn-primary" href="/docs/getting-started/quickstart">
            Quickstart →
          </a>
          <a class="btn btn-secondary" href="https://github.com/tako0614/takosumi" rel="noopener">
            GitHub で star
          </a>
        </div>
      </div>
    </section>
  );
}
