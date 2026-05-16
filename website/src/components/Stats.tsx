/**
 * Big-number flex. Plain integers, no currency glyphs, no exclamations.
 * The numbers are factual; the note explains why each one matters.
 */
const STATS = [
  { n: "9", label: "substrates", note: "AWS / GCP / CF / Azure / K8s / docker / systemd / Deno Deploy / bare-metal" },
  { n: "1", label: "manifest", note: "1 つの YAML を全 substrate に apply" },
  { n: "0", label: "lock-in", note: "provider 行を書き換えれば別 substrate に引っ越し" },
  { n: "0", label: "subscription", note: "self-host で運用、 SaaS 契約は不要" },
];

export default function Stats() {
  return (
    <section class="stats">
      <div class="container">
        <div class="stats-grid">
          {STATS.map((s) => (
            <article class="stat">
              <div class="stat-num">{s.n}</div>
              <div class="stat-label">{s.label}</div>
              <div class="stat-note">{s.note}</div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
