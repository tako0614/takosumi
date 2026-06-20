import { For } from "solid-js";
import { PILLARS } from "~/content/why";
import SplatField from "./SplatField.tsx";

export default function WhyOperatorOwned() {
  return (
    <section id="why">
      <SplatField density="section" />
      <div class="container">
        <span class="eyebrow">why operator-owned</span>
        <h2>入口は共通。実行先は、あなたが選ぶ。</h2>
        <p class="lede">
          Takosumi は OpenTofu/Terraform 実行の外側を管理します。
          API、DB、object store、worker は既存 provider が作り、Takosumi は
          credential、state、outputs、run 履歴、audit を一箇所に残します。
        </p>
        <div class="pillars">
          <For each={PILLARS}>
            {(p) => (
              <article class="pillar">
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}
