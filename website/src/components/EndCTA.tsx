import CodeBlock from "./CodeBlock";
import SplatField from "./SplatField";

export default function EndCTA() {
  return (
    <section class="end-cta">
      <SplatField density="section" />
      <div class="container">
        <h2>5 分で始める。</h2>
        <p class="lede" style="margin-left: auto; margin-right: auto;">
          module を install して、reviewed plan を apply。cloud、VM、cluster
          のどれでも、同じ台帳で。
        </p>
        <CodeBlock terminal class="terminal">
          <span class="k">$</span> npm install -g @takosjp/takosumi{"\n"}
          <span class="k">$</span> takosumi install git:github.com/acme/api \
          {"\n"}
          {"      "}--space prod{"\n"}
          <span class="c">
            {"  "}→ Deployment live · operator-owned runtime
          </span>
        </CodeBlock>
        <div class="cta-row" style="justify-content: center;">
          <a
            class="btn btn-primary"
            href="/docs/getting-started/quickstart"
            rel="external"
          >
            5 分で動かす →
          </a>
          <a
            class="btn btn-secondary"
            href="https://app.takosumi.com/"
            rel="noopener"
          >
            App を開く
          </a>
          <a class="btn btn-secondary" href="/docs/" rel="external">
            ドキュメント
          </a>
        </div>
      </div>
    </section>
  );
}
