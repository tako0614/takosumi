/**
 * Product visuals — real screenshots of the Takosumi dashboard, captured
 * from the running SPA (public/screens). The page argues that Takosumi is a
 * real product; these show the actual screens the copy describes:
 *
 *  - ProductHome:  the app launcher grid (dashboard home)
 *  - PlanReview:   the 変更の確認 screen on an approval-gated run
 *  - RunHistory:   the デプロイ履歴 ledger
 */
import type { JSX } from "solid-js";

function Shot(props: {
  src: string;
  alt: string;
  label: string;
}): JSX.Element {
  return (
    <figure class="pv pv-shot" aria-label={props.label}>
      <img
        src={props.src}
        alt={props.alt}
        width="1600"
        height="1000"
        loading="lazy"
        decoding="async"
      />
    </figure>
  );
}

export function ProductHome(): JSX.Element {
  return (
    <Shot
      src="/screens/home.webp"
      label="Takosumi ダッシュボードのホーム画面"
      alt="Takosumi ダッシュボードの実画面。自分のワークスペースのサイドバーと、インストール済みの 5 つのアプリ (takos, takos-office, takos-computer, yurucommu, road-to-me) が並ぶホーム。"
    />
  );
}

export function PlanReview(): JSX.Element {
  return (
    <Shot
      src="/screens/plan.webp"
      label="変更の確認画面"
      alt="変更の確認画面の実画面。承認待ちバッジ、承認ボタン、作成 2 / 変更 1 / 削除 1 の集計と、変更予定のリソース一覧。"
    />
  );
}

export function RunHistory(): JSX.Element {
  return (
    <Shot
      src="/screens/runs.webp"
      label="デプロイ履歴"
      alt="デプロイ履歴の実画面。デプロイ・変更の確認・内容の取得・ズレの確認の実行記録が、成否と時刻つきで並ぶ。"
    />
  );
}
