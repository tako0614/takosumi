import { For } from "solid-js";
import { PILLARS } from "~/content/why";
import SplatField from "./SplatField";

export default function WhyOperatorOwned() {
  return (
    <section id="why">
      <SplatField density="section" />
      <div class="container">
        <span class="eyebrow">why operator-owned</span>
        <h2>入口は共通。実行先は、あなたが選ぶ。</h2>
        <p class="lede">
          Takosumi は Installation と Deployment を共通化します。
          API、DB、object store、gateway の実体は、operator が選んだ cloud、
          VM、cluster、または管理サービスの上に作ります。
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
