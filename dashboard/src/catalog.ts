/**
 * Curated install catalog for `/new` — entries are addressed exactly like any
 * other Git-URL capsule (url / ref / path). This is intentionally a static,
 * easily-edited list: the platform's install model is "any Git URL", so the
 * catalog is just curated starting points, not a registry with special powers.
 *
 * Inclusion rule — an entry must be a REAL standalone capsule: installing it
 * from Takosumi alone (no separate product-specific installer)
 * must provision something via `tofu plan/apply`. Audited 2026-06 and trimmed
 * accordingly:
 *   - product-distribution repos that only publish application metadata rather
 *     than infrastructure are excluded because installing them here would plan
 *     zero resources.
 *   - product distributions such as Takos are linked from their own website via
 *     `/install?git=...`; they are not generic Takosumi starter cards.
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

const TAKOSUMI_CATALOG_REF = "fcc47907b0154d8bf53872a3336e5653fc88792e";

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "cloudflare-hello-worker",
    git: "https://github.com/tako0614/takosumi.git",
    ref: TAKOSUMI_CATALOG_REF,
    path: "providers/cloudflare/modules/cloudflare-hello-worker/module",
    suggestedName: "hello",
    name: { ja: "Hello Worker（スターター）", en: "Hello Worker (starter)" },
    description: {
      ja: "ビルド不要で Cloudflare Worker script を作る接続テスト用スターター。公開 URL が必要な場合は route/dispatcher を追加してください。",
      en: "A no-build connection-test starter that creates a Cloudflare Worker script. Add a route/dispatcher when you need a public URL.",
    },
  },
];
