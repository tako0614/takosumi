export interface UseCase {
  readonly role: string;
  readonly poweredBy: string;
  readonly note?: string;
}

// What Takosumi deploys: installable Git repo / module outcomes, not bundled
// product categories or internal artifacts.
export const USE_CASES: readonly UseCase[] = [
  { role: "Web サービス / API", poweredBy: "Git repo → Capsule" },
  { role: "Database / state", poweredBy: "repo provisions DB + outputs" },
  { role: "Object store / files", poweredBy: "repo creates bucket + outputs" },
  { role: "Worker / cron", poweredBy: "repo reviewed by plan/apply" },
  { role: "静的サイト / docs", poweredBy: "repo deploys site + URL output" },
  { role: "AI agent runtime", poweredBy: "repo declares runtime resources" },
  { role: "あなたの module", poweredBy: "Git URL + Compatibility Check" },
  { role: "Internal tools", poweredBy: "Git URL + Provider Connection" },
];
