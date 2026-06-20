export interface UseCase {
  readonly name: string;
  readonly desc: string;
  readonly note: string;
  readonly href: string;
  readonly cta: string;
}

export const USE_CASES: readonly UseCase[] = [
  {
    name: "Takos",
    desc: "AI ワークスペース",
    note: "チャット・エージェント・メモリ・アプリ一覧を統合",
    href: "https://github.com/tako0614/takos",
    cta: "リポジトリを見る",
  },
  {
    name: "Takos Docs",
    desc: "ドキュメントエディタ",
    note: "ブラウザベース・AI 連携対応",
    href: "https://github.com/tako0614/takos-docs",
    cta: "install する",
  },
  {
    name: "Takos Slide",
    desc: "プレゼンテーションエディタ",
    note: "ブラウザベース・AI 連携対応",
    href: "https://github.com/tako0614/takos-slide",
    cta: "install する",
  },
  {
    name: "Takos Excel",
    desc: "スプレッドシートエディタ",
    note: "ブラウザベース・AI 連携対応",
    href: "https://github.com/tako0614/takos-excel",
    cta: "install する",
  },
  {
    name: "takos-computer",
    desc: "AI サンドボックス環境",
    note: "コンテナ化されたエージェント実行基盤",
    href: "https://github.com/tako0614/takos-computer",
    cta: "install する",
  },
  {
    name: "Yurucommu",
    desc: "セルフホスト ActivityPub SNS",
    note: "自分のドメインで動く連合 SNS",
    href: "https://github.com/tako0614/yurucommu",
    cta: "install する",
  },
  {
    name: "Road to Me",
    desc: "AI ライフプランナー",
    note: "長期目標を逆算して計画・実行",
    href: "https://github.com/tako0614/road-to-me",
    cta: "install する",
  },
  {
    name: "あなたのアプリ",
    desc: "Git URL → deploy",
    note: "OpenTofu / Terraform ならなんでも",
    href: "/docs/getting-started/quickstart",
    cta: "始める",
  },
];
