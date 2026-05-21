import { For } from "solid-js";
import { PILLARS } from "~/content/why";

export default function WhySelfHost() {
  return (
    <section id="why">
      <div class="container">
        <span class="eyebrow">why self-host</span>
        <h2>あなたのデータは、 あなたの場所に。</h2>
        <p class="lede">
          SaaS が止まっても、 値上げしても、 規約を変えても —— 自分の host に
          あるなら、 自分のものは自分のもの。 Takosumi は open source なので、
          中身も全部見える。
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
