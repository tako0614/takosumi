import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";

interface Tab {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly source: () => JSX.Element;
  readonly output: () => JSX.Element;
}

const TABS: readonly Tab[] = [
  {
    key: "space",
    label: "1. Space を作る",
    subtitle: "bundled apps が auto-install",
    source: () => (
      <>
        <span class="c"># 新しい Space を作るだけで、 bundled apps が立つ</span>
        {"\n"}
        <span class="k">$</span> takosumi space create my-home{"\n"}
        <span class="c">{" ".repeat(2)}✓ chat (takos)</span>
        {"\n"}
        <span class="c">{" ".repeat(2)}✓ docs (takos-docs)</span>
        {"\n"}
        <span class="c">{" ".repeat(2)}✓ slides (takos-slide)</span>
        {"\n"}
        <span class="c">{" ".repeat(2)}✓ spreadsheet (takos-excel)</span>
        {"\n"}
        <span class="c">{" ".repeat(2)}✓ AI agent (takos-agent)</span>
      </>
    ),
    output: () => (
      <>
        <span class="c">空 → 必要なもの 全部 揃った Space。</span>
        {"\n"}
        <span class="c">Notion / Slack / Docs を 個別契約する代わりに</span>
        {"\n"}
        <span class="c">1 つの Takosumi 上で 全部。</span>
      </>
    ),
  },
  {
    key: "app",
    label: "2. 自分の app を 1 つ追加",
    subtitle: "Source を install",
    source: () => (
      <>
        <span class="c"># Git repo を Source として install</span>
        {"\n"}
        <span class="k">$</span> takosumi install git+https://example.com/diary
        {"\n"}
        <span class="c">{" ".repeat(2)}source: git</span>
        {"\n"}
        <span class="c">{" ".repeat(2)}binding: database.primary.connection</span>
        {"\n"}
        <span class="c">{" ".repeat(2)}expected: planSnapshotDigest</span>
      </>
    ),
    output: () => (
      <>
        <span class="k">$</span> takosumi install . --space my-home{"\n"}
        <span class="c">{" ".repeat(2)}✓ installed com.example.diary</span>
        {"\n"}
        <span class="c">{" ".repeat(2)}→ my Space に 並んだ。</span>
      </>
    ),
  },
  {
    key: "deploy",
    label: "3. deploy 先を切り替える",
    subtitle: "cloud でも VM でも cluster でも",
    source: () => (
      <>
        <span class="c"># operator inventory を差し替える</span>
        {"\n"}
        <span class="k">$</span> takosumi deploy diary --profile cloudflare
        {"\n"}
        <span class="c">{" ".repeat(2)}✓ deployed to Cloudflare Workers</span>
        {"\n"}
        {"\n"}
        <span class="k">$</span>{" "}
        takosumi deploy diary --profile docker-compose
        {"\n"}
        <span class="c">{" ".repeat(2)}✓ deployed to an operator VM</span>
      </>
    ),
    output: () => (
      <>
        <span class="c">同じ Source を、違う operator profile で。</span>
        {"\n"}
        <span class="c">cloud に出しても、 VM や cluster に戻しても、</span>
        {"\n"}
        <span class="c">中身は変わらない。 引っ越せる。</span>
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
        <span class="eyebrow">how it works</span>
        <h2>Space を 1 つ作ると、 必要なもの 全部 揃う。</h2>
        <p class="lede">
          Space を作る → 自分の app を Source として足す → deploy 先を選ぶ。3 step、
          operator inventory が cloud / VM / cluster の違いを受け持ちます。
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
              <div class="label">Source</div>
              <Show when={current()}>
                {(t) => (
                  <div class="codeblock">
                    <pre>{t().source()}</pre>
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
