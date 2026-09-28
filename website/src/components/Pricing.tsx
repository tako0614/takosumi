export default function Pricing() {
  return (
    <section class="pricing" id="pricing" aria-labelledby="pricing-title">
      <div class="container pricing-layout">
        <div class="pricing-copy">
          <h2 id="pricing-title">動かす場所も、自分で選ぶ。</h2>
          <p>Takosumi はオープンソース。自分で動かす方法と、Hosted を使う方法があります。アプリの実行先に必要なクラウド料金は、どちらも別に確認してください。</p>
        </div>
        <div class="pricing-options">
          <div class="pricing-option"><h3>セルフホスト</h3><p>Takosumi 自体を自分の環境で運用します。実行環境と接続を自分で管理します。</p><a href="/docs/concepts/self-host">導入方法を見る <span aria-hidden="true">↗</span></a></div>
          <div class="pricing-option"><h3>Hosted</h3><p>Takosumi の管理画面を使います。管理・実行の利用料と、アプリの実行先にかかる費用を確認して進めます。</p><a href="https://app.takosumi.com/docs/pricing">公開料金を見る <span aria-hidden="true">↗</span></a></div>
        </div>
      </div>
    </section>
  );
}
