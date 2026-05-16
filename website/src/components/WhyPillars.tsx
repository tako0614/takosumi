export default function WhyPillars() {
  return (
    <section id="why">
      <div class="container">
        <span class="eyebrow">なぜ Takosumi</span>
        <h2>Vendor lock-in を <em class="grad-text">構造的に</em> 持たない PaaS。</h2>
        <p class="lede">
          Manifest, kernel, runtime-agent の 3 層で「移植可能性」 を必要条件として
          設計した結果、 同じ resource を 3 行の YAML 変更だけで別 substrate に
          引っ越せる。
        </p>
        <div class="pillars">
          <article class="pillar">
            <h3><span class="num">01</span> Portability first</h3>
            <p>
              Shape (web-service / database / object-store / domain / worker)
              は provider 中立。 spec の <code>provider</code> を切り替える
              だけで AWS Fargate → Cloud Run → docker-compose まで同じ
              manifest が動く。
            </p>
          </article>
          <article class="pillar">
            <h3><span class="num">02</span> Pure kernel</h3>
            <p>
              workflow runner / identity / billing / project convention を
              kernel は持たない。 持たないことを「制約」 ではなく「移植可能性
              の必要条件」 として明示。 持ちたい責務は <code>takosumi-git</code>
              等の sibling product に分離。
            </p>
          </article>
          <article class="pillar">
            <h3><span class="num">03</span> Self-host by default</h3>
            <p>
              JSR で配布、 <code>deno install</code> 1 行で動く。 SaaS 申し込み
              不要。 自前の VM / Kubernetes / Cloudflare account のいずれにも
              乗せられる。
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
