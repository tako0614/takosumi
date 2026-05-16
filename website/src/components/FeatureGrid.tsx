import { For } from "solid-js";
import { FEATURES } from "~/content/features";

export default function FeatureGrid() {
  return (
    <section id="features">
      <div class="container">
        <span class="eyebrow">Features</span>
        <h2>6 つの中核。</h2>
        <p class="lede">docs の features array と同じ正本。 6 つを保てば「Takosumi らしさ」 が成立する。</p>
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
