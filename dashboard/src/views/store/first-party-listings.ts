import type { TcsListing } from "../../lib/tcs-client.ts";

const now = "2026-07-01T00:00:00.000Z";

const text = (ja: string, en: string) => ({ ja, en });

export const firstPartyStoreListings: readonly TcsListing[] = [
  {
    id: "yurucommu",
    source: {
      git: "https://github.com/tako0614/yurucommu.git",
      ref: "main",
      path: ".",
      resolvedCommit: "5bace37eac259d1aa1b313b3ded31c03c518c1b8",
    },
    kind: "app",
    surface: "service",
    provider: "takosumi",
    category: "social",
    suggestedName: "yurucommu",
    name: text("yurucommu", "yurucommu"),
    description: text(
      "自分用のコミュニティ / ActivityPub アプリをホストします。",
      "Host a personal community / ActivityPub app.",
    ),
    badge: text("公式アプリ", "Official app"),
    inputs: [
      {
        name: "project_name",
        type: "string",
        defaultValue: "service-name-with-space",
        label: text("サービス名", "Service name"),
      },
    ],
    outputAllowlist: [
      { key: "url", from: "url", type: "url", required: false },
      {
        key: "app_deployment",
        from: "app_deployment",
        type: "json",
        required: false,
      },
    ],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "takos",
    source: {
      git: "https://github.com/tako0614/takos.git",
      ref: "main",
      path: "deploy/opentofu",
      resolvedCommit: "3e8b7eeb04c85b6e73b7187b5c7baa269338394e",
    },
    kind: "app",
    surface: "service",
    provider: "takosumi",
    category: "workspace",
    suggestedName: "takos",
    name: text("Takos", "Takos"),
    description: text(
      "AI ワークスペースを自分の環境にホストします。",
      "Host the Takos AI workspace in your own environment.",
    ),
    badge: text("公式アプリ", "Official app"),
    inputs: [
      {
        name: "project_name",
        type: "string",
        defaultValue: "service-name-with-space",
        label: text("サービス名", "Service name"),
      },
    ],
    outputAllowlist: [
      { key: "url", from: "url", type: "url", required: false },
      {
        key: "app_deployment",
        from: "app_deployment",
        type: "json",
        required: false,
      },
    ],
    createdAt: now,
    updatedAt: now,
  },
];
