export interface UseCase {
  readonly role: string;
  readonly poweredBy: string;
  readonly note?: string;
}

// What Takosumi deploys — workload categories, not products. Takos and its
// bundled apps are listed as ONE example of something that runs on Takosumi,
// never as a Takosumi feature.
export const USE_CASES: readonly UseCase[] = [
  { role: "Web サービス / API", poweredBy: "OpenTofu module → Installation" },
  { role: "Database / state", poweredBy: "provider + state backend" },
  { role: "Object store / files", poweredBy: "provider → DeploymentOutput" },
  { role: "Worker / cron", poweredBy: "OpenTofu module → ApplyRun" },
  { role: "静的サイト / docs", poweredBy: "OpenTofu module → Deployment" },
  { role: "AI agent runtime", poweredBy: "OpenTofu module" },
  { role: "あなたの module", poweredBy: "Git URL を渡すだけ" },
  {
    role: "Takos と bundled apps",
    poweredBy: "Takosumi 上のプロダクト例",
    note: "chat / docs / agent —— Takosumi が deploy する代表例",
  },
];
