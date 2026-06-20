import { For } from "solid-js";
import Section from "./Section";

interface Step {
  readonly title: string;
  readonly body: string;
}

const STEPS: readonly Step[] = [
  {
    title: "Git の URL を貼る",
    body: "既存の OpenTofu / Terraform リポジトリを、そのまま登録。専用の設定ファイルも、書き換えも要りません。",
  },
  {
    title: "クラウド接続を選ぶ",
    body: "deploy 先のクラウドと認証情報を結びつけます。鍵は安全に保管され、実行のときだけ渡されます。",
  },
  {
    title: "plan を確認して deploy",
    body: "変更内容を plan で確かめてから適用。結果・状態・履歴・監査ログは、ぜんぶ自動で残ります。",
  },
];

export default function Showcase() {
  return (
    <Section
      id="how"
      title="3 ステップで deploy。"
      lede={
        <>
          むずかしい設定はいりません。Git の URL を貼って、接続を選んで、plan
          を確認するだけ。
          <em class="em">ダッシュボードから</em>、ぜんぶ完結します。
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
