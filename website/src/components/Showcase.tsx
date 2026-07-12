import { For } from "solid-js";
import Section from "./Section";

interface Step {
  readonly title: string;
  readonly body: string;
}

const STEPS: readonly Step[] = [
  {
    title: "サービスを選ぶ",
    body: "スターターを選ぶか、自分のサービスのリンクを貼ります。専用の設定ファイルを増やさずに始められます。",
  },
  {
    title: "クラウド接続を選ぶ",
    body: "公開先のクラウドと認証情報を結びつけます。鍵は安全に保管され、実行のときだけ渡されます。",
  },
  {
    title: "変更内容を確認して公開",
    body: "作成・更新されるリソースを確認してから承認します。結果・状態・履歴・監査ログは自動で残ります。",
  },
];

export default function Showcase() {
  return (
    <Section
      id="how"
      title="3 ステップでホスト。"
      lede={
        <>
          難しい設定は前面に出しません。サービスを選び、接続して、変更内容を確認するだけ。
          <em class="em">ダッシュボードから</em>、すべて完結します。
        </>
      }
    >
      <ol class="cta-flow">
        <For each={STEPS}>
          {(s, i) => (
            <li>
              <span>{i() + 1}</span>
              <strong>{s.title}</strong>
              <p>{s.body}</p>
            </li>
          )}
        </For>
      </ol>
    </Section>
  );
}
