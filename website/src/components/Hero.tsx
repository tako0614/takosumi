import SplatField from "./SplatField";

export default function Hero() {
  return (
    <section class="hero hero-simple">
      <SplatField density="hero" />
      <div class="container hero-center">
        <span class="eyebrow">墨 · OpenTofu-native · operator-owned</span>
        <h1>
          your service,<br />
          <span class="grad-text">your server.</span>
        </h1>
        <p class="lede">
          あなたのサービスを、あなたのサーバーで。Git の OpenTofu module を
          Installation に — plan / apply は台帳に残ります。
        </p>
        <div class="cta-row">
          <a
            class="btn btn-primary"
            href="https://accounts.takosumi.com/signup"
            rel="noopener"
          >
            新規登録
          </a>
          <a
            class="btn btn-secondary"
            href="https://accounts.takosumi.com/login"
            rel="noopener"
          >
            ログイン
          </a>
        </div>
      </div>
    </section>
  );
}
