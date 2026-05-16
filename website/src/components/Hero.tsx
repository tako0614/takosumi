import CodeBlock from "./CodeBlock";

export default function Hero() {
  return (
    <section class="hero">
      <div class="container">
        <span class="eyebrow">v0.17 · @takos/takosumi on JSR</span>
        <h1>
          <span class="grad-text">Manifest 1 本で</span>
          <br />
          どこにでも deploy する PaaS。
        </h1>
        <p class="lede">
          Self-hostable な PaaS toolkit。 AWS / GCP / Cloudflare / Azure /
          Kubernetes / Docker / systemd / bare-metal — 同じ manifest を
          同じ <code>takosumi deploy</code> で apply。
        </p>
        <div class="cta-row">
          <a class="btn btn-primary" href="/docs/getting-started/quickstart">
            5 分 Quickstart →
          </a>
          <a class="btn btn-secondary" href="/docs/">ドキュメントを読む</a>
        </div>
        <CodeBlock terminal>
          <span class="c"># JSR から CLI を install</span>{"\n"}
          <span class="k">$</span> deno install -gA -n takosumi jsr:@takos/takosumi-cli{"\n"}
          <span class="k">$</span> takosumi deploy ./manifest.yml{"\n"}
          <span class="c">  → applied web-service@v1#hello → http://localhost:18080</span>
        </CodeBlock>
      </div>
    </section>
  );
}
