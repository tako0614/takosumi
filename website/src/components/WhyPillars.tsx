const ITEMS = [
  {
    title: "ロックインがない。",
    body: "今日 docker、 明日 Cloudflare、 来年 Kubernetes — manifest を 1 行変えるだけ。 移植は前提。",
  },
  {
    title: "credit card が要らない。",
    body: "self-host で 0 円。 vendor 申し込みも、 SaaS subscription もスキップ。",
  },
  {
    title: "1 コマンドで動く。",
    body: "deno install → takosumi deploy。 環境構築 / 設定地獄 / 専用 CI は不要。",
  },
];

export default function WhyPillars() {
  return (
    <section id="why">
      <div class="container">
        <span class="eyebrow">why</span>
        <h2>3 つだけ覚えてください。</h2>
        <div class="pillars">
          {ITEMS.map((it) => (
            <article class="pillar">
              <h3>{it.title}</h3>
              <p>{it.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
