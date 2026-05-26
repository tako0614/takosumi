import { For } from "solid-js";
import { ACCOUNTS, APPS, PROVIDERS, SUBSTRATE } from "~/content/ecosystem";

export default function EcosystemMap() {
  return (
    <section id="ecosystem">
      <div class="container">
        <span class="eyebrow">ecosystem map</span>
        <h2>ひとつの土台、 たくさんの形。</h2>
        <p class="lede">
          同じ Takosumi の上で、chat も docs も agent も動く。下は cloud、
          VM、cluster、管理サービスのどれでも、同じ manifest が走る。必要なら
          自分の resource も 1 つ増やせる。
        </p>
        <div class="ecosystem-map">
          <div class="ecosystem-layer ecosystem-apps">
            <div class="ecosystem-layer-label">あなたの Space に 並ぶもの</div>
            <div class="ecosystem-chips">
              <For each={APPS}>
                {(c) => (
                  <span class="ecosystem-chip">
                    <strong>{c.label}</strong>
                    {c.hint ? <em>{c.hint}</em> : null}
                  </span>
                )}
              </For>
            </div>
          </div>
          <div class="ecosystem-layer ecosystem-substrate">
            <div class="ecosystem-substrate-card">
              <strong>{SUBSTRATE.label}</strong>
              <p>{SUBSTRATE.description}</p>
            </div>
            <div class="ecosystem-substrate-sidecar">
              <strong>{ACCOUNTS.label}</strong>
              <p>{ACCOUNTS.description}</p>
            </div>
          </div>
          <div class="ecosystem-layer ecosystem-providers">
            <div class="ecosystem-layer-label">deploy 先 (= 何処にでも)</div>
            <div class="ecosystem-chips">
              <For each={PROVIDERS}>
                {(c) => (
                  <span class="ecosystem-chip">
                    <strong>{c.label}</strong>
                    {c.hint ? <em>{c.hint}</em> : null}
                  </span>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
