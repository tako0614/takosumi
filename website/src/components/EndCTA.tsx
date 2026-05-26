import CodeBlock from "./CodeBlock";

export default function EndCTA() {
  return (
    <section class="end-cta">
      <div class="container">
        <h2>5 分で始める。</h2>
        <p class="lede" style="margin-left: auto; margin-right: auto;">
          Space を作って、必要なものを入れて、deploy。cloud、VM、cluster
          のどれでも、同じ入口で。
        </p>
        <CodeBlock terminal class="terminal">
          <span class="k">$</span>{" "}
          deno install -gA -n takosumi jsr:@takos/takosumi-cli{"\n"}
          <span class="k">$</span> takosumi space create my-home{"\n"}
          <span class="k">$</span> takosumi deploy my-home
        </CodeBlock>
        <div class="cta-row" style="justify-content: center;">
          <a
            class="btn btn-primary"
            href="https://cloud.takosumi.com/"
            rel="noopener"
          >
            Cloud で 試す →
          </a>
          <a
            class="btn btn-secondary"
            href="/docs/getting-started/quickstart"
            rel="external"
          >
            Single-host で動かす
          </a>
          <a class="btn btn-secondary" href="/docs/" rel="external">
            ドキュメント
          </a>
        </div>
      </div>
    </section>
  );
}
