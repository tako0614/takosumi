import { For } from "solid-js";
import { USE_CASES } from "~/content/use-cases";

/** Installable starters and products as a spec list — hairline rows, not cards. */
export default function WhatYouCanHost() {
  return (
    <section id="what">
      <div class="container">
        <h2>登録できるサービス</h2>
        <p class="lede">
          公式スターターも、自分の Git リポジトリも、同じ
          <em class="em">サービス</em>
          として扱います。Takosumi
          は、必要な接続と変更内容を先に見せてから公開します。
        </p>
        <ul class="host-list">
          <For each={USE_CASES}>
            {(u) => (
              <li class="host-row">
                <a class="host-link" href={u.href} rel="noopener">
                  <span class="host-id">
                    <span class="host-name">{u.name}</span>
                    <span class="host-desc">{u.desc}</span>
                  </span>
                  <span class="host-note">{u.note}</span>
                  <span class="host-cta">
                    {u.cta} <span aria-hidden="true">→</span>
                  </span>
                </a>
              </li>
            )}
          </For>
        </ul>
      </div>
    </section>
  );
}
