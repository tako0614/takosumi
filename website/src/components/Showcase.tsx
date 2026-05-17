import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";

interface Tab {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly manifest: () => JSX.Element;
  readonly output: () => JSX.Element;
}

const TABS: readonly Tab[] = [
  {
    key: "selfhost",
    label: "手元の docker",
    subtitle: "@takos/selfhost-docker-compose",
    manifest: () => (
      <>
        apiVersion: <span class="s">"1.0"</span>
        {"\n"}
        kind: Manifest{"\n"}
        metadata:{"\n"}{"  "}name: hello{"\n"}
        resources:{"\n"}{"  "}- name: web{"\n"}{"    "}shape:{" "}
        <span class="s">"web-service@v1"</span>
        {"\n"}{"    "}provider:{" "}
        <span class="k">"@takos/selfhost-docker-compose"</span>
        {"\n"}{"    "}spec:{"\n"}{"      "}image: nginx:alpine{"\n"}{"      "}
        port: <span class="n">80</span>
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi deploy ./manifest.yml{"\n"}
        <span class="c">{" ".repeat(2)}✓ web → http://localhost:18080</span>
      </>
    ),
  },
  {
    key: "fargate",
    label: "AWS Fargate",
    subtitle: "@takos/aws-fargate",
    manifest: () => (
      <>
        <span class="c"># provider を 1 行変えるだけ</span>
        {"\n"}
        resources:{"\n"}{"  "}- name: web{"\n"}{"    "}shape:{" "}
        <span class="s">"web-service@v1"</span>
        {"\n"}{"    "}provider: <span class="k">"@takos/aws-fargate"</span>
        {"\n"}{"    "}spec:{"\n"}{"      "}
        image: ghcr.io/your-org/web:abc123{"\n"}{"      "}port:{" "}
        <span class="n">80</span>
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi deploy ./manifest.yml{"\n"}
        <span class="c">
          {" ".repeat(2)}✓ web → https://web-abc.us-east-1.elb.amazonaws.com
        </span>
      </>
    ),
  },
  {
    key: "k8s",
    label: "Kubernetes",
    subtitle: "@takos/kubernetes-k3s-deployment",
    manifest: () => (
      <>
        resources:{"\n"}{"  "}- name: web{"\n"}{"    "}shape:{" "}
        <span class="s">"web-service@v1"</span>
        {"\n"}{"    "}provider:{" "}
        <span class="k">"@takos/kubernetes-k3s-deployment"</span>
        {"\n"}{"    "}spec:{"\n"}{"      "}
        image: ghcr.io/your-org/web:abc123{"\n"}{"      "}port:{" "}
        <span class="n">80</span>
        {"\n"}{"      "}scale: {`{ min: `}
        <span class="n">3</span>, max: <span class="n">3</span> {`}`}
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi deploy ./manifest.yml{"\n"}
        <span class="c">
          {" ".repeat(2)}✓ web → http://web.takos.svc.cluster.local
        </span>
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
        <span class="eyebrow">showcase</span>
        <h2>同じ manifest で、 デプロイ先を選ぶ。</h2>
        <p class="lede">
          タブを切り替えてみてください。 違うのは <code>provider</code>{" "}
          の 1 行だけ。 残りは全部同じです。
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
              <div class="label">manifest.yml</div>
              <Show when={current()}>
                {(t) => (
                  <div class="codeblock">
                    <pre>{t().manifest()}</pre>
                  </div>
                )}
              </Show>
            </div>
            <div>
              <div class="label">apply</div>
              <Show when={current()}>
                {(t) => (
                  <div class="codeblock">
                    <pre>{t().output()}</pre>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
