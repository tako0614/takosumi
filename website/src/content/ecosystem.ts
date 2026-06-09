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
  { label: "takos-docs", hint: "wiki (例)" },
  { label: "yurucommu", hint: "social (例)" },
  { label: "road-to-me", hint: "coach (例)" },
];

export const PROVIDERS: readonly Chip[] = [
  { label: "Cloudflare", hint: "managed default" },
  { label: "AWS", hint: "Space Connection" },
  { label: "GCP", hint: "Space Connection" },
  { label: "Kubernetes", hint: "Space Connection" },
  { label: "Custom Provider", hint: "Space / self-host" },
];

export const SUBSTRATE = {
  label: "Takosumi",
  description:
    "OpenTofu-native deploy control plane。Run / Deployment / OutputSnapshot を cloud、VM、cluster、管理サービスへ記録。",
};

export const ACCOUNTS = {
  label: "Takosumi Accounts",
  description: "OIDC issuer + Installation 台帳 (operator distribution)",
};
