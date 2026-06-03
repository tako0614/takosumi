import { For } from "solid-js";
import { ACCOUNTS, APPS, PROVIDERS, SUBSTRATE } from "~/content/ecosystem";
import SplatField from "./SplatField";

export default function EcosystemMap() {
  return (
    <section id="ecosystem">
      <SplatField density="section" />
      <div class="container">
        <span class="eyebrow">ecosystem map</span>
        <h2>ひとつの土台、たくさんの形。</h2>
        <p class="lede">
          上に並ぶ app、真ん中の Takosumi、下の deploy 先。この 3 層を
          operator が自由に組み替えても、app の入口は変わりません。
        </p>
        <div class="ecosystem-map">
          <div class="ecosystem-layer ecosystem-apps">
            <div class="ecosystem-layer-label">
              Takosumi が deploy する module / product（例）
            </div>
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
            <div class="ecosystem-layer-label">deploy 先 (= どこにでも)</div>
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
