/**
 * Big-number flex. The substrate count is the most distinctive
 * Takosumi number worth shouting about. The rest are intentional
 * zeros — "things you don't have to do".
 */
const STATS = [
  { n: "9", label: "substrates", note: "AWS / GCP / CF / Azure / K8s / docker / systemd / Deno Deploy / bare-metal" },
  { n: "1", label: "manifest", note: "全部に 1 つの YAML で届く" },
  { n: "0", label: "vendor lock", note: "provider 行を書き換えるだけで引っ越し" },
  { n: "0¥", label: "subscription", note: "self-host は無料、 SaaS 申し込み不要" },
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
