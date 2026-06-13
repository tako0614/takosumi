/**
 * Curated install catalog for `/new` — entries are addressed exactly like any
 * other Git-URL capsule (url / ref / path). This is intentionally a static,
 * easily-edited list: the platform's install model is "any Git URL", so the
 * catalog is just curated starting points, not a registry with special powers.
 *
 * Inclusion rule — an entry must be a REAL standalone capsule: installing it
 * from Takosumi alone (no separate build pipeline, no takos-app installer)
 * must provision something via `tofu plan/apply`. Audited 2026-06 and trimmed
 * accordingly:
 *   - yurucommu / road-to-me: manifest-only takos-app repos (one outputs.tf
 *     carrying `takos_app_manifest`) — installing them here plans ZERO
 *     resources. They belong to the takos product's own app installer.
 *   - providers/cloudflare/modules/* : first-party deployment TEMPLATES whose
 *     module/ expects a runner-built artifact and pipeline-supplied inputs
 *     (`localModulePath`, build commands) — not standalone Git capsules.
 * The catalog grows when purpose-built starter capsule repos exist.
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
    id: "cloudflare-hello-worker",
    git: "https://github.com/tako0614/takosumi.git",
    ref: "main",
    path: "providers/cloudflare/modules/cloudflare-hello-worker/module",
    suggestedName: "hello",
    name: { ja: "Hello Worker（スターター）", en: "Hello Worker (starter)" },
    description: {
      ja: "ビルド不要のスターター。apply だけで Cloudflare Worker が立ち上がり、workers.dev のページ URL が出力されます。まず動くものを 5 分で。",
      en: "A no-build starter: apply alone brings up a Cloudflare Worker and outputs a reachable workers.dev URL. Something live in 5 minutes.",
    },
  },
  {
    id: "takos",
    git: "https://github.com/tako0614/takos.git",
    ref: "main",
    path: "deploy/opentofu",
    suggestedName: "takos",
    name: { ja: "Takos", en: "Takos" },
    description: {
      ja: "AI ファーストのチャット & エージェントの全インフラ（D1 / KV / R2 / Queues / DO）を provision します。アプリ本体の起動には wrangler でのデプロイが別途必要です。",
      en: "Provisions all infrastructure (D1 / KV / R2 / Queues / DO) for the AI-first chat & agent app. Launching the app itself needs a separate wrangler deploy step.",
    },
  },
];
