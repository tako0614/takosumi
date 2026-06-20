import SplatField from "./SplatField.tsx";

export default function EndCTA() {
  return (
    <section class="end-cta">
      <SplatField density="section" />
      <div class="container">
        <h2>Cloud から始める。</h2>
        <p class="lede" style="margin-left: auto; margin-right: auto;">
          Git URL を入れると、Takosumi が Capsule として確認します。Cloud
          が対応できる provider は運営管理の接続で進み、未対応なら自分の
          provider key を追加します。
        </p>
        <ol class="cta-flow">
          <li>
            <span>1</span>
            <strong>Git URL を確認</strong>
            <p>
              リンクや入力から Source を登録し、OpenTofu Capsule
              として読めるか確認します。
            </p>
          </li>
          <li>
            <span>2</span>
            <strong>接続を自動判定</strong>
            <p>
              Cloud が対応する provider は運営管理の接続を使い、足りない
              provider だけ追加を求めます。
            </p>
          </li>
          <li>
            <span>3</span>
            <strong>Plan を見て deploy</strong>
            <p>
              Run、StateVersion、Outputs、AuditEvent が Takosumi に残ります。
            </p>
          </li>
        </ol>
        <div class="cta-row" style="justify-content: center;">
          <a
            class="btn btn-primary"
            href="https://app.takosumi.com/"
            rel="noopener"
          >
            Dashboard を開く
          </a>
          <a
            class="btn btn-secondary"
            href="/docs/getting-started/quickstart"
            rel="external"
          >
            OSS の手順を見る
          </a>
          <a class="btn btn-secondary" href="/docs/" rel="external">
            ドキュメント
          </a>
        </div>
      </div>
    </section>
  );
}
