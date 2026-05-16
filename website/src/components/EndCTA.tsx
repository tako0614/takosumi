import CodeBlock from "./CodeBlock";

export default function EndCTA() {
  return (
    <section class="end-cta">
      <div class="container">
        <h2>5 分で始める。</h2>
        <p class="lede" style="margin-left: auto; margin-right: auto;">
          install して、 manifest を書いて、 deploy。 それだけ。
        </p>
        <CodeBlock terminal class="terminal">
          <span class="k">$</span> deno install -gA -n takosumi jsr:@takos/takosumi-cli{"\n"}
          <span class="k">$</span> takosumi init ./manifest.yml{"\n"}
          <span class="k">$</span> takosumi deploy ./manifest.yml
        </CodeBlock>
        <div class="cta-row" style="justify-content: center;">
          <a class="btn btn-primary" href="/docs/getting-started/quickstart" rel="external">
            Quickstart →
          </a>
          <a class="btn btn-secondary" href="/docs/" rel="external">ドキュメント</a>
        </div>
      </div>
    </section>
  );
}
