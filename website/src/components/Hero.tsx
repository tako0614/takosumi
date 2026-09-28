export default function Hero() {
  return (
    <section class="hero" aria-labelledby="hero-title">
      <div class="container hero-inner">
        <div class="hero-copy">
          <p class="hero-overline">Takosumi / OSS を自分の場所へ</p>
          <h1 id="hero-title">使いたい OSS を、<br /><em>アプリのように。</em></h1>
        </div>
        <div class="hero-pitch">
          <p class="hero-description">Git で公開された OpenTofu 定義のある OSS を選び、必要な接続と設定を確認して、自分の環境へ。</p>
          <div class="hero-actions">
            <a class="action-primary" href="#apps">アプリを選ぶ <span aria-hidden="true">↘</span></a>
            <a class="action-text" href="https://app.takosumi.com/new">Git URL から追加 <span aria-hidden="true">↗</span></a>
          </div>
        </div>
      </div>
    </section>
  );
}
