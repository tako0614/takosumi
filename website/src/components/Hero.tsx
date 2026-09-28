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
          <h1>OpenTofu-native deploy control plane.</h1>
          <p class="lede">
            アプリやインフラを、ブラウザから自分のクラウドへ。
            <br />
            <em class="em">鍵も、状態も、履歴も</em>、Takosumi が管理します。
          </p>
          <p class="intro-links">
            <a class="link-go" href="https://app.takosumi.com/" rel="noopener">
              Takosumi を開く →
            </a>
            <a
              class="link-go"
              href="/docs/getting-started/quickstart"
              rel="external"
            >
              セルフホストで始める →
            </a>
            <a
              class="link-go"
              href="https://github.com/tako0614/takosumi"
              rel="noopener"
            >
              GitHub →
            </a>
          </p>
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
