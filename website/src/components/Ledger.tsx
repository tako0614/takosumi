import { For, type JSX } from "solid-js";
import { ProductShot } from "./ProductVisuals";

interface LedgerRecord {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly meta: string;
  readonly status: "ok" | "review";
  readonly src: string;
  readonly w: number;
  readonly h: number;
  readonly alt: string;
  readonly cap: string;
}

/** The deploy lifecycle as the product's own ledger — three real records:
 *  what is installed, the diff awaiting approval, the history it left.
 *  Each gets a mono header row (status dot + name + meta) like the
 *  product's own run rows, then the real screen, then one caption. */
const RECORDS: readonly LedgerRecord[] = [
  {
    id: "apps",
    label: "apps",
    name: "インストール済みサービス",
    meta: "installed: 5",
    status: "ok",
    src: "/screens/home.webp",
    w: 1600,
    h: 1000,
    alt: "Takosumi ダッシュボードの実画面。ワークスペースのサイドバーと、インストール済みの 5 つのサービス (takos, takos-office, takos-computer, yurucommu, road-to-me) が並ぶホーム。",
    cap: "サービスを選ぶか Git URL を貼ると、Workspace の home に tile が並ぶ。",
  },
  {
    id: "plan",
    label: "plan",
    name: "変更の確認",
    meta: "+2 ~1 −1 · approval required",
    status: "review",
    src: "/screens/plan.webp",
    w: 1600,
    h: 1000,
    alt: "変更の確認画面の実画面。承認待ちバッジ、承認ボタン、作成 2 / 変更 1 / 削除 1 の集計と、変更予定のリソース一覧。",
    cap: "公開前に、作成・変更・削除されるリソースをすべて見せる。承認しない限り何も実行されない。",
  },
  {
    id: "runs",
    label: "runs",
    name: "デプロイ履歴",
    meta: "すべて成功",
    status: "ok",
    src: "/screens/runs.webp",
    w: 1600,
    h: 720,
    alt: "デプロイ履歴の実画面。デプロイ・変更の確認・内容の取得・ズレの確認の実行記録が、成否と時刻つきで並ぶ。",
    cap: "結果・状態・履歴・監査ログはすべてこの台帳に残り、あとから誰が何を変えたか追える。",
  },
];

export default function Ledger(): JSX.Element {
  return (
    <section id="flow" class="ledger">
      <div class="container">
        <For each={RECORDS}>
          {(r) => (
            <figure class="record">
              <figcaption class="record-head">
                <span class={"rec-dot rec-" + r.status} aria-hidden="true" />
                <span class="rec-label">{r.label}</span>
                <span class="rec-name">{r.name}</span>
                <span class="rec-meta">{r.meta}</span>
              </figcaption>
              <ProductShot src={r.src} alt={r.alt} w={r.w} h={r.h} />
              <p class="record-cap">{r.cap}</p>
            </figure>
          )}
        </For>
      </div>
    </section>
  );
}
