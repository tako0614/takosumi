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
    desc: "文書・スライド・表計算",
    note: "3 つのツールを 1 つのアプリにまとめたオフィススイート",
    href: "https://github.com/tako0614/takos-office",
    cta: "リポジトリを見る",
  },
  {
    name: "takos-computer",
    desc: "AI サンドボックス環境",
    note: "エージェントをコンテナで動かす実行環境",
    href: "https://github.com/tako0614/takos-computer",
    cta: "リポジトリを見る",
  },
  {
    name: "Yurucommu",
    desc: "セルフホスト ActivityPub SNS",
    note: "自分のドメインで動く連合 SNS",
    href: "https://github.com/tako0614/yurucommu",
    cta: "リポジトリを見る",
  },
  {
    name: "Yurumeet",
    desc: "トーク中心メッセージング",
    note: "同じ yurucommu アカウントをトーク主体の UI で使う",
    href: "https://github.com/tako0614/yurumeet",
    cta: "リポジトリを見る",
  },
  {
    name: "あなたのアプリ",
    desc: "リンクから追加",
    note: "Store または Git URL から追加",
    href: "https://app.takosumi.com/new",
    cta: "Cloud で追加",
  },
];
