import { For } from "solid-js";
import { AUDIENCES } from "~/content/audiences";

export default function ForEveryone() {
  return (
    <section id="for-everyone">
      <div class="container">
        <span class="eyebrow">for everyone</span>
        <h2>ひとり用にも、 組織にも、 はじめての人にも。</h2>
        <p class="lede">
          技術者だけのものじゃない。 自分の Space を 持ちたい全ての人のために。
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
                    例えば この Space に
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
