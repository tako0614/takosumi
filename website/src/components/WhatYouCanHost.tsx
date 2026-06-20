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
        <h2>何でも deploy できる。</h2>
        <p class="lede">
          これらはすべて Takosumi で
          <em class="em">実際に deploy されているプロダクト</em>
          です。どれもただの OpenTofu / Terraform——同じ手順で、あなたのアプリも
          deploy できます。
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
