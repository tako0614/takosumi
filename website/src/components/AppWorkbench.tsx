import { createSignal, For } from "solid-js";
import { FEATURED_APPS } from "~/content/apps";
import { CAPTURES } from "~/content/captures";

type AppId = (typeof FEATURED_APPS)[number]["id"];

export default function AppWorkbench() {
  const [selected, setSelected] = createSignal<AppId>("takos");
  const current = () => FEATURED_APPS.find((app) => app.id === selected()) ?? FEATURED_APPS[0];
  const capture = () => CAPTURES[selected()];

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = FEATURED_APPS.length - 1;
    const next = event.key === "ArrowDown" || event.key === "ArrowRight"
      ? (index + 1) % FEATURED_APPS.length
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? (index + last) % FEATURED_APPS.length
        : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (next < 0) return;
    event.preventDefault();
    setSelected(FEATURED_APPS[next].id);
    const rail = (event.currentTarget as HTMLButtonElement).closest(".app-rail");
    rail?.querySelectorAll<HTMLButtonElement>(".app-choice-button")[next]?.focus();
  };

  return (
    <section class="apps-section" id="apps" aria-labelledby="apps-title">
      <div class="container">
        <div class="apps-heading">
          <h2 id="apps-title">まず、使いたいアプリを選ぶ。</h2>
          <p>Git で公開された、OpenTofu 定義を持つ OSS から。アプリの中身を見て、入れるものを決められます。</p>
        </div>
        <div class="workbench">
          <div class="app-rail" aria-label="紹介するアプリ">
            <For each={FEATURED_APPS}>{(app, index) => (
              <div class="app-choice" classList={{ "is-active": selected() === app.id }}>
                <button
                  class="app-choice-button"
                  type="button"
                  aria-pressed={selected() === app.id}
                  aria-controls="selected-app"
                  onClick={() => setSelected(app.id)}
                  onKeyDown={(event) => onKeyDown(event, index())}
                >
                  <span class="app-choice-category">{app.category}</span>
                  <span class="app-choice-title">{app.name}<span aria-hidden="true">↗</span></span>
                  <span class="app-choice-summary">{app.summary}</span>
                </button>
                <a href={app.install} class="app-rail-install" aria-label={`${app.name} をインストール`}><span class="install-full">{app.name} をインストール</span><span class="install-short">入れる</span> <span aria-hidden="true">↗</span></a>
              </div>
            )}</For>
          </div>
          <div class="selected-app" id="selected-app" aria-live="polite">
            <div class="selected-app-head">
              <div>
                <span class="selected-app-label">選択中のアプリ</span>
                <h3>{current().name}</h3>
              </div>
              <span class="selected-app-category">{current().category}</span>
            </div>
            <picture class="selected-app-picture">
              <source media="(max-width: 700px)" srcset={capture().mobile.src} width={capture().mobile.width} height={capture().mobile.height} />
              <img
                src={capture().desktop.src}
                width={capture().desktop.width}
                height={capture().desktop.height}
                alt={`${current().name} のデモ利用画面`}
                fetchpriority="high"
                decoding="async"
              />
            </picture>
            <div class="selected-app-bottom">
              <p>{current().use}</p>
              <div class="selected-app-actions">
                <a class="action-primary" href={current().install}>インストール <span aria-hidden="true">↗</span></a>
                <a class="action-text" href={current().site}>アプリを見る <span aria-hidden="true">↗</span></a>
              </div>
            </div>
            <p class="selected-app-note">{current().prerequisite} リンク先で内容を確認してから進めます。画像は公開用デモデータの利用画面です。</p>
          </div>
        </div>
      </div>
    </section>
  );
}
