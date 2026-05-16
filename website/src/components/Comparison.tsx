import { For } from "solid-js";
import { COMPARISON } from "~/content/comparison";

export default function Comparison() {
  return (
    <section id="comparison">
      <div class="container">
        <span class="eyebrow">Comparison</span>
        <h2>他の選択肢との違い。</h2>
        <p class="lede">
          ありえる 3 つの alternative (vendor PaaS / Terraform+Helm / 生 selfhost)
          と比較した時に何が違うか。
        </p>
        <div class="comparison">
          <table>
            <thead>
              <tr>
                <th>軸</th>
                <th>Takosumi</th>
                <th>Vendor PaaS</th>
                <th>Terraform + Helm</th>
                <th>生 selfhost</th>
              </tr>
            </thead>
            <tbody>
              <For each={COMPARISON}>
                {(r) => (
                  <tr>
                    <td>{r.axis}</td>
                    <td class="us">{r.us}</td>
                    <td>{r.vendor}</td>
                    <td>{r.tfHelm}</td>
                    <td>{r.raw}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
