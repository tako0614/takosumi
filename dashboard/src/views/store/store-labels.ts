import type { TcsLocale } from "../../lib/tcs-aggregate.ts";

const CATEGORY_LABELS: Record<string, { ja: string; en: string }> = {
  service: { ja: "アプリ", en: "Apps" },
  building_block: { ja: "基盤", en: "Building blocks" },
  example: { ja: "サンプル", en: "Examples" },
  personal: { ja: "パーソナル", en: "Personal" },
  productivity: { ja: "仕事・文書", en: "Productivity" },
  social: { ja: "コミュニティ", en: "Community" },
  starter: { ja: "スターター", en: "Starters" },
  storage: { ja: "ストレージ", en: "Storage" },
  tools: { ja: "ツール", en: "Tools" },
  workspace: { ja: "ワークスペース", en: "Workspace" },
};

const KIND_LABELS: Record<string, { ja: string; en: string }> = {
  app: { ja: "アプリ", en: "App" },
  worker: { ja: "Webアプリ", en: "Web app" },
  storage: { ja: "ストレージ", en: "Storage" },
  site: { ja: "Webサイト", en: "Website" },
};

const PROVIDER_LABELS: Record<string, string> = {
  aws: "AWS",
  cloudflare: "Cloudflare",
  digitalocean: "DigitalOcean",
  gcp: "Google Cloud",
  google: "Google Cloud",
  hcloud: "Hetzner",
  hetzner: "Hetzner",
  openstack: "OpenStack",
  scaleway: "Scaleway",
  takosumi: "Takosumi",
  vultr: "Vultr",
};

const BADGE_LABELS: Record<string, { ja: string; en: string }> = {
  official: { ja: "公式", en: "Official" },
};

function localized(
  value: { ja: string; en: string } | undefined,
  locale: TcsLocale,
): string | undefined {
  if (!value) return undefined;
  return locale === "ja" ? value.ja : value.en;
}

function readableToken(value: string): string {
  const cleaned = value.trim().replace(/[_-]+/g, " ");
  if (!cleaned) return value;
  return cleaned
    .split(/\s+/)
    .map((part) =>
      /^[a-z]/.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part,
    )
    .join(" ");
}

export function tcsCategoryLabel(value: string, locale: TcsLocale): string {
  return localized(CATEGORY_LABELS[value], locale) ?? readableToken(value);
}

export function tcsKindLabel(value: string, locale: TcsLocale): string {
  return localized(KIND_LABELS[value], locale) ?? readableToken(value);
}

export function tcsProviderLabel(value: string): string {
  return PROVIDER_LABELS[value.toLowerCase()] ?? readableToken(value);
}

export function tcsBadgeLabel(value: string, locale: TcsLocale): string {
  return (
    localized(BADGE_LABELS[value.toLowerCase()], locale) ?? readableToken(value)
  );
}
