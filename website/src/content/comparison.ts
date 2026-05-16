export interface Row {
  readonly axis: string;
  readonly us: string;
  readonly vendor: string;
  readonly tfHelm: string;
  readonly raw: string;
}

export const COMPARISON: readonly Row[] = [
  {
    axis: "Substrate selection",
    us: "AWS / GCP / Azure / CF / K8s / docker / systemd / bare-metal",
    vendor: "vendor-locked",
    tfHelm: "you wire each provider yourself",
    raw: "manual per host",
  },
  {
    axis: "Apply API",
    us: "single POST /v1/deployments",
    vendor: "vendor-specific dashboard / API",
    tfHelm: "terraform apply / helm upgrade",
    raw: "ssh + scripts",
  },
  {
    axis: "Credential boundary",
    us: "runtime-agent 限定 (kernel に流さない)",
    vendor: "vendor 側に丸投げ",
    tfHelm: "TF state に残る場合がある",
    raw: "ホストに散らばる",
  },
  {
    axis: "Self-host",
    us: "single deno install",
    vendor: "不可",
    tfHelm: "可能だが state backend を別途",
    raw: "可能 (構成あなた次第)",
  },
  {
    axis: "Plugin model",
    us: "JSR 経由で operator が選定",
    vendor: "vendor 提供 plugin のみ",
    tfHelm: "registry / chart 経由",
    raw: "—",
  },
];
