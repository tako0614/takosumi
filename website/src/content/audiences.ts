export interface Audience {
  readonly name: string;
  readonly persona: string;
  readonly exampleStack: string;
  readonly cta: { readonly label: string; readonly href: string };
}

export const AUDIENCES: readonly Audience[] = [
  {
    name: "はじめての人",
    persona:
      "コード 1 行 書けなくても、 自分の Space を 1 つ持ちたい。 docker compose up すれば動く。",
    exampleStack: "chat (takos) + docs (takos-docs)",
    cta: { label: "5 分で動かす", href: "/docs/getting-started/quickstart" },
  },
  {
    name: "Indie hacker / 個人開発者",
    persona:
      "自分のサービスを operator-owned runtime に置きたい。SaaS に閉じず、自分で書いた app も同じ Space に入れる。",
    exampleStack: "chat + agent + 自作 worker + DB",
    cta: { label: "Source を install", href: "/docs/reference/installer-api" },
  },
  {
    name: "小チーム / コミュニティ",
    persona:
      "メンバー間で 共有する Space。 docs も slide も excel も、 全部 同じ Takosumi 上で。",
    exampleStack: "chat + docs + slide + excel + agent",
    cta: { label: "Cloud で試す", href: "https://accounts.takosumi.com/" },
  },
  {
    name: "学校 / 組織 / 公共",
    persona:
      "大規模 multi-tenant、private DC でも cloud でも。監査 / 引っ越し / lock-in 回避が必要。",
    exampleStack: "全 bundled apps + custom resource + 自前 IdP 連携",
    cta: { label: "operator runbook", href: "/docs/operator/" },
  },
];
