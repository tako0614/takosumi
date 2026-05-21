export interface UseCase {
  readonly role: string;
  readonly poweredBy: string;
  readonly note?: string;
}

export const USE_CASES: readonly UseCase[] = [
  { role: "Chat & community", poweredBy: "takos" },
  { role: "Docs & wiki", poweredBy: "takos-docs" },
  { role: "Spreadsheet", poweredBy: "takos-excel" },
  { role: "Slides & presentation", poweredBy: "takos-slide" },
  { role: "AI agent", poweredBy: "takos-agent" },
  { role: "Sandbox computer", poweredBy: "takos-computer" },
  { role: "Goal tracker & coach", poweredBy: "road-to-me" },
  { role: "ActivityPub social", poweredBy: "yurucommu" },
  { role: "Files & storage", poweredBy: "object-store kind" },
  {
    role: "Custom resource",
    poweredBy: ".takosumi.yml で自作",
    note: "JSON-LD で 新 kind を 定義",
  },
];
