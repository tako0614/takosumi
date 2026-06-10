import { For } from "solid-js";
import { PRICING_PLANS, OWNERSHIP_ROWS } from "~/content/pricing";
import SplatField from "./SplatField";

export default function Pricing() {
  return (
    <section id="pricing">
      <SplatField density="section" />
      <div class="container">
        <span class="eyebrow">pricing & ownership</span>
        <h2>自分で持つか、まかせるか。</h2>
        <p class="lede">
          self-host は無料の open source。自分のインフラに置いて、自分で所有します。
          おまかせ (managed) はクレジット制 —— host も運用も Takosumi 側が持ちます。
        </p>

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
                  <For each={plan.features}>
                    {(f) => <li>{f.label}</li>}
                  </For>
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

        <div class="comparison plan-ownership">
          <table>
            <caption class="sr-only">
              self-host と managed の所有 / 運用の違い
            </caption>
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col">自分で動かす</th>
                <th scope="col">おまかせ (managed)</th>
              </tr>
            </thead>
            <tbody>
              <For each={OWNERSHIP_ROWS}>
                {(r) => (
                  <tr>
                    <th scope="row">
                      <strong>{r.axis}</strong>
                    </th>
                    <td class="us">{r.selfHost}</td>
                    <td>{r.managed}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>

        <p class="plan-footnote">
          managed の具体的な料金とクレジットの単価は、ローンチ時にこのページで案内します。
        </p>
      </div>
    </section>
  );
}
