import { For } from "solid-js";
import { USE_CASES } from "~/content/use-cases";

/** Installable starters and products — a plain list of real links. */
export default function WhatYouCanHost() {
  return (
    <section id="what">
      <div class="container">
        <h2>登録できるサービス</h2>
        <p class="intro">
          公式スターターも、自分の Git リポジトリも、同じサービスとして扱う。必要な接続と変更内容を先に見せてから公開する。
        </p>
        <ul class="fact-list">
          <For each={USE_CASES}>
            {(u) => (
              <li>
                <a class="host-name" href={u.href} rel="noopener">
                  {u.name}
                </a>
                <span class="host-note">
                  {u.desc}。{u.note}
                </span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </section>
  );
}
