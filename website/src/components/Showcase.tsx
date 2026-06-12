import { createSignal, For } from "solid-js";
import type { JSX } from "solid-js";
import SplatField from "./SplatField";

interface Tab {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly source: () => JSX.Element;
  readonly output: () => JSX.Element;
}

const TABS: readonly Tab[] = [
  {
    key: "install",
    label: "1. module を install",
    subtitle: "Git repo → Installation",
    source: () => (
      <>
        <span class="c"># Git の OpenTofu module を Installation に</span>
        {"\n"}
        <span class="c"># dashboard の「追加」にカタログ or Git URL を入れるだけ</span>
        {"\n"}
        <span class="k">POST</span> /api/spaces/sp_prod/installations{"\n"}
        <span class="c">{"  "}↳ git: https://git.example.com/acme/api.git (main)</span>
        {"\n"}
        <span class="c">{"  "}✓ Installation created</span>
        {"\n"}
        <span class="c">{"  "}✓ Run run_8f2a…  waiting approval</span>
      </>
    ),
    output: () => (
      <>
        <span class="c">Installation が 1 つ、</span>
        {"\n"}
        <span class="c">reviewed plan が 1 本。</span>
        {"\n"}
        <span class="c">専用 manifest は要らない。</span>
      </>
    ),
  },
  {
    key: "apply",
    label: "2. reviewed plan を apply",
    subtitle: "Run(plan) → Run(apply) → Deployment",
    source: () => (
      <>
        <span class="c"># planDigest を pin して apply</span>
        {"\n"}
        <span class="k">POST</span> /api/runs/run_8f2a/approve{"\n"}
        <span class="k">GET</span> /api/runs/run_apply_3c1d{"\n"}
        <span class="c">{"  "}✓ Run apply_3c1d…  applied</span>
      </>
    ),
    output: () => (
      <>
        <span class="c">→ Deployment live</span>
        {"\n"}
        <span class="c">→ OutputSnapshot recorded (non-secret projection)</span>
        {"\n"}
        <span class="c">→ policy decision と audit event も台帳に。</span>
      </>
    ),
  },
  {
    key: "runner",
    label: "3. 実行先を切り替える",
    subtitle: "Connection と policy で portable",
    source: () => (
      <>
        <span class="c"># Connection / policy で実行境界を選ぶ</span>
        {"\n"}
        <span class="k">PATCH</span> /api/installations/ins_api/deployment-profile{"\n"}
        <span class="c">{"  "}↳ cloudflare.main: default</span>
        {"\n"}
        <span class="c">{"  "}↳ aws.archive: Space AWS role</span>
        {"\n"}
        {"\n"}
        <span class="k">POST</span> /api/installations/ins_api/plan{"\n"}
        <span class="c">{"  "}↳ ProviderBinding と policy から実行境界を解決</span>
      </>
    ),
    output: () => (
      <>
        <span class="c">同じ OpenTofu module を、違う実行境界で。</span>
        {"\n"}
        <span class="c">cloud に出しても、VM や cluster に戻しても、</span>
        {"\n"}
        <span class="c">中身は変わらない。引っ越せる。</span>
      </>
    ),
  },
];

export default function Showcase() {
  const [active, setActive] = createSignal(TABS[0].key);

  // Arrow-key navigation per the WAI-ARIA tablist pattern.
  const onTabKey = (e: KeyboardEvent & { currentTarget: HTMLElement }) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.key === active());
    const n = e.key === "ArrowRight"
      ? (i + 1) % TABS.length
      : (i - 1 + TABS.length) % TABS.length;
    setActive(TABS[n].key);
    (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)
      ?.focus();
  };

  return (
    <section id="showcase">
      <SplatField density="section" />
      <div class="container">
        <span class="eyebrow">how it works</span>
        <h2>install → plan / apply → どこへでも。</h2>
        <p class="lede">
          Git の OpenTofu module を install → reviewed plan を apply →
          Connection と policy で実行先を選ぶ。3 step。Takos も、この仕組みで動いています。
        </p>
        <div class="showcase">
          <div
            class="showcase-tabs"
            role="tablist"
            aria-label="使い方の 3 ステップ"
          >
            <For each={TABS}>
              {(t) => (
                <button
                  type="button"
                  role="tab"
                  id={`showcase-tab-${t.key}`}
                  aria-controls={`showcase-panel-${t.key}`}
                  aria-selected={active() === t.key}
                  tabindex={active() === t.key ? 0 : -1}
                  classList={{ active: active() === t.key }}
                  onClick={() => setActive(t.key)}
                  onKeyDown={onTabKey}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>
          <For each={TABS}>
            {(t) => (
              <div
                class="showcase-body"
                id={`showcase-panel-${t.key}`}
                role="tabpanel"
                tabindex={0}
                aria-labelledby={`showcase-tab-${t.key}`}
                hidden={active() !== t.key}
              >
                <div>
                  <div class="label">Source</div>
                  <div class="codeblock">
                    <pre>{t.source()}</pre>
                  </div>
                </div>
                <div>
                  <div class="label">apply</div>
                  <div class="codeblock">
                    <pre>{t.output()}</pre>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}
