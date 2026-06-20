import { createSignal, For } from "solid-js";
import type { JSX } from "solid-js";
import SplatField from "./SplatField.tsx";

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
    label: "1. Capsule を作る",
    subtitle: "Git repo → Capsule",
    source: () => (
      <>
        <span class="c"># Git の OpenTofu module を Capsule に</span>
        {"\n"}
        <span class="k">POST</span> /api/v1/projects/prj_live/capsules{"\n"}
        <span class="c">
          {"  "}source.git = https://git.example.com/acme/api.git
        </span>
        {"\n"}
        <span class="c">{"  "}source.ref = main · source.path = infra</span>
        {"\n"}
        <span class="c">{"  "}✓ Capsule created</span>
        {"\n"}
        <span class="k">bind</span> cloudflare.default → cloudflare-prod{"\n"}
        <span class="c">{"  "}↳ ProviderConnection から env/file を注入</span>
        {"\n"}
        <span class="k">POST</span> /api/v1/capsules/cap_api/runs/plan{"\n"}
        <span class="c">{"  "}✓ Run run_8f2a… reviewed plan ready</span>
      </>
    ),
    output: () => (
      <>
        <span class="c">Capsule が 1 つ、</span>
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
    subtitle: "Run(plan) → Run(apply) → StateVersion",
    source: () => (
      <>
        <span class="c"># planDigest を pin して apply</span>
        {"\n"}
        <span class="c">
          {"  "}# waiting_approval の時だけ approve を挟む
        </span>
        {"\n"}
        <span class="k">POST</span> /api/v1/runs/run_8f2a/apply{"\n"}
        <span class="k">GET</span> /api/v1/runs/run_apply_3c1d{"\n"}
        <span class="c">{"  "}✓ Run apply_3c1d… applied</span>
      </>
    ),
    output: () => (
      <>
        <span class="c">→ StateVersion recorded</span>
        {"\n"}
        <span class="c">→ Outputs captured (secret values redacted)</span>
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
        <span class="c"># ProviderBinding だけを切り替える</span>
        {"\n"}
        <span class="k">bind</span> ProviderConnection{"\n"}
        <span class="c">{"  "}↳ cloudflare.default: cloudflare-dev</span>
        {"\n"}
        <span class="c">{"  "}↳ cloudflare.default: cloudflare-prod</span>
        {"\n"}
        {"\n"}
        <span class="k">POST</span> /api/v1/capsules/cap_api/runs/plan{"\n"}
        <span class="c">
          {"  "}↳ 同じ module に別の credential/env を注入
        </span>
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
    const n =
      e.key === "ArrowRight"
        ? (i + 1) % TABS.length
        : (i - 1 + TABS.length) % TABS.length;
    setActive(TABS[n].key);
    (
      e.currentTarget.parentElement?.children[n] as HTMLElement | undefined
    )?.focus();
  };

  return (
    <section id="showcase">
      <SplatField density="section" />
      <div class="container">
        <span class="eyebrow">how it works</span>
        <h2>Capsule → plan / apply → output まで。</h2>
        <p class="lede">
          Git の OpenTofu module を Capsule にする。ProviderConnection を選ぶ。
          reviewed plan を apply する。secret は manifest に置かず、Run
          の一時環境にだけ注入します。
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
