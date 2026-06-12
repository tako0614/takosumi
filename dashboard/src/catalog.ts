/**
 * Curated install catalog for `/new` — first-party products and official
 * OpenTofu Capsule modules, addressed exactly like any other Git-URL capsule
 * (url / ref / path). This is intentionally a static, easily-edited list: the
 * platform's install model is "any Git URL", so the catalog is just curated
 * starting points, not a registry with special powers.
 */
import type { Locale } from "./i18n/index.ts";

export interface CatalogEntry {
  readonly id: string;
  readonly git: string;
  readonly ref: string;
  readonly path: string;
  /** Suggested Installation name (pre-fills the name field). */
  readonly suggestedName: string;
  readonly name: Record<Locale, string>;
  readonly description: Record<Locale, string>;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "takos",
    git: "https://github.com/tako0614/takos.git",
    ref: "main",
    path: "deploy/opentofu",
    suggestedName: "takos",
    name: { ja: "Takos", en: "Takos" },
    description: {
      ja: "AI ファーストのチャット & エージェント。chat / agent / memory / space を備えた本体アプリです。",
      en: "AI-first chat & agents — the main app with chat / agent / memory / space.",
    },
  },
  {
    id: "yurucommu",
    git: "https://github.com/tako0614/yurucommu.git",
    ref: "main",
    path: ".",
    suggestedName: "yurucommu",
    name: { ja: "Yurucommu", en: "Yurucommu" },
    description: {
      ja: "ActivityPub 対応のゆるいコミュニティ SNS。",
      en: "A laid-back community social app with ActivityPub.",
    },
  },
  {
    id: "road-to-me",
    git: "https://github.com/tako0614/road-to-me.git",
    ref: "main",
    path: ".",
    suggestedName: "road-to-me",
    name: { ja: "Road to Me", en: "Road to Me" },
    description: {
      ja: "AI と一緒に自分の目標へ向かう、振り返り・伴走アプリ。",
      en: "A reflection & coaching app for working toward your goals with AI.",
    },
  },
  {
    id: "cloudflare-worker-service",
    git: "https://github.com/tako0614/takosumi.git",
    ref: "main",
    path: "providers/cloudflare/modules/cloudflare-worker-service",
    suggestedName: "worker-service",
    name: {
      ja: "Cloudflare Worker サービス",
      en: "Cloudflare Worker service",
    },
    description: {
      ja: "公式モジュール: Cloudflare Worker を 1 つデプロイする最小構成。",
      en: "Official module: a minimal single Cloudflare Worker deployment.",
    },
  },
  {
    id: "cloudflare-static-site",
    git: "https://github.com/tako0614/takosumi.git",
    ref: "main",
    path: "providers/cloudflare/modules/cloudflare-static-site",
    suggestedName: "static-site",
    name: { ja: "静的サイト (Cloudflare)", en: "Static site (Cloudflare)" },
    description: {
      ja: "公式モジュール: 静的サイトを Cloudflare に公開します。",
      en: "Official module: publish a static site on Cloudflare.",
    },
  },
  {
    id: "cloudflare-r2-storage",
    git: "https://github.com/tako0614/takosumi.git",
    ref: "main",
    path: "providers/cloudflare/modules/cloudflare-r2-storage",
    suggestedName: "r2-storage",
    name: { ja: "R2 ストレージ", en: "R2 storage" },
    description: {
      ja: "公式モジュール: Cloudflare R2 バケットを用意します。",
      en: "Official module: provision a Cloudflare R2 bucket.",
    },
  },
];
