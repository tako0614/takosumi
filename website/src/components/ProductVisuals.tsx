/**
 * Product visuals — real screenshots of the Takosumi dashboard, captured
 * from the running SPA (public/screens). Rendered plain: full width, no
 * frame chrome, no caption.
 *
 *  - ProductHome:  the app launcher grid (dashboard home)
 *  - PlanReview:   the 変更の確認 screen on an approval-gated run
 *  - RunHistory:   the デプロイ履歴 ledger
 */
import type { JSX } from "solid-js";

export function ProductShot(props: {
  src: string;
  alt: string;
  w?: number;
  h?: number;
  hero?: boolean;
}): JSX.Element {
  return (
    <img
      class={props.hero ? "shot shot-hero" : "shot"}
      src={props.src}
      alt={props.alt}
      width={props.w ?? 1600}
      height={props.h ?? 1000}
      decoding="async"
    />
  );
}

export function PlanReview(): JSX.Element {
  return (
    <ProductShot
      src="/screens/plan.webp"
      alt="変更の確認画面の実画面。承認待ちバッジ、承認ボタン、作成 2 / 変更 1 / 削除 1 の集計と、変更予定のリソース一覧。"
    />
  );
}

export function RunHistory(): JSX.Element {
  return (
    <ProductShot
      src="/screens/runs.webp"
      w={1600}
      h={720}
      alt="デプロイ履歴の実画面。デプロイ・変更の確認・内容の取得・ズレの確認の実行記録が、成否と時刻つきで並ぶ。"
    />
  );
}
