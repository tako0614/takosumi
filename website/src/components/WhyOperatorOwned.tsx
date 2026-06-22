import { For } from "solid-js";
import Section from "./Section";

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
    body: "クラウドの認証情報は実行時だけ渡して、終わったら消します。誰が・いつ・何を変えたかは、すべて記録に残ります。",
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
          クラウドごとの管理画面に任せきりにすると、鍵は散らばり、変更履歴は追いにくくなる。
          Takosumi は接続・状態・履歴・監査を、
          <em class="em">ひとつの場所</em>で扱います。
        </>
      }
    >
      <div class="why-points">
        <For each={POINTS}>
          {(p, i) => (
            <div class="why-point">
              <span class="why-num">{String(i() + 1).padStart(2, "0")}</span>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          )}
        </For>
      </div>
    </Section>
  );
}
