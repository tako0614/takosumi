import { For } from "solid-js";
import { FEATURES } from "~/content/features";

export default function FeatureGrid() {
  return (
    <section id="features">
      <div class="container">
        <span class="eyebrow">features</span>
        <h2>面倒な「いつもの」 を全部吸収する。</h2>
        <div class="features">
          <For each={FEATURES}>
            {(f) => (
              <article class="feature">
                <h4>{f.title}</h4>
                <p>{f.body}</p>
              </article>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}
