import { For, Show } from "solid-js";
import { USE_CASES } from "~/content/use-cases";

export default function WhatYouCanHost() {
  return (
    <section id="what">
      <div class="container">
        <span class="eyebrow">what you can run</span>
        <h2>全部、 選んだ実行先に。</h2>
        <p class="lede">
          chat も、 SNS も、 docs も、 表計算も、 agent も。1 つの platform
          の上で、cloud、VM、cluster、管理サービスのどれにも置けます。
        </p>
        <div class="use-cases-grid">
          <For each={USE_CASES}>
            {(u) => (
              <article class="use-case-tile">
                <h4>{u.role}</h4>
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
