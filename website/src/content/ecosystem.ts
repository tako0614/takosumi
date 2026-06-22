export interface Chip {
  readonly label: string;
  readonly hint?: string;
}

// Top layer of the map = examples of what gets deployed ON Takosumi. Lead with
// generic workloads so the "（例）" framing matches the chips; the Takos family
// appears as a clearly-tagged representative subset, not the dominant majority.
export const APPS: readonly Chip[] = [
  { label: "あなたの module", hint: "Git URL" },
  { label: "web / API", hint: "http" },
  { label: "worker / cron", hint: "jobs" },
  { label: "静的サイト", hint: "docs" },
  { label: "takos", hint: "chat (例)" },
  { label: "takos-office", hint: "docs / slide / sheet" },
  { label: "yurucommu", hint: "social (例)" },
  { label: "road-to-me", hint: "coach (例)" },
];

export const PROVIDERS: readonly Chip[] = [
  { label: "Cloudflare", hint: "接続して使う" },
  { label: "AWS", hint: "接続して使う" },
  { label: "GCP", hint: "鍵を預けず実行時だけ注入" },
  { label: "Kubernetes", hint: "既存 provider" },
  { label: "Custom Provider", hint: "generic env" },
];

export const SUBSTRATE = {
  label: "Takosumi",
  description:
    "OpenTofu-native deploy control plane。Capsule / Run / StateVersion / Output を記録し、provider resource は cloud、VM、cluster、管理サービス側に作る。",
};

export const ACCOUNTS = {
  label: "Takosumi Accounts",
  description: "OIDC issuer + account / billing context",
};
