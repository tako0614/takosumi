import { For } from "solid-js";
import { PACKAGES } from "~/content/packages";

function planeLabel(p: string): string {
  switch (p) {
    case "contract": return "Contract";
    case "control": return "Control plane";
    case "data": return "Data plane";
    case "client": return "Client";
    default: return p;
  }
}

export default function Architecture() {
  return (
    <section id="architecture">
      <div class="container">
        <span class="eyebrow">Architecture</span>
        <h2>6 つの JSR package。</h2>
        <p class="lede">
          contract / control plane / data plane / client の 4 層に責務を分け、
          JSR で 6 package として配布する。
        </p>

        <div class="archlayer">
          <table>
            <thead>
              <tr>
                <th>Package</th>
                <th>Plane</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              <For each={PACKAGES}>
                {(p) => (
                  <tr>
                    <td><code>{p.name}</code></td>
                    <td>{planeLabel(p.plane)}</td>
                    <td>{p.role}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>

          <svg viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-label="Layer diagram">
            <defs>
              <linearGradient id="archg" x1="0" y1="0" x2="320" y2="320" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="var(--tg-grad-from)" />
                <stop offset="1" stop-color="var(--tg-grad-to)" />
              </linearGradient>
            </defs>
            <g font-family="var(--tg-font-mono)" font-size="11">
              {/* contract — base */}
              <rect x="20" y="270" width="280" height="36" rx="8" fill="var(--tg-bg-subtle)" stroke="var(--tg-line)" />
              <text x="160" y="293" text-anchor="middle" fill="var(--tg-fg)">contract (型契約)</text>
              {/* control plane */}
              <rect x="20" y="170" width="280" height="80" rx="10" fill="url(#archg)" opacity="0.16" stroke="var(--tg-accent)" stroke-width="1.2" />
              <text x="160" y="190" text-anchor="middle" fill="var(--tg-fg)" font-weight="700">control plane</text>
              <rect x="40" y="200" width="120" height="34" rx="6" fill="var(--tg-bg-elev)" stroke="var(--tg-line-strong)" />
              <text x="100" y="222" text-anchor="middle" fill="var(--tg-fg)">kernel</text>
              <rect x="170" y="200" width="110" height="34" rx="6" fill="var(--tg-bg-elev)" stroke="var(--tg-line-strong)" />
              <text x="225" y="222" text-anchor="middle" fill="var(--tg-fg)">plugins</text>
              {/* data plane */}
              <rect x="20" y="80" width="280" height="70" rx="10" fill="url(#archg)" opacity="0.3" stroke="var(--tg-accent)" stroke-width="1.2" />
              <text x="160" y="100" text-anchor="middle" fill="var(--tg-fg)" font-weight="700">data plane</text>
              <rect x="80" y="112" width="160" height="30" rx="6" fill="var(--tg-bg-elev)" stroke="var(--tg-line-strong)" />
              <text x="160" y="131" text-anchor="middle" fill="var(--tg-fg)">runtime-agent</text>
              {/* client */}
              <rect x="20" y="20" width="280" height="44" rx="10" fill="var(--tg-bg-elev)" stroke="var(--tg-line-strong)" />
              <text x="160" y="38" text-anchor="middle" fill="var(--tg-fg)" font-weight="700">client</text>
              <text x="160" y="55" text-anchor="middle" fill="var(--tg-fg-muted)" font-size="10">cli · umbrella</text>
            </g>
          </svg>
        </div>
      </div>
    </section>
  );
}
