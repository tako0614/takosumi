/** Capture the actual built Takosumi dashboard with deterministic public examples. */
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const output = resolve(here, "../public/screens");
const origin = "http://127.0.0.1:5199";
const createdAt = "2026-08-01T00:00:00.000Z";
const assetOrigin = "https://assets.example.test";
const workspace = {
  id: "ws_alpha",
  handle: "demo",
  displayName: "デモ環境",
  type: "personal",
  ownerUserId: "sub_portable_e2e",
  createdAt,
  updatedAt: createdAt,
};
const session = {
  subject: "sub_portable_e2e",
  expiresAt: Date.now() + 60 * 60 * 1000,
  displayName: "Demo",
  email: "demo@example.test",
};

const products = [
  { id: "takos", name: "Takos", description: "AI と一緒に仕事を進める", category: "productivity", icon: "takos.png" },
  { id: "office", name: "Takos Office", description: "文書を作成し、チームで共有する", category: "productivity", icon: "office.svg" },
  { id: "yurucommu", name: "Yurucommu", description: "会話をひとつの場所にまとめる", category: "communication", icon: "yurucommu.svg" },
];

function capsule(product) {
  return {
    id: `cap_demo_${product.id}`,
    workspaceId: "ws_alpha",
    name: product.name,
    slug: product.id,
    sourceId: `src_demo_${product.id}`,
    installConfigId: `cfg_demo_${product.id}`,
    environment: "production",
    currentStateGeneration: 1,
    status: "active",
    freshness: "fresh",
    createdAt,
    updatedAt: createdAt,
  };
}

function launcher(product, order) {
  const capsuleId = `cap_demo_${product.id}`;
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: `if_demo_${product.id}`,
      workspaceId: "ws_alpha",
      name: "app.launcher",
      ownerRef: { kind: "Capsule", id: capsuleId },
      generation: 1,
      createdAt,
      updatedAt: createdAt,
    },
    spec: {
      type: "interface.ui.surface",
      version: "1",
      document: {
        launcher: true,
        display: {
          title: product.name,
          icon: `${assetOrigin}/${product.icon}`,
          category: product.category,
          sortOrder: order,
        },
      },
      inputs: { url: { source: "capsule_output", capsuleId, outputName: "url" } },
      access: { visibility: "workspace" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      resolvedInputs: { url: `https://${product.id}.example.test/` },
    },
  };
}

const storeListings = products.map((product, order) => ({
  id: `demo/${product.id}`,
  source: { git: `https://github.com/example/${product.id}` },
  suggestedName: product.name,
  name: { ja: product.name, en: product.name },
  description: { ja: product.description, en: product.description },
  badge: { ja: "サンプル", en: "Sample" },
  iconUrl: `${assetOrigin}/${product.icon}`,
  kind: "application",
  surface: "web",
  category: product.category,
  publisher: { handle: "demo", displayName: "Demo" },
  createdAt,
  updatedAt: `2026-08-0${3 - order}T00:00:00.000Z`,
}));

async function ready(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`dashboard fixture exited ${child.exitCode}`);
    try {
      if ((await fetch(`${origin}/__e2e/ready`)).ok) return;
    } catch { /* server is starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("dashboard fixture did not become ready");
}

async function capture(browser, variant, viewport, theme) {
  const iconAssets = new Map(await Promise.all(products.map(async (product) => [
    `/${product.icon}`,
    {
      body: await readFile(resolve(root, product.id === "takos"
        ? "website/public/apps/takos.png"
        : `dashboard/public/brand/${product.icon}`)),
      contentType: product.icon.endsWith(".png") ? "image/png" : "image/svg+xml",
    },
  ])));
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    locale: "ja-JP",
    colorScheme: theme,
  });
  await context.addCookies([{
    name: "takosumi_session",
    value: "portable-e2e",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await context.addInitScript(({ storeOrigin, themePreference }) => {
    localStorage.setItem("tcs.stores", JSON.stringify([storeOrigin]));
    localStorage.setItem("tg_theme", themePreference);
  }, { storeOrigin: origin, themePreference: theme });
  const page = await context.newPage();
  const errors = [];
  const failures = [];
  const unexpectedRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 && (url.origin === origin || url.origin === assetOrigin)) {
      failures.push(`${response.status()} ${url.pathname}`);
    }
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") return route.abort("blockedbyclient");
    if (url.origin === assetOrigin && iconAssets.has(url.pathname)) {
      const asset = iconAssets.get(url.pathname);
      return route.fulfill({
        status: 200,
        contentType: asset.contentType,
        body: asset.body,
      });
    }
    if (url.origin !== origin) {
      unexpectedRequests.push(url.href);
      return route.abort("blockedbyclient");
    }
    const json = (body) => route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });
    if (url.pathname === "/api/v1/dashboard/bootstrap") {
      return json({
        session,
        workspaces: [workspace],
        workspaceList: { total: 1, returned: 1, limit: 50, truncated: false },
        notifications: [],
      });
    }
    if (url.pathname === "/api/v1/workspaces") {
      return json({ workspaces: [workspace], total: 1, returned: 1, limit: 50, truncated: false });
    }
    if (url.pathname === "/api/v1/workspaces/ws_alpha/capsules") {
      return json({ capsules: products.map(capsule) });
    }
    if (url.pathname === "/api/v1/workspaces/ws_alpha/ui-surfaces") {
      return json({ interfaces: products.map(launcher) });
    }
    if (url.pathname === "/tcs/v2/server-info") {
      return json({
        spec: { version: "2.0", capabilities: ["listings"] },
        server: { name: "Demo Store", software: { name: "fixture", version: "1" }, baseUrl: origin },
        listings: { count: storeListings.length },
        categories: [],
        defaultLocale: "ja",
      });
    }
    if (url.pathname === "/tcs/v2/listings") return json({ items: storeListings });
    return route.continue();
  });

  try {
    for (const [screen, path, selector] of [
      ["home", "/", ".av-tile-wrap"],
      ["install", "/new", ".tcs-card"],
    ]) {
      failures.length = 0;
      if (screen === "install" && variant === "mobile") {
        await page.setViewportSize({ width: viewport.width, height: 950 });
      }
      await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
      await page.locator(selector).first().waitFor({ state: "visible" });
      const actualTheme = await page.locator("html").getAttribute("data-theme");
      if (actualTheme !== theme) {
        throw new Error(`${screen}/${variant}/${theme}: dashboard theme was ${actualTheme}`);
      }
      const imagesLoaded = await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.complete ? undefined : new Promise((resolveImage) => {
          image.addEventListener("load", resolveImage, { once: true });
          image.addEventListener("error", resolveImage, { once: true });
        })));
        return [...document.images].every((image) => image.naturalWidth > 0);
      });
      if (screen === "home" && await page.locator(selector).count() !== products.length) {
        throw new Error("launcher did not render all three example products");
      }
      if (screen === "install" && await page.locator(selector).count() !== storeListings.length) {
        throw new Error("store did not render all three example listings");
      }
      if (!imagesLoaded || errors.length || failures.length || unexpectedRequests.length) {
        throw new Error(`${screen}/${variant}: imagesLoaded=${imagesLoaded}; browser errors=${errors.join("; ")}; HTTP failures=${failures.join("; ")}; unexpected requests=${unexpectedRequests.join("; ")}`);
      }
      const file = resolve(output, `dashboard-${screen}-${variant}${theme === "light" ? "-light" : ""}.png`);
      const clip = screen === "home" && variant === "desktop"
        ? { x: 0, y: 0, width: viewport.width, height: 440 }
        : undefined;
      await page.screenshot({ path: file, animations: "disabled", ...(clip ? { clip } : {}) });
      const capturedViewport = page.viewportSize();
      console.log(`${screen}/${variant}/${theme}: ${file} (${capturedViewport.width * 2}x${(clip?.height ?? capturedViewport.height) * 2})`);
    }
  } finally {
    await context.close();
  }
}

async function main() {
  const requestedTheme = process.argv[2] ?? "all";
  if (!["all", "dark", "light"].includes(requestedTheme)) {
    throw new Error("usage: node website/scripts/capture-dashboard-ui.mjs [all|dark|light]");
  }
  await mkdir(output, { recursive: true });
  const fixture = spawn("bun", ["tests/dashboard/e2e/fixture-server.ts"], {
    cwd: root,
    env: { ...process.env, TAKOSUMI_E2E_PORT: "5199" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  fixture.stdout.on("data", (chunk) => { log += chunk.toString(); });
  fixture.stderr.on("data", (chunk) => { log += chunk.toString(); });
  let browser;
  try {
    await ready(fixture);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const theme of requestedTheme === "all" ? ["dark", "light"] : [requestedTheme]) {
      await capture(browser, "desktop", { width: 1200, height: 750 }, theme);
      await capture(browser, "mobile", { width: 390, height: 700 }, theme);
    }
  } finally {
    await browser?.close();
    fixture.kill("SIGTERM");
    if (fixture.exitCode !== null && fixture.exitCode !== 0) console.error(log);
  }
}

await main();
