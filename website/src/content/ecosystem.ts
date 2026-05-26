export interface Chip {
  readonly label: string;
  readonly hint?: string;
}

export const APPS: readonly Chip[] = [
  { label: "takos", hint: "chat" },
  { label: "takos-docs", hint: "wiki" },
  { label: "takos-slide", hint: "deck" },
  { label: "takos-excel", hint: "sheet" },
  { label: "takos-computer", hint: "sandbox" },
  { label: "takos-agent", hint: "AI" },
  { label: "yurucommu", hint: "social" },
  { label: "road-to-me", hint: "coach" },
  { label: "あなたの app", hint: "custom" },
];

export const PROVIDERS: readonly Chip[] = [
  { label: "Cloudflare", hint: "Workers / D1 / R2" },
  { label: "AWS", hint: "Fargate / S3 / RDS" },
  { label: "GCP", hint: "Cloud Run / GCS" },
  { label: "Kubernetes", hint: "any cluster" },
  { label: "Deno Deploy", hint: "edge" },
  { label: "Single-host", hint: "docker / systemd" },
];

export const SUBSTRATE = {
  label: "Takosumi",
  description:
    "共通 PaaS 基盤。同じ AppSpec を cloud、VM、cluster、管理サービスへ apply。",
};

export const ACCOUNTS = {
  label: "Takosumi Accounts",
  description: "OIDC issuer + Installation 台帳 (operator distribution)",
};
