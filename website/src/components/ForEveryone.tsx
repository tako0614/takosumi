import { For } from "solid-js";
import { AUDIENCES } from "~/content/audiences";
import SplatField from "./SplatField";

export default function ForEveryone() {
  return (
    <section id="for-everyone">
      <SplatField density="section" />
      <div class="container">
        <span class="eyebrow">who it's for</span>
        <h2>ひとりの開発者から、組織まで。</h2>
        <p class="lede">
          重い運用を抱えなくても、自分の deploy を所有できる。
          はじめての人から、監査が要る組織まで。
        </p>
        <div class="audience-rows">
          <For each={AUDIENCES}>
            {(a, i) => (
              <article
                class="audience-row"
                classList={{ alt: i() % 2 === 1 }}
              >
                <div class="audience-row-head">
                  <h3>{a.name}</h3>
                  <p class="audience-persona">{a.persona}</p>
                </div>
                <div class="audience-row-stack">
                  <span class="audience-stack-label">
                    例えば こんな deploy を
                  </span>
                  <code class="audience-stack-value">{a.exampleStack}</code>
                </div>
                <div class="audience-row-cta">
                  <a class="btn btn-secondary" href={a.cta.href} rel="external">
                    {a.cta.label} →
                  </a>
                </div>
              </article>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}
