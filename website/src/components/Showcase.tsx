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
    subtitle: "self-hosted runtime",
    manifest: () => (
      <>
        apiVersion: v1{"\n"}
        metadata:{"\n"}{"  "}id: com.example.hello{"\n"}{"  "}name: Hello{"\n"}
        components:{"\n"}{"  "}web:{"\n"}{"    "}kind: worker{"\n"}{"    "}
        spec:{"\n"}{"      "}routes:{"\n"}{"        "}- /{"\n"}{"    "}
        build:{"\n"}{"      "}command: deno task build{"\n"}{"      "}output:
        {" "}
        dist/worker.mjs
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi install . --space personal{"\n"}
        <span class="c">{" ".repeat(2)}✓ installed com.example.hello</span>
      </>
    ),
  },
  {
    key: "fargate",
    label: "Workers",
    subtitle: "Cloudflare D1 / R2 / Queue / DO",
    manifest: () => (
      <>
        <span class="c"># AppSpec は同じ。 substrate は operator が選ぶ</span>
        {"\n"}
        components:{"\n"}{"  "}web:{"\n"}{"    "}kind: worker{"\n"}{"    "}
        listen:{"\n"}{"      "}com.example.hello.db: {`{ as: env, prefix: DB_ }`}
        {"\n"}{"  "}db:{"\n"}{"    "}kind: postgres{"\n"}{"    "}publish:
        {"\n"}{"      "}- com.example.hello.db{"\n"}{"  "}assets:
        {"\n"}{"    "}kind: object-store
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi deploy ins_abc123{"\n"}
        <span class="c">{" ".repeat(2)}✓ deployment dep_abc123 succeeded</span>
      </>
    ),
  },
  {
    key: "k8s",
    label: "Rollback",
    subtitle: "Installation / Deployment ledger",
    manifest: () => (
      <>
        <span class="c"># 任意の Deployment に rollback、 ledger は monotonic</span>
        {"\n"}
        <span class="c"># に積み上がる (= apply / rollback / failed が全部</span>
        {"\n"}
        <span class="c"># Deployment record として残る)</span>
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi rollback ins_abc123 dep_prev{"\n"}
        <span class="c">{" ".repeat(2)}✓ rolled back to dep_prev</span>
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
        <h2>同じ AppSpec で、 substrate を選ぶ。</h2>
        <p class="lede">
          App は <code>.takosumi.yml</code>{" "}
          に閉じ、 install / deploy / rollback は installer API の同じ lifecycle
          を通ります。
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
              <div class="label">.takosumi.yml</div>
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
