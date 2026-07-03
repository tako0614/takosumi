import { For } from "solid-js";
import { PRICING_PLANS } from "~/content/pricing";
import Section from "./Section";

export default function Pricing() {
  return (
    <Section
      id="pricing"
      title="自分で持つか、公式ホスティングか。"
      lede={
        <>
          セルフホストは<em class="em">無料</em>
          のオープンソース。自分のインフラに置いて、自分で所有します。Takosumi
          Cloud
          は公式ホスティング版で、ブラウザからサービスを追加・更新できます。
        </>
      }
    >
      <div class="plan-grid">
        <For each={PRICING_PLANS}>
          {(plan) => (
            <article class="plan" classList={{ featured: plan.highlight }}>
              <div class="plan-head">
                <h3>{plan.name}</h3>
                <p class="plan-tagline">{plan.tagline}</p>
              </div>
              <div class="plan-price">
                <span class="plan-price-value">{plan.price}</span>
                <span class="plan-price-note">{plan.priceNote}</span>
              </div>
              <ul class="plan-features">
                <For each={plan.features}>{(f) => <li>{f.label}</li>}</For>
              </ul>
              <a
                class="btn"
                classList={{
                  "btn-primary": plan.highlight,
                  "btn-secondary": !plan.highlight,
                }}
                href={plan.cta.href}
                rel="external"
              >
                {plan.cta.label} →
              </a>
            </article>
          )}
        </For>
      </div>

      <p class="plan-footnote">
        表示価格は Takosumi Cloud Starter の plan spec
        に基づきます。実際の課金開始前に checkout
        と利用量を確認できます。カード明細には原則として
        <strong>TAKOSUMI</strong> と表示されます。
      </p>

      <div class="billing-policy-note" aria-label="Billing policies">
        <div>
          <h3>課金の扱い</h3>
          <p>
            Takosumi Cloud はデジタルサービスです。購入後、アカウントに plan と
            USD-denominated credit が反映され、Cloud resource usage に応じて
            credit が差し引かれます。残高が不足すると、追加の有料リソース実行は
            事前に止まります。
          </p>
        </div>
        <nav aria-label="Billing policy links">
          <a href="/docs/legal/refund-policy">返金ポリシー</a>
          <a href="/docs/legal/cancellation-policy">キャンセル</a>
          <a href="/docs/legal/terms-of-service">利用規約</a>
          <a href="/docs/legal/privacy-policy">プライバシー</a>
          <a href="/docs/support">サポート</a>
        </nav>
      </div>
    </Section>
  );
}
