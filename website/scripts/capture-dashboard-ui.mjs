/** Capture the actual built Takosumi dashboard with deterministic public examples. */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const output = resolve(here, "../public/screens");
const docsOutput = resolve(root, "docs/public/getting-started");
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

const cloudflareProvider = "registry.opentofu.org/cloudflare/cloudflare";

// The landing's review screen ("追加前の確認") for adding Takos. The plan
// counts are derived from takos v0.12.7 deploy/opentofu/cloudflare: its
// platform module creates 1 D1 database, 1 KV namespace, 5 R2 buckets and 6
// queues on a fresh install, so the review shows 13 to create and nothing to
// change or delete. Every other value is an illustrative example.
const takosFlow = {
  key: "takos",
  git: "https://github.com/example/takos",
  ref: "0123456789abcdef0123456789abcdef01234567",
  modulePath: ".",
  name: "takos",
  installPlanId: "gip_7a3c9e2f41b6d805",
  providers: [{ source: cloudflareProvider, moduleLocalName: "cloudflare" }],
  connections: [{
    id: "pc_demo_cloudflare",
    workspaceId: "ws_alpha",
    provider: "cloudflare",
    providerSource: cloudflareProvider,
    scope: "workspace",
    status: "verified",
    displayName: "Cloudflare",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt,
    updatedAt: createdAt,
    verifiedAt: createdAt,
  }],
  rootModuleVariables: [],
  installConfig: {
    id: "cfg-default-opentofu-capsule", name: "default-opentofu-capsule", policy: {}, variableMapping: {},
    variablePresentation: [], outputAllowlist: {}, createdAt, updatedAt: createdAt,
  },
  summary: { add: 13, change: 0, destroy: 0 },
};
const reviewPath = `/new?git=${encodeURIComponent(takosFlow.git)}&ref=${takosFlow.ref}&path=.&name=${takosFlow.name}`;

// The Quickstart's sample: this repository's examples/opentofu-basic, opened
// through the Quickstart's /install link. Its inputs are read from this
// repository's .well-known/takosumi.json and mapped the way
// compileRepositoryInstallUx maps plain user inputs with an explicit type and
// required flag. `tofu plan` of the module creates no
// resources, only two outputs, so the review shows 0, 0 and 0; the capture
// stops if the module starts declaring any. The commit and IDs are
// placeholders.
const quickstartModule = "examples/opentofu-basic";
const quickstartManifestInputs = JSON.parse(await readFile(resolve(root, ".well-known/takosumi.json"), "utf8"))
  .install.modules[quickstartModule].inputs;
// This mapping covers only explicit, plain user inputs; anything the compiler
// would derive differently has to be handled here before recapturing.
for (const input of quickstartManifestInputs) {
  if (input.source.kind !== "user" || input.type === undefined || input.required === undefined
    || input.advanced !== undefined || input.secret !== undefined) {
    throw new Error(`${quickstartModule} input ${input.name} needs the capture's presentation mapping updated`);
  }
}
const quickstartInputs = quickstartManifestInputs
  .map((input) => ({
    name: input.name,
    ...(input.type ? { type: input.type } : {}),
    ...(input.format ? { format: input.format } : {}),
    required: input.required,
    label: input.label,
    ...(input.helper ? { helper: input.helper } : {}),
    ...(input.placeholder ? { placeholder: input.placeholder } : {}),
  }));
const quickstartTf = (await Promise.all((await readdir(resolve(root, quickstartModule)))
  .filter((file) => /\.tf(?:\.json)?$/u.test(file))
  .map((file) => readFile(resolve(root, quickstartModule, file), "utf8")))).join("\n");
if (/^\s*(?:resource|data|module)\s+["\w]|"(?:resource|data|module)"\s*:/mu.test(quickstartTf)) {
  throw new Error(`${quickstartModule} now declares resources; re-plan it and update quickstartFlow.summary`);
}
const quickstartFlow = {
  key: "quickstart",
  git: "https://github.com/tako0614/takosumi.git",
  ref: "main",
  resolvedCommit: "89abcdef0123456789abcdef0123456789abcdef",
  modulePath: quickstartModule,
  installPlanId: "gip_3b8e1d0c6a5f4972",
  providers: [],
  connections: [],
  rootModuleVariables: quickstartInputs.map((input) => input.name).sort(),
  repositoryInstallConfigId: "cfg_demo_quickstart_repository",
  installConfig: {
    id: "cfg_demo_quickstart_repository", name: "opentofu-basic", policy: {}, variableMapping: {},
    variablePresentation: quickstartInputs,
    installExperience: { repositoryInstallUx: { status: "accepted" } },
    outputAllowlist: {}, createdAt, updatedAt: createdAt,
  },
  summary: { add: 0, change: 0, destroy: 0 },
};
const quickstartPath = `/install?git=${quickstartFlow.git}&ref=${quickstartFlow.ref}&path=${quickstartFlow.modulePath}`;

// The workload page's 「更新」 tab after a few applies. Takos (the landing) has
// three recorded versions; the Quickstart sample has two, as after one more
// apply. Times, IDs and refs are placeholders.
const updatesFlows = {
  takos: {
    capsuleId: "cap_demo_takos",
    name: "Takos",
    git: "https://github.com/example/takos",
    ref: "v0.12.7",
    modulePath: ".",
    appliedAt: ["2026-08-01T09:12:00.000Z", "2026-08-20T03:40:00.000Z", "2026-09-10T11:05:00.000Z"],
  },
  quickstart: {
    capsuleId: "cap_demo_quickstart",
    name: "takosumi",
    git: "https://github.com/tako0614/takosumi.git",
    ref: "main",
    modulePath: quickstartModule,
    appliedAt: ["2026-08-01T09:12:00.000Z", "2026-08-01T09:30:00.000Z"],
  },
};

/** Answer one workload page's reads with a short apply history. */
async function stubWorkloadUpdates(page, flow) {
  const id = flow.capsuleId;
  const versions = flow.appliedAt.map((at, index) => ({
    id: `sv_${id}_${index + 1}`, workspaceId: "ws_alpha", capsuleId: id, environment: "production",
    generation: index + 1, createdByRunId: `run_${id}_apply_${index + 1}`, createdAt: at,
  }));
  const current = versions.at(-1);
  const capsuleRecord = {
    id, workspaceId: "ws_alpha", name: flow.name, slug: flow.name.toLowerCase(),
    sourceId: `src_${id}`, installConfigId: `cfg_${id}`, environment: "production",
    currentStateVersionId: current.id, currentStateGeneration: current.generation,
    status: "active", freshness: "fresh", createdAt: flow.appliedAt[0], updatedAt: current.createdAt,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (request.method() !== "GET") return route.fallback();
    if (path === `/api/v1/capsules/${id}`) {
      return json({ capsule: capsuleRecord, installConfigReAdoption: { authorityGuard: `sha256:${"a".repeat(64)}` } });
    }
    if (path === `/api/v1/capsules/${id}/state-versions`) return json({ stateVersions: [...versions].reverse() });
    if (path.startsWith("/api/v1/state-versions/")) {
      const version = versions.find((entry) => path.endsWith(`/${entry.id}`));
      return version ? json({ stateVersion: version }) : route.fallback();
    }
    if (path === `/api/v1/capsules/${id}/current-resource-inventory`) {
      return json({ inventory: {
        kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: id, workspaceId: "ws_alpha",
        environment: "production", stateVersionId: current.id, generation: current.generation,
        applyRunId: current.createdByRunId, planRunId: `run_${id}_plan_${current.generation}`,
        recordedAt: current.createdAt, availability: "recorded", resources: [],
      } });
    }
    if (path === `/api/v1/capsule-configs/cfg_${id}`) {
      return json({ installConfig: {
        id: `cfg_${id}`, workspaceId: "ws_alpha", name: flow.name,
        sourceSelector: { kind: "git", url: flow.git, ref: flow.ref, path: flow.modulePath },
        policy: {}, variableMapping: {}, variablePresentation: [], outputAllowlist: {}, interfaceBlueprints: [],
        createdAt: flow.appliedAt[0], updatedAt: current.createdAt,
      } });
    }
    if (path === `/api/v1/capsules/${id}/provider-bindings`) {
      return json({ providerBindingSet: {
        id: `pbs_${id}`, workspaceId: "ws_alpha", capsuleId: id, environment: "production", bindings: [],
        createdAt: flow.appliedAt[0], updatedAt: current.createdAt,
      } });
    }
    if (path === `/api/v1/capsules/${id}/usage-summary`) {
      return json({ summary: { capsuleId: id, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } });
    }
    if (path === "/api/v1/sources") {
      return json({ sources: [{
        id: `src_${id}`, workspaceId: "ws_alpha", name: flow.name, url: flow.git, defaultRef: flow.ref,
        defaultPath: flow.modulePath, status: "active", autoSync: false, createdAt: flow.appliedAt[0], updatedAt: current.createdAt,
      }] });
    }
    if (path === "/api/v1/provider-connections") return json({ providerConnections: [] });
    if (path === "/api/v1/workspaces/ws_alpha/graph") return json({ nodes: [], edges: [] });
    return route.fallback();
  });
}

/**
 * Open the 「更新」 tab's 更新履歴 and one older version's restore disclosure, as
 * a reader would. Returns the update card's page box.
 */
async function showUpdateHistory(page, flow) {
  const history = page.locator("details.wb-disclosure").filter({ has: page.locator("summary", { hasText: /^(更新履歴|Update history)$/u }) });
  await history.locator("summary").first().click();
  const rows = history.locator(".wa-deploy-row");
  await rows.first().waitFor({ state: "visible" });
  if (await rows.count() !== flow.appliedAt.length) {
    throw new Error(`update history showed ${await rows.count()} versions`);
  }
  await rows.nth(1).locator("details > summary").click();
  await rows.nth(1).getByRole("button", { name: /^(この状態に戻す|Restore this state)$/u }).waitFor({ state: "visible" });
  // The tracked ref comes from the source record; Review changes only becomes
  // enabled once the install config has loaded.
  const card = page.locator(".tg-card").filter({ has: history }).first();
  await card.locator("code").filter({ hasText: new RegExp(`^${flow.ref.replaceAll(".", "\\.")}$`, "u") }).first().waitFor({ state: "visible" });
  await card.locator("button:enabled").filter({ hasText: /^(変更を確認|Review changes)$/u }).first().waitFor({ state: "visible" });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  return await card.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY };
  });
}

/**
 * Fail when page text or an image sits under the dashboard's sticky header,
 * which is translucent: whatever is scrolled beneath it shows through.
 */
async function assertNothingUnderHeader(page, label) {
  const under = await page.evaluate(() => {
    const header = document.querySelector("header");
    if (!header) return ["(no sticky header found)"];
    const box = header.getBoundingClientRect();
    const overlaps = (rect) => rect.width > 0 && rect.height > 0 && rect.top < box.bottom && rect.bottom > box.top && rect.left < box.right && rect.right > box.left;
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || header.contains(node)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if ([...range.getClientRects()].some(overlaps)) found.push(node.textContent.trim().slice(0, 40));
    }
    for (const element of document.body.querySelectorAll("img, svg")) {
      if (!header.contains(element) && overlaps(element.getBoundingClientRect())) found.push(`<${element.tagName.toLowerCase()}>`);
    }
    return found;
  });
  if (under.length) throw new Error(`${label}: under the sticky header: ${under.join(" | ")}`);
}

/** Answer one add flow's API calls so the real dashboard reaches its review. */
async function stubAddFlow(page, flow) {
  const ids = {
    source: `src_demo_${flow.key}`,
    snapshot: `snap_demo_${flow.key}`,
    syncRun: `run_demo_${flow.key}_sync`,
    planRun: `run_demo_${flow.key}_plan`,
    capsule: `cap_demo_${flow.key}`,
  };
  const commit = flow.resolvedCommit ?? flow.ref;
  let sourceRequest = {};
  let planRequest = {};
  const source = (extra = {}) => ({
    id: ids.source, workspaceId: "ws_alpha", name: sourceRequest.name ?? flow.name, url: flow.git,
    defaultRef: sourceRequest.defaultRef ?? flow.ref, defaultPath: sourceRequest.defaultPath ?? ".",
    status: "active", autoSync: false, createdAt, updatedAt: createdAt, ...extra,
  });
  const installPlan = () => ({
    installPlan: {
      id: flow.installPlanId, workspaceId: "ws_alpha", createdBy: "sub_portable_e2e",
      requestDigest: `sha256:${"2".repeat(64)}`,
      source: { name: source().name, url: flow.git, ref: commit, path: flow.modulePath },
      capsule: { name: planRequest.capsule?.name ?? source().name, environment: "production" },
      options: planRequest.options ?? {}, preflight: planRequest.preflight,
      sourceId: ids.source, sourceSnapshotId: ids.snapshot,
      installConfigId: flow.installConfig.id, capsuleId: ids.capsule,
      planRunId: ids.planRun, phase: "reviewable", generation: 1, createdAt, updatedAt: createdAt,
    },
    nextAction: "review_run",
    links: { self: `/api/v1/install-plans/${flow.installPlanId}`, run: `/api/v1/runs/${ids.planRun}` },
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/v1/sources" && method === "GET") return json({ sources: [] });
    if (path === "/api/v1/connections") return json({ connections: [] });
    if (path === "/api/v1/provider-connections") return json({ providerConnections: flow.connections });
    if (path === "/api/v1/sources" && method === "POST") {
      sourceRequest = request.postDataJSON() ?? {};
      return json({ source: source(), hookSecret: "fixture-only" });
    }
    if (path === `/api/v1/sources/${ids.source}` && method === "PATCH") {
      return json({ source: source({ autoSync: request.postDataJSON()?.autoSync === true }) });
    }
    if (path === `/api/v1/sources/${ids.source}/sync` && method === "POST") return json({ run: { id: ids.syncRun } });
    if (path === `/api/v1/runs/${ids.syncRun}`) {
      return json({ run: {
        id: ids.syncRun, workspaceId: "ws_alpha", sourceId: ids.source, type: "source_sync",
        status: "succeeded", sourceSnapshotId: ids.snapshot, createdBy: "sub_portable_e2e", createdAt,
      } });
    }
    if (path === `/api/v1/sources/${ids.source}/snapshots`) {
      return json({ snapshots: [{
        id: ids.snapshot, origin: "git", workspaceId: "ws_alpha", sourceId: ids.source,
        url: flow.git, ref: flow.ref, resolvedCommit: commit, path: ".", archiveRef: "fixture",
        archiveDigest: `sha256:${"1".repeat(64)}`, archiveSizeBytes: 1, fetchedByRunId: ids.syncRun,
        fetchedAt: createdAt,
      }] });
    }
    if (path === `/api/v1/sources/${ids.source}/snapshots/${ids.snapshot}/install-modules`) {
      return json({
        status: "ready", sourceSnapshotId: ids.snapshot, scopePath: ".",
        modules: [{
          path: flow.modulePath,
          providerPackages: flow.providers.map(({ source: provider }) => ({ source: provider })),
          rootProviderRequirements: flow.providers,
        }],
      });
    }
    if (path === `/api/v1/sources/${ids.source}/compatibility-check` && method === "POST") {
      return json({
        run: { id: `ccr_demo_${flow.key}`, type: "compatibility_check", status: "succeeded", compatibilityReportId: `caprep_demo_${flow.key}` },
        report: {
          id: `caprep_demo_${flow.key}`, level: "ready", findings: [],
          providerPackages: flow.providers.map(({ source: provider }) => ({ source: provider, allowed: true })),
          rootProviderRequirements: flow.providers.map((provider) => ({ ...provider, credentialRequired: true })),
          resources: [], rootModuleVariables: flow.rootModuleVariables,
        },
        ...(flow.repositoryInstallConfigId
          ? { repositoryInstallUx: { status: "accepted", installConfigId: flow.repositoryInstallConfigId } }
          : {}),
      });
    }
    if (path === `/api/v1/capsule-configs/${flow.installConfig.id}`) return json({ installConfig: flow.installConfig });
    if (path === "/api/v1/workspaces/ws_alpha/install-plans" && method === "POST") {
      planRequest = request.postDataJSON() ?? {};
      return json(installPlan(), 201);
    }
    if (path === `/api/v1/install-plans/${flow.installPlanId}` && method === "GET") return json(installPlan());
    if (path === `/api/v1/runs/${ids.planRun}`) {
      return json({ run: {
        id: ids.planRun, workspaceId: "ws_alpha", capsuleId: ids.capsule, type: "plan",
        status: "succeeded", summary: flow.summary, policyStatus: "pass", requiresApproval: false,
        createdBy: "sub_portable_e2e", createdAt,
      } });
    }
    if (path === `/api/v1/runs/${ids.planRun}/stream`) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    }
    return route.fallback();
  });
}

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

async function capture(browser, variant, viewport, theme, screens = ["home", "install", "review", "updates"], locale = "ja-JP") {
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
    locale,
    // The update history shows times in the browser's zone; keep them stable.
    timezoneId: "UTC",
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
        workspaces: [locale === "ja-JP" ? workspace : { ...workspace, displayName: "Demo workspace" }],
        workspaceList: { total: 1, returned: 1, limit: 50, truncated: false },
        notifications: [],
      });
    }
    if (url.pathname === "/api/v1/workspaces") {
      return json({
        workspaces: [locale === "ja-JP" ? workspace : { ...workspace, displayName: "Demo workspace" }],
        total: 1, returned: 1, limit: 50, truncated: false,
      });
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
      ["review", reviewPath, ".iv-execution .iv-change-counts"],
      // Last: on desktop it resizes the viewport to the update card.
      ["updates", `/workloads/${updatesFlows.takos.capsuleId}/deploys`, ".wb-disclosure > summary"],
    ].filter(([screen]) => screens.includes(screen))) {
      failures.length = 0;
      let clip;
      if (screen !== "home" && variant === "mobile") {
        await page.setViewportSize({ width: viewport.width, height: 950 });
      } else {
        // The review and updates screens fit the desktop viewport to their card.
        await page.setViewportSize(viewport);
      }
      if (screen === "review") await stubAddFlow(page, takosFlow);
      if (screen === "updates") await stubWorkloadUpdates(page, updatesFlows.takos);
      await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
      if (screen === "review") {
        await page.getByRole("button", { name: "追加", exact: true }).click();
      }
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
      if (screen === "review") {
        const counts = await page.locator(".iv-change-counts dd").allTextContents();
        if (counts.join(",") !== Object.values(takosFlow.summary).join(",")) {
          throw new Error(`review counts were ${counts.join(",")}`);
        }
        await page.locator(".iv-execution").getByRole("button", { name: "追加する", exact: true }).waitFor({ state: "visible" });
        // The review sits below the source summary, and the page heading, the
        // step indicator and the card leave no gap as tall as the dashboard's
        // sticky header, which is translucent: anything scrolled beneath it
        // shows through. So never scroll. On desktop show the whole add page,
        // from the top to just below the card; on a phone, only the card.
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        const card = await page.locator(".iv-workbench").last().evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.left, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
        });
        if (variant === "desktop") {
          await page.setViewportSize({ width: viewport.width, height: Math.ceil(card.y + card.height + 32) });
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await assertNothingUnderHeader(page, `${screen}/${variant}/${theme}`);
        } else {
          // Tall enough that the fixed bottom tab bar sits below the card.
          await page.setViewportSize({ width: viewport.width, height: Math.ceil(card.y + card.height + 120) });
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          clip = { x: card.x - 16, y: card.y - 16, width: card.width + 32, height: card.height + 32 };
          await assertNothingUnderHeader(page, `${screen}/${variant}/${theme}`);
          const covered = await page.evaluate((bottom) => [...document.querySelectorAll("nav")].some((nav) => getComputedStyle(nav).position === "fixed" && nav.getBoundingClientRect().top < bottom), clip.y + clip.height);
          if (covered) throw new Error(`${screen}/${variant}/${theme}: a fixed bar covers the card`);
        }
      }
      if (screen === "updates") {
        // From the top, so the service name and tabs are not under the sticky
        // header; on desktop the viewport ends just below the update card.
        const card = await showUpdateHistory(page, updatesFlows.takos);
        if (variant === "desktop") {
          await page.setViewportSize({ width: viewport.width, height: Math.ceil(card.bottom + 32) });
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        } else if (card.bottom > 860) {
          // The landing crops the phone image at 780 / 1720 (.updates-shot).
          throw new Error(`mobile update card ends at ${card.bottom}px, below the landing's crop`);
        }
      }
      if (!imagesLoaded || errors.length || failures.length || unexpectedRequests.length) {
        throw new Error(`${screen}/${variant}: imagesLoaded=${imagesLoaded}; browser errors=${errors.join("; ")}; HTTP failures=${failures.join("; ")}; unexpected requests=${unexpectedRequests.join("; ")}`);
      }
      const file = resolve(output, `dashboard-${screen}-${variant}${theme === "light" ? "-light" : ""}.png`);
      await page.screenshot(clip ? { path: file, clip, fullPage: true, animations: "disabled" } : { path: file, animations: "disabled" });
      const size = clip ?? page.viewportSize();
      console.log(`${screen}/${variant}/${theme}: ${file} (${Math.floor(size.width * 2)}x${Math.floor(size.height * 2)})`);
    }
    if (screens.includes("quickstart")) {
      await captureQuickstart(page, locale, theme, () => {
        if (errors.length || failures.length || unexpectedRequests.length) {
          throw new Error(`quickstart/${locale}: browser errors=${errors.join("; ")}; HTTP failures=${failures.join("; ")}; unexpected requests=${unexpectedRequests.join("; ")}`);
        }
      });
    }
  } finally {
    await context.close();
  }
}

/**
 * The three screens Quickstart step 6 describes, from opening its /install
 * link to the review, and the 「更新」 tab step 7 describes. The first image is
 * the whole add page without the shell; the next two are only the part of the
 * card that each step adds; the last is the tabs and the update card.
 */
async function captureQuickstart(page, locale, theme, assertClean) {
  const ja = locale === "ja-JP";
  const labels = ja
    ? { add: "追加", setup: "サービスを設定", next: "続ける", review: "追加前の確認", install: "追加する" }
    : { add: "Add", setup: "Set up the service", next: "Continue", review: "Review before adding", install: "Add" };
  await stubAddFlow(page, quickstartFlow);
  await page.goto(`${origin}${quickstartPath}`, { waitUntil: "domcontentloaded" });
  const box = (locator) => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY };
  });
  const shoot = async (step, region) => {
    await page.evaluate(() => document.fonts.ready);
    assertClean();
    // Page coordinates from the top, so the sticky header never covers them.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    const { left, right, top, bottom } = await region();
    const clip = { x: left, y: top, width: right - left, height: bottom - top };
    const file = resolve(docsOutput, `quickstart-${step}${ja ? "" : "-en"}${theme === "dark" ? "-dark" : ""}.png`);
    await page.screenshot({ path: file, clip, fullPage: true, animations: "disabled" });
    console.log(`quickstart/${step}/${locale}/${theme}: ${file} (${Math.round(clip.width * 2)}x${Math.round(clip.height * 2)})`);
  };
  const card = page.locator(".iv-workbench").last();
  // Stay inside the card's border, so the docs frame is the only edge.
  const radius = await card.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderBottomLeftRadius));
  const inside = (cardBox, top, bottom) => ({
    left: cardBox.left + 1, right: cardBox.right - 1, top, bottom: Math.min(bottom, cardBox.bottom - radius),
  });
  await page.locator(".iv-intro").waitFor({ state: "visible" });
  // The whole add page, down to just below its card.
  await shoot("add", async () => {
    const pageBox = await box(page.locator(".iv-page"));
    const cardBox = await box(card);
    return { ...pageBox, bottom: cardBox.bottom + 32 };
  });
  await page.getByRole("button", { name: labels.add, exact: true }).click();
  const setupHeading = page.getByRole("heading", { name: labels.setup });
  await setupHeading.waitFor({ state: "visible" });
  // From the setup heading to its Continue button, across the card.
  await shoot("setup", async () => {
    const cardBox = await box(card);
    const headingBox = await box(setupHeading);
    const buttonBox = await box(page.getByRole("button", { name: labels.next, exact: true }));
    return inside(cardBox, headingBox.top - 20, buttonBox.bottom + 24);
  });
  await page.getByRole("button", { name: labels.next, exact: true }).click();
  await page.getByRole("heading", { name: labels.review }).waitFor({ state: "visible" });
  const counts = await page.locator(".iv-change-counts dd").allTextContents();
  if (counts.join(",") !== Object.values(quickstartFlow.summary).join(",")) {
    throw new Error(`quickstart review counts were ${counts.join(",")}`);
  }
  await page.locator(".iv-execution").getByRole("button", { name: labels.install, exact: true }).waitFor({ state: "visible" });
  // The review section alone, across the card.
  await shoot("review", async () => {
    const cardBox = await box(card);
    const reviewBox = await box(page.locator(".iv-execution"));
    return inside(cardBox, reviewBox.top - 20, reviewBox.bottom + 24);
  });

  // Step 7: the same sample's 「更新」 tab after one more apply, from its tabs to
  // the bottom of the update card.
  await stubWorkloadUpdates(page, updatesFlows.quickstart);
  await page.goto(`${origin}/workloads/${updatesFlows.quickstart.capsuleId}/deploys`, { waitUntil: "domcontentloaded" });
  await page.locator(".wb-disclosure > summary").first().waitFor({ state: "visible" });
  const updateCard = await showUpdateHistory(page, updatesFlows.quickstart);
  await shoot("updates", async () => {
    const tabs = await page.locator('a[href$="/deploys"]').first().evaluate((link) => {
      const rect = link.parentElement.getBoundingClientRect();
      return { top: rect.top + window.scrollY };
    });
    return { left: updateCard.left - 16, right: updateCard.right + 16, top: tabs.top - 16, bottom: updateCard.bottom + 16 };
  });
}

async function main() {
  const requestedTheme = process.argv[2] ?? "all";
  const requestedVariant = process.argv[3] ?? "all";
  if (!["all", "dark", "light"].includes(requestedTheme) || !["all", "desktop-home", "quickstart", "updates"].includes(requestedVariant)) {
    throw new Error("usage: node website/scripts/capture-dashboard-ui.mjs [all|dark|light] [all|desktop-home|quickstart|updates]");
  }
  await mkdir(output, { recursive: true });
  await mkdir(docsOutput, { recursive: true });
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
      if (requestedVariant === "quickstart") break;
      if (requestedVariant === "updates") {
        await capture(browser, "desktop", { width: 1200, height: 750 }, theme, ["updates"]);
        await capture(browser, "mobile", { width: 390, height: 700 }, theme, ["updates"]);
        continue;
      }
      await capture(browser, "desktop", { width: 1200, height: 750 }, theme, requestedVariant === "desktop-home" ? ["home"] : ["home", "install", "review", "updates"]);
      if (requestedVariant === "all") await capture(browser, "mobile", { width: 390, height: 700 }, theme);
    }
    // The docs show these in both locales and appearances, at a width where
    // the add page keeps its desktop layout.
    if (requestedVariant === "all" || requestedVariant === "quickstart") {
      for (const theme of requestedTheme === "all" ? ["light", "dark"] : [requestedTheme]) {
        for (const locale of ["ja-JP", "en-US"]) {
          await capture(browser, "desktop", { width: 1100, height: 900 }, theme, ["quickstart"], locale);
        }
      }
    }
  } finally {
    await browser?.close();
    fixture.kill("SIGTERM");
    if (fixture.exitCode !== null && fixture.exitCode !== 0) console.error(log);
  }
}

await main();
