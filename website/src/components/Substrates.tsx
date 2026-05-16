/**
 * Visual proof that "any cloud" is real. A wide strip of substrate
 * names rendered as monospace pills, no logo licensing needed.
 */
const SUBSTRATES = [
  "AWS",
  "Google Cloud",
  "Cloudflare",
  "Azure",
  "Kubernetes",
  "docker",
  "systemd",
  "Deno Deploy",
  "bare-metal",
];

export default function Substrates() {
  return (
    <section class="substrates">
      <div class="container">
        <p class="substrates-label">同じ manifest が、 全部で動く。</p>
        <div class="substrates-row">
          {SUBSTRATES.map((s) => <span class="substrate-chip">{s}</span>)}
        </div>
      </div>
    </section>
  );
}
