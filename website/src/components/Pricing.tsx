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
            <div class="record-head">
              <span
                class={plan.id === "platform" ? "rec-dot rec-plan" : "rec-dot rec-self"}
                aria-hidden="true"
              />
              <span class="rec-label">{plan.id}</span>
              <h3 class="rec-plan-name">{plan.name}</h3>
              <span class="rec-meta">{plan.price}</span>
            </div>
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
