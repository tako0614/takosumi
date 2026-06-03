import { For, Show } from "solid-js";
import { USE_CASES } from "~/content/use-cases";
import SplatField from "./SplatField";

export default function WhatYouCanHost() {
  return (
    <section id="what">
      <SplatField density="section" />
      <div class="container">
        <span class="eyebrow">what you can deploy</span>
        <h2>plain な module なら、何でも。</h2>
        <p class="lede">
          Takosumi が扱うのは専用フォーマットではなく、ただの OpenTofu module。
          web も API も DB も worker も、Git URL を渡すだけで Installation になります。
        </p>
        <div class="use-cases-grid">
          <For each={USE_CASES}>
            {(u) => (
              <article class="use-case-tile">
                <h3>{u.role}</h3>
                <p class="powered-by">{u.poweredBy}</p>
                <Show when={u.note}>
                  <p class="use-case-note">{u.note}</p>
                </Show>
              </article>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}
