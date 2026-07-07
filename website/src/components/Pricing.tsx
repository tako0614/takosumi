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
        表示価格は公開 pricing contract に基づきます。実際の課金開始前に
        checkout とプラン内容を確認できます。
      </p>
    </Section>
  );
}
