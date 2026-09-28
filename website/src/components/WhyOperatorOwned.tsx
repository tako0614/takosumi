import { For } from "solid-js";
import Section from "./Section";

const POINTS: readonly string[] = [
  "リソースは各 provider に、管理データは Takosumi の設置先に残る",
  "Cloudflare・AWS・GCP・VM — どのクラウドでも同じやり方",
  "認証情報は実行のときだけ渡し、終わったら消す",
  "誰が・いつ・何を変えたかはすべて監査ログに残る",
  "OSS 版は自分で動かせる — 別のクラウドへ移っても同じサービス定義を使える",
  "標準の OpenTofu module / provider で、あとから引っ越せる",
];

export default function WhyOperatorOwned() {
  return (
    <Section
      id="why"
      title="何を管理するか"
      lede={
        <>
          クラウドごとの管理画面に任せると、鍵は散らばり変更履歴は追いにくい。Takosumi
          は接続・状態・履歴・監査をひとつの場所で扱う。
        </>
      }
    >
      <ul class="fact-list">
        <For each={POINTS}>{(p) => <li>{p}</li>}</For>
      </ul>
    </Section>
  );
}
