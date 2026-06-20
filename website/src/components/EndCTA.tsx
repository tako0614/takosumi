import CodeBlock from "./CodeBlock.tsx";
import SplatField from "./SplatField.tsx";

export default function EndCTA() {
  return (
    <section class="end-cta">
      <SplatField density="section" />
      <div class="container">
        <h2>5 分で始める。</h2>
        <p class="lede" style="margin-left: auto; margin-right: auto;">
          Git URL を登録して、ProviderConnection を選んで、reviewed plan を apply。
          OSS は既存 provider をそのまま動かし、Cloud だけが compatibility gateway と
          managed resources を追加します。
        </p>
        <CodeBlock terminal class="terminal">
          <span class="k">$</span> open
          https://app.takosumi.com/install?git=https://git.example.com/acme/api.git
          {"\n"}
          <span class="c">
            {"  "}→ 取得元が入力済みで開く（追加は確認してから）
          </span>
          {"\n"}
          <span class="k">$</span> choose ProviderConnection → cloudflare-prod
          {"\n"}
          <span class="k">$</span> review plan → apply{"\n"}
          <span class="c">
            {"  "}→ approve は destructive / destroy などの gated run だけ
          </span>
          {"\n"}
          <span class="c">{"  "}→ StateVersion · Outputs · AuditEvent recorded</span>
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
            Dashboard を開く
          </a>
          <a class="btn btn-secondary" href="/docs/" rel="external">
            ドキュメント
          </a>
        </div>
      </div>
    </section>
  );
}
