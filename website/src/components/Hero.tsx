import { For } from "solid-js";
import { ProductShot } from "./ProductVisuals";

const SPEC = [
  "projects",
  "capsules",
  "plan → apply → destroy",
  "state",
  "audit events",
  "any provider",
];

export default function Hero() {
  return (
    <section class="hero">
      <div class="container hero-grid">
        <div class="hero-copy">
          <p class="hero-kicker">OpenTofu-native · self-hosted · AGPL-3.0</p>
          <h1>
            <span class="hero-line">your cloud,</span>
            <span class="hero-line hero-accent">your control plane.</span>
          </h1>
          <p class="lede">
            アプリやインフラを、ブラウザから自分のクラウドへ。
            <br />
            <em class="em">鍵も、状態も、履歴も</em>、Takosumi が管理します。
          </p>
          <div class="cta-row">
            <a
              class="btn btn-primary"
              href="https://app.takosumi.com/"
              rel="noopener"
            >
              Takosumi を開く
            </a>
            <a
              class="btn btn-secondary"
              href="/docs/getting-started/quickstart"
              rel="external"
            >
              セルフホストで始める
            </a>
          </div>
          <ul class="hero-spec" aria-label="contents">
            <For each={SPEC}>{(s) => <li>{s}</li>}</For>
          </ul>
        </div>
        <div class="hero-visual">
          <ProductShot
            src="/screens/home.webp"
            label="Takosumi ダッシュボードのホーム画面"
            alt="Takosumi ダッシュボードの実画面。自分のワークスペースのサイドバーと、インストール済みの 5 つのアプリ (takos, takos-office, takos-computer, yurucommu, road-to-me) が並ぶホーム。"
          />
        </div>
      </div>
    </section>
  );
}
