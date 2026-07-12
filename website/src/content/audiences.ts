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
    exampleStack: "自分の静的サイト / Web サービス",
    cta: { label: "Cloud を開く", href: "https://app.takosumi.com/" },
  },
  {
    name: "Indie hacker / 個人開発者",
    persona:
      "自分のサービスをリンクから登録して、変更の確認と接続の履歴を残したまま、好きなクラウドや VM に公開したい。",
    exampleStack: "Web + API + DB をひとつの構成で",
    cta: {
      label: "クイックスタート",
      href: "/docs/reference/deploy-control-api",
    },
  },
  {
    name: "小チーム / コミュニティ",
    persona:
      "確認済みの変更と監査ログを残しながら、チームの公開作業を共有したい。",
    exampleStack: "複数のサービス + 共有の接続・ポリシー",
    cta: { label: "Dashboard を開く", href: "https://app.takosumi.com/" },
  },
  {
    name: "学校 / 組織 / 公共",
    persona:
      "自前のデータセンターでもクラウドでも、マルチテナントで運用したい。監査と、あとから引っ越せる自由も必要。",
    exampleStack: "マルチテナント + 自前 IdP 連携 + 監査ログ",
    cta: { label: "Operator 向けドキュメント", href: "/docs/reference/operator" },
  },
];
