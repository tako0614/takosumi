import type { TcsListing } from "../../lib/tcs-client.ts";

const now = "2026-07-01T00:00:00.000Z";

const text = (ja: string, en: string) => ({ ja, en });

// Dashboard-local installable app links into Git-hosted OpenTofu Capsules. These are not
// Takosumi-owned platform services or privileged platform surfaces.
export const installableAppStoreListings: readonly TcsListing[] = [
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
    provider: "cloudflare",
    category: "social",
    suggestedName: "yurucommu",
    name: text("yurucommu", "yurucommu"),
    description: text(
      "自分用のコミュニティ / ActivityPub アプリをホストします。",
      "Host a personal community / ActivityPub app.",
    ),
    badge: text("追加候補", "Installable"),
    inputs: [
      {
        name: "project_name",
        type: "string",
        defaultValue: "service-name-with-space",
        label: text("サービス名", "Service name"),
      },
      {
        name: "enable_cloudflare_resources",
        type: "boolean",
        defaultValue: "true",
        label: text("Cloudflare リソースを作成", "Create Cloudflare resources"),
      },
      {
        name: "enable_cloudflare_worker_script",
        type: "boolean",
        defaultValue: "true",
        label: text("Worker を公開", "Publish Worker"),
      },
      {
        name: "worker_bundle_url",
        type: "string",
        defaultValue:
          "https://github.com/tako0614/yurucommu/releases/download/v2.0.0/takos-worker.js",
        label: text("Worker artifact URL", "Worker artifact URL"),
      },
      {
        name: "worker_bundle_sha256",
        type: "string",
        defaultValue:
          "5a5713b2cc548414951c51a469b32bdba756d2101933575d0ab230131eaa8c95",
        label: text("Worker artifact SHA-256", "Worker artifact SHA-256"),
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
      resolvedCommit: "a4d0375aee7cb7466db6f5d4512ef65eda16e8b9",
    },
    kind: "app",
    surface: "service",
    provider: "cloudflare",
    category: "workspace",
    suggestedName: "takos",
    name: text("Takos", "Takos"),
    description: text(
      "AI ワークスペースを自分の環境にホストします。",
      "Host the Takos AI workspace in your own environment.",
    ),
    badge: text("追加候補", "Installable"),
    inputs: [
      {
        name: "project_name",
        type: "string",
        defaultValue: "service-name-with-space",
        label: text("サービス名", "Service name"),
      },
      {
        name: "release_container_images",
        type: "json",
        defaultValue:
          '{"runtime":"registry.cloudflare.com/a10162d23653f1ad1193dabf520a5dd0/takos-worker-runtime:0.10.0-bfdd9f8bb79c","executor":"registry.cloudflare.com/a10162d23653f1ad1193dabf520a5dd0/takos-agent-executor:0.10.0-bfdd9f8bb79c"}',
        label: text("Release container images", "Release container images"),
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
