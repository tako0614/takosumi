import { For } from "solid-js";
import { USE_CASES } from "~/content/use-cases";

function Card(props: { u: (typeof USE_CASES)[number] }) {
  return (
    <a class="product-card" href={props.u.href} rel="noopener">
      <div class="product-card-body">
        <h3>{props.u.name}</h3>
        <p class="product-desc">{props.u.desc}</p>
        <p class="product-note">{props.u.note}</p>
      </div>
      <span class="product-cta">
        {props.u.cta} <span aria-hidden="true">→</span>
      </span>
    </a>
  );
}

export default function WhatYouCanHost() {
  return (
    <section id="what" class="product-belt-section">
      <div class="container">
        <h2>スターターから、自分のサービスまで。</h2>
        <p class="lede">
          公式スターターも、自分の Git リポジトリも、同じ
          <em class="em">サービス</em>
          として扱います。Takosumi は、必要な接続と変更内容を先に見せてから公開します。
        </p>
      </div>
      <div class="product-belt" aria-label="プロダクト一覧">
        <div class="product-belt-track">
          <For each={USE_CASES}>{(u) => <Card u={u} />}</For>
          <For each={USE_CASES}>{(u) => <Card u={u} />}</For>
        </div>
      </div>
    </section>
  );
}
