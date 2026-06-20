import SplatField from "./SplatField.tsx";

export default function Hero() {
  return (
    <section class="hero hero-simple">
      <SplatField density="hero" />
      <div class="container hero-center">
        <span class="eyebrow">墨 · OpenTofu-native · self-host / cloud</span>
        <h1>
          your service,
          <br />
          <span class="grad-text">your server.</span>
        </h1>
        <p class="lede">
          Takosumi は既存の Terraform / OpenTofu provider をそのまま動かす
          control plane。Git の module を Capsule として登録し、credential、
          state、outputs、run 履歴をまとめて管理します。
        </p>
        <div class="cta-row">
          <a
            class="btn btn-primary"
            href="/docs/getting-started/quickstart"
            rel="external"
          >
            5 分で動かす
          </a>
          <a
            class="btn btn-secondary"
            href="https://app.takosumi.com/sign-in"
            rel="noopener"
          >
            ダッシュボード
          </a>
        </div>
      </div>
    </section>
  );
}
