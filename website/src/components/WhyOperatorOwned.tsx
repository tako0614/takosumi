import { For } from "solid-js";
import Section from "./Section";
import { RunHistory } from "./ProductVisuals";

interface Point {
  readonly title: string;
  readonly body: string;
}

const POINTS: readonly Point[] = [
  {
    title: "どのクラウドでも、同じやり方で",
    body: "Cloudflare、AWS、GCP、VM。サービスを選ぶかリンクを貼るだけで、必要な接続と変更内容を先に確認できます。",
  },
  {
    title: "鍵は安全に、履歴は確実に",
    body: "クラウドの認証情報は実行のときだけ渡し、終わったら消します。誰が・いつ・何を変えたかは、すべて記録に残ります。",
  },
  {
    title: "オープンソース、ロックインなし",
    body: "OSS 版は自分で動かせます。あとからクラウドを乗り換えても、同じサービス定義を使い続けられます。",
  },
];

export default function WhyOperatorOwned() {
  return (
    <Section
      id="why"
      title="なぜ Takosumi か。"
      lede={
        <>
          クラウドごとの管理画面に任せきりにすると、鍵は散らばり、変更履歴は追いにくくなります。
          Takosumi は接続・状態・履歴・監査を、
          <em class="em">ひとつの場所</em>で扱います。
        </>
      }
    >
      <div class="why-points">
        <For each={POINTS}>
          {(p) => (
            <div class="why-point">
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          )}
        </For>
      </div>
      <RunHistory />
      <p class="pv-caption">
        デプロイ履歴は実行ごとに残り、いつ・誰が・何を変えたかを
        さかのぼれます。失敗した実行も同じ場所に残るので、原因の確認が
        すぐにできます。
      </p>
    </Section>
  );
}
