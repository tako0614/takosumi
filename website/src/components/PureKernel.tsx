export default function PureKernel() {
  return (
    <section id="pure-kernel">
      <div class="container">
        <span class="eyebrow">Pure kernel</span>
        <h2>「持たない」 を制約ではなく仕様にする。</h2>
        <p class="lede">
          kernel が持たないこと一覧。 これらは <em>削った</em> 機能ではなく、
          移植可能性を成り立たせるために <strong>意図的に持たない</strong>
          責務。 必要なら sibling product に分離する。
        </p>
        <ul class="pure-list">
          <li>
            <strong>workflow</strong>
            <p>git 連携 / CI / build pipeline は <code>takosumi-git</code> 等の helper product に分離。 kernel は manifest を受け取るだけ。</p>
          </li>
          <li>
            <strong>identity</strong>
            <p>OIDC issuer / passkey / pairwise subject は <code>Takosumi Accounts</code> (cloud.takosumi.com) に分離。 kernel は credential を保持しない。</p>
          </li>
          <li>
            <strong>billing</strong>
            <p>使用量計測 / 課金 / Stripe webhook は Accounts 側。 kernel は無料で self-host できる。</p>
          </li>
          <li>
            <strong>project convention</strong>
            <p>.takosumi/ ディレクトリ規約 / workflow file の場所 — 全て operator distribution 側で決める。</p>
          </li>
          <li>
            <strong>publisher signing</strong>
            <p>publisher signing / package key enrollment は持たない。 operator-pinned sha256 digest で fail-closed に verify。</p>
          </li>
          <li>
            <strong>opinionated runtime</strong>
            <p>Deno / Node / Workers / Bun の差分は <code>RuntimeAdapter</code> で吸収。 「これで動かす前提」 を kernel core に持たない。</p>
          </li>
        </ul>
        <p class="lede" style="margin-top: 32px;">
          詳しくは <a href="/docs/reference/architecture/">architecture overview</a>。
        </p>
      </div>
    </section>
  );
}
