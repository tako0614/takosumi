import { For } from "solid-js";
import { PRICING_PLANS } from "~/content/pricing";
import Section from "./Section";

export default function Pricing() {
  return (
    <Section
      id="pricing"
      title="料金"
      lede={
        <>
          セルフホストは無料のオープンソース。Takosumi
          は公式ホスティング版で、ブラウザからサービスを追加・更新できる。
        </>
      }
    >
      <For each={PRICING_PLANS}>
        {(plan) => (
          <div class="install-item">
            <h3>
              {plan.name}
              <span class="plan-price-inline">{plan.price}</span>
            </h3>
            <p>{plan.priceNote}</p>
            <ul class="fact-list">
              <For each={plan.features}>{(f) => <li>{f.label}</li>}</For>
            </ul>
            <a class="link" href={plan.cta.href} rel="external">
              {plan.cta.label}
            </a>
          </div>
        )}
      </For>

      <p class="plan-footnote">
        従量単価は公開料金表に基づく。操作前の Preview
        で見積もりを確認でき、クレジット追加や自動チャージの設定は自分で管理できる。
      </p>
    </Section>
  );
}
