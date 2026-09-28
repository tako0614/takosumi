import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const officeRoot = resolve(process.env.TAKOS_OFFICE_ROOT || resolve(root, "../takos-office"));
const output = resolve(here, "../public/screens");
const origin = "http://127.0.0.1:5198";
const timestamp = "2026-08-01T00:00:00.000Z";
const themes = process.env.CAPTURE_THEME ? [process.env.CAPTURE_THEME] : ["light", "dark"];
if (themes.some((theme) => theme !== "light" && theme !== "dark")) throw new Error("CAPTURE_THEME must be light or dark");
const document = {
  id: "demo-progress",
  title: "今週の進捗メモ",
  content: JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "今週の進捗メモ" }] },
      { type: "paragraph", content: [{ type: "text", text: "チームで使う道具の更新を整理します。" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "進んだこと" }] },
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "作業ノートの画面構成を見直した" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "共有文書に決定事項を反映" }] }] },
      ] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "次に確認すること" }] },
      { type: "paragraph", content: [{ type: "text", text: "未決定の項目と担当者を確認する。" }] },
    ],
  }),
  createdAt: timestamp,
  updatedAt: timestamp,
};

async function ready(child) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`Office Vite exited ${child.exitCode}`);
    try {
      if ((await fetch(`${origin}/docs/`)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Office Vite did not become ready");
}

async function main() {
  await mkdir(output, { recursive: true });
  const server = spawn("bunx", ["vite", "--host", "127.0.0.1", "--port", "5198", "--strictPort"], {
    cwd: resolve(officeRoot, "app/docs"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (chunk) => { log += chunk.toString(); });
  server.stderr.on("data", (chunk) => { log += chunk.toString(); });
  let browser;
  try {
    await ready(server);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const theme of themes) for (const [variant, viewport] of [
      ["desktop", { width: 1000, height: 680 }],
      ["mobile", { width: 390, height: 620 }],
    ]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ja-JP", colorScheme: theme });
      const page = await context.newPage();
      const requested = new Set();
      await page.route("**/docs/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        requested.add(path);
        if (route.request().method() !== "GET") return route.abort("blockedbyclient");
        if (path === "/docs/api/documents/demo-progress") return route.fulfill({ json: document });
        if (path === "/docs/api/documents") return route.fulfill({ json: [document] });
        if (path === "/docs/api/auth/me") return route.fulfill({ json: { subject: "demo", name: "デモユーザー" } });
        return route.fulfill({ json: {} });
      });
      await page.goto(`${origin}/docs/demo-progress`, { waitUntil: "networkidle" });
      await page.getByText("進んだこと", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: resolve(output, `office-app-${theme === "dark" ? "dark-" : ""}${variant}.png`), animations: "disabled" });
      console.log(`${theme} ${variant}: ${[...requested].join(", ")}`);
      await context.close();
    }
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    if (server.exitCode !== null && server.exitCode !== 0) console.error(log);
  }
}

await main();
