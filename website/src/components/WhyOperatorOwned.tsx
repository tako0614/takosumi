import { For } from "solid-js";
import Section from "./Section";

interface Point {
  readonly title: string;
  readonly body: string;
}

const POINTS: readonly Point[] = [
  {
    title: "どのクラウドでも、同じやり方で",
    body: "AWS、GCP、Cloudflare、Kubernetes。Git の URL を登録するだけで、どこにでも同じ手順で deploy。専用の設定ファイルは要りません。",
  },
  {
    title: "鍵は安全に、履歴は確実に",
    body: "クラウドの認証情報は deploy の瞬間だけ渡して、終わったら消します。誰が・いつ・何を変えたかは、すべて記録に残ります。",
  },
  {
    title: "オープンソース、ロックインなし",
    body: "コードは全部公開。セルフホストなら無料。あとからクラウドを乗り換えても、同じコードでそのまま動きます。",
  },
];

export default function WhyOperatorOwned() {
  return (
    <Section
      id="why"
      title="なぜ Takosumi か。"
      lede={
        <>
          deploy
          がクラウドのダッシュボードに縛られると、鍵は散らばり、履歴は追えなくなる。
          Takosumi は鍵・状態・履歴・監査を、
          <em class="em">あなたの手元の一箇所</em>にまとめます。
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
