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
    href: "https://takos.jp/",
    cta: "Takos を見る",
  },
  {
    name: "Takos Office",
    desc: "docs / slide / sheet",
    note: "1 つの worker に統合された office suite",
    href: "https://github.com/tako0614/takos-apps/tree/main/takos-office",
    cta: "リポジトリを見る",
  },
  {
    name: "takos-computer",
    desc: "AI サンドボックス環境",
    note: "コンテナ化されたエージェント実行基盤",
    href: "https://github.com/tako0614/takos-apps/tree/main/takos-computer",
    cta: "リポジトリを見る",
  },
  {
    name: "Yurucommu",
    desc: "セルフホスト ActivityPub SNS",
    note: "自分のドメインで動く連合 SNS",
    href: "https://github.com/tako0614/yurucommu-core",
    cta: "リポジトリを見る",
  },
  {
    name: "Road to Me",
    desc: "AI ライフプランナー",
    note: "長期目標を逆算して計画・実行",
    href: "https://github.com/tako0614/road-to-me",
    cta: "リポジトリを見る",
  },
  {
    name: "あなたのアプリ",
    desc: "リンクから追加",
    note: "サービス定義を確認してから公開",
    href: "https://app.takosumi.com/new?mode=link",
    cta: "Cloud で追加",
  },
];
