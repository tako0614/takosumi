import { createSignal, For, Show } from "solid-js";
import CodeBlock from "./CodeBlock";

interface Tab {
  readonly key: string;
  readonly label: string;
  readonly manifest: () => any;
  readonly output: () => any;
}

const TABS: readonly Tab[] = [
  {
    key: "selfhost",
    label: "selfhost-docker-compose",
    manifest: () => (
      <>
        <span class="c">## manifest.yml</span>{"\n"}
        apiVersion: <span class="s">"1.0"</span>{"\n"}
        kind: Manifest{"\n"}
        metadata:{"\n"}
        {"  "}name: hello{"\n"}
        resources:{"\n"}
        {"  "}- name: web{"\n"}
        {"    "}shape: <span class="s">"web-service@v1"</span>{"\n"}
        {"    "}provider: <span class="s">"@takos/selfhost-docker-compose"</span>{"\n"}
        {"    "}spec:{"\n"}
        {"      "}image: nginx:alpine{"\n"}
        {"      "}port: <span class="n">80</span>{"\n"}
        {"      "}scale: {`{ min: `}<span class="n">1</span>, max: <span class="n">1</span> {`}`}
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi deploy ./manifest.yml{"\n"}
        <span class="c">  ✓ applied web-service@v1#web</span>{"\n"}
        <span class="c">  → http://localhost:18080</span>{"\n"}
        {"\n"}
        <span class="k">$</span> curl -I http://localhost:18080{"\n"}
        HTTP/1.1 <span class="n">200</span> OK{"\n"}
        server: nginx/1.27.3
      </>
    ),
  },
  {
    key: "fargate",
    label: "aws-fargate",
    manifest: () => (
      <>
        <span class="c">## same shape, different provider</span>{"\n"}
        resources:{"\n"}
        {"  "}- name: web{"\n"}
        {"    "}shape: <span class="s">"web-service@v1"</span>{"\n"}
        {"    "}provider: <span class="s">"@takos/aws-fargate"</span>{"\n"}
        {"    "}spec:{"\n"}
        {"      "}image: ghcr.io/your-org/web:abc123{"\n"}
        {"      "}port: <span class="n">80</span>{"\n"}
        {"      "}scale: {`{ min: `}<span class="n">2</span>, max: <span class="n">10</span> {`}`}
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi deploy ./manifest.yml{"\n"}
        <span class="c">  ✓ applied web-service@v1#web via @takos/aws-fargate</span>{"\n"}
        <span class="c">  → https://web-abc123.us-east-1.elb.amazonaws.com</span>
      </>
    ),
  },
  {
    key: "k8s",
    label: "kubernetes-k3s",
    manifest: () => (
      <>
        resources:{"\n"}
        {"  "}- name: web{"\n"}
        {"    "}shape: <span class="s">"web-service@v1"</span>{"\n"}
        {"    "}provider: <span class="s">"@takos/kubernetes-k3s-deployment"</span>{"\n"}
        {"    "}spec:{"\n"}
        {"      "}image: ghcr.io/your-org/web:abc123{"\n"}
        {"      "}port: <span class="n">80</span>{"\n"}
        {"      "}scale: {`{ min: `}<span class="n">3</span>, max: <span class="n">3</span> {`}`}
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi deploy ./manifest.yml{"\n"}
        <span class="c">  ✓ applied web-service@v1#web via @takos/kubernetes-k3s-deployment</span>{"\n"}
        <span class="c">  → http://web.takos.svc.cluster.local</span>
      </>
    ),
  },
];

export default function Showcase() {
  const [active, setActive] = createSignal(TABS[0].key);
  const current = () => TABS.find((t) => t.key === active())!;

  return (
    <section id="showcase">
      <div class="container">
        <span class="eyebrow">Showcase</span>
        <h2>同じ shape、 違う substrate。</h2>
        <p class="lede">
          provider 行を 1 つ変えるだけで AWS Fargate にも、 Kubernetes にも、
          手元の docker にも同じ web-service が乗る。
        </p>
        <div class="showcase">
          <div class="showcase-tabs" role="tablist">
            <For each={TABS}>
              {(t) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active() === t.key}
                  classList={{ active: active() === t.key }}
                  onClick={() => setActive(t.key)}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>
          <div class="showcase-body">
            <div>
              <div class="label">manifest</div>
              <Show when={current()}>
                {(t) => <div class="codeblock"><pre>{t().manifest()}</pre></div>}
              </Show>
            </div>
            <div>
              <div class="label">apply output</div>
              <Show when={current()}>
                {(t) => <div class="codeblock"><pre>{t().output()}</pre></div>}
              </Show>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
