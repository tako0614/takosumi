import { For } from "solid-js";
import Section from "./Section";
import { PlanReview } from "./ProductVisuals";

interface Step {
  readonly title: string;
  readonly body: string;
}

const STEPS: readonly Step[] = [
  {
    title: "サービスを選ぶ",
    body: "スターターを選ぶか、自分のサービスのリンクを貼る。専用の設定ファイルを増やさずに始められる。",
  },
  {
    title: "クラウド接続を選ぶ",
    body: "公開先のクラウドと認証情報を結びつける。鍵は安全に保管され、実行のときだけ渡される。",
  },
  {
    title: "変更内容を確認して公開",
    body: "作成・更新・削除されるリソースを確認してから承認する。結果・状態・履歴・監査ログは自動で残る。",
  },
];

export default function Showcase() {
  return (
    <Section
      id="how"
      title="使い方"
      lede={
        <>
          サービスを選び、接続を結び、変更内容を確認して公開する。すべてダッシュボードから。
        </>
      }
    >
      <For each={STEPS}>
        {(s) => (
          <div class="step">
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </div>
        )}
      </For>
      <PlanReview />
    </Section>
  );
}
