export interface FeaturedApp {
  readonly id: "takos" | "yurucommu" | "office";
  readonly name: string;
  readonly category: string;
  readonly summary: string;
  readonly use: string;
  readonly prerequisite: string;
  readonly site: string;
  readonly install: string;
}

function installLink(git: string, ref: string, path: string, name: string): string {
  const url = new URL("https://app.takosumi.com/install");
  url.searchParams.set("git", git);
  url.searchParams.set("ref", ref);
  url.searchParams.set("path", path);
  url.searchParams.set("name", name);
  return url.toString();
}

/** Fixed, published revisions with module paths checked in their owning repositories. */
export const FEATURED_APPS: readonly FeaturedApp[] = [
  {
    id: "takos",
    name: "Takos",
    category: "AI workspace",
    summary: "自分の道具を持ち込める、AI の作業場所。",
    use: "会話から道具を呼び出し、作業を続ける。",
    prerequisite: "Cloudflare の接続と、公開先などの設定が必要です。",
    site: "https://takos.jp/",
    install: installLink("https://github.com/tako0614/takos.git", "v0.12.7", "deploy/opentofu/cloudflare", "takos"),
  },
  {
    id: "yurucommu",
    name: "Yurucommu",
    category: "Social",
    summary: "自分の場所からつながる、連合 SNS。",
    use: "投稿や会話を、自分のコミュニティで楽しむ。",
    prerequisite: "対応する接続、ドメインなどの設定が必要です。",
    site: "https://yurucommu.com/",
    install: installLink("https://github.com/tako0614/yurucommu.git", "a17e4f883cb9ba79e6d0650b497d8d97453c698f", "deploy/takoform", "Yurucommu"),
  },
  {
    id: "office",
    name: "Takos Office",
    category: "Productivity",
    summary: "文書・スライド・表計算をひとつに。",
    use: "ファイルを作り、編集し、手元の仕事を進める。",
    prerequisite: "Cloudflare の接続と、保存先などの設定が必要です。",
    site: "https://office.takos.jp/",
    install: installLink("https://github.com/tako0614/takos-office.git", "v0.3.1", ".", "Takos Office"),
  },
];
