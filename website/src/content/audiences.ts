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
      "難しい運用を抱えずに、自分の service を 1 つ deploy したい。docker compose up でも動く。",
    exampleStack: "自分の static site / web service",
    cta: { label: "5 分で動かす", href: "/docs/getting-started/quickstart" },
  },
  {
    name: "Indie hacker / 個人開発者",
    persona:
      "自分の service を Git URL Capsule として登録し、reviewed plan / apply と ProviderConnection policy を残したまま好きな cloud にも VM にも出せる。",
    exampleStack: "web + API + DB を 1 つの module set で",
    cta: {
      label: "Module を install",
      href: "/docs/reference/deploy-control-api",
    },
  },
  {
    name: "小チーム / コミュニティ",
    persona:
      "reviewed な plan と audit trail を付けて、チームの deploy を共有する。",
    exampleStack: "複数 Capsule + 共有 ProviderConnection / policy",
    cta: { label: "Dashboard を開く", href: "https://app.takosumi.com/" },
  },
  {
    name: "学校 / 組織 / 公共",
    persona:
      "private DC でも cloud でも、multi-tenant。監査 / 引っ越し / lock-in 回避が要る。",
    exampleStack: "multi-tenant + 自前 IdP 連携 + audit ledger",
    cta: { label: "operator runbook", href: "/docs/reference/operator" },
  },
];
