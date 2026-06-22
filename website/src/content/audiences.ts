export interface Audience {
  readonly name: string;
  readonly persona: string;
  readonly exampleStack: string;
  readonly cta: { readonly label: string; readonly href: string };
}

// Who deploys on Takosumi — framed around owning your deploys. Takos appears
// only as an optional thing you can deploy.
export const AUDIENCES: readonly Audience[] = [
  {
    name: "はじめての人",
    persona:
      "難しい運用を抱えずに、自分のサービスを 1 つホストしたい。",
    exampleStack: "自分の static site / web service",
    cta: { label: "Cloud を開く", href: "https://app.takosumi.com/" },
  },
  {
    name: "Indie hacker / 個人開発者",
    persona:
      "自分のサービスをリンクから登録し、変更確認と接続履歴を残したまま好きな cloud や VM に出せる。",
    exampleStack: "web + API + DB を 1 つの module set で",
    cta: {
      label: "Quickstart",
      href: "/docs/reference/deploy-control-api",
    },
  },
  {
    name: "小チーム / コミュニティ",
    persona:
      "確認済みの変更と audit trail を付けて、チームの公開作業を共有する。",
    exampleStack: "複数サービス + 共有接続 / policy",
    cta: { label: "Dashboard を開く", href: "https://app.takosumi.com/" },
  },
  {
    name: "学校 / 組織 / 公共",
    persona:
      "private DC でも cloud でも、multi-tenant。監査 / 引っ越し / lock-in 回避が要る。",
    exampleStack: "multi-tenant + 自前 IdP 連携 + audit ledger",
    cta: { label: "Operator reference", href: "/docs/reference/operator" },
  },
];
