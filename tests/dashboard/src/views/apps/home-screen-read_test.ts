import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import type { CapsuleAppIncompleteSection, CapsuleAppView } from "../../../../../dashboard/src/lib/control-api.ts";

const root = resolve(import.meta.dir, "../../../../../");
type Props = Record<string, unknown>;
type Component = (props: Props) => unknown;
interface Element { readonly type: string | symbol | Component; readonly props: Props }
interface HomeRead { readonly apps: readonly unknown[]; readonly surfacesFailed: boolean }
let value: HomeRead | undefined;
let error: unknown;
let read: (() => Promise<HomeRead>) | undefined;
let pending: Promise<void> | undefined;
const jsx = (type: Element["type"], props: Props): Element => ({ type, props: props ?? {} });
const fragment = Symbol("fragment");
const match: Component = (props) => props.children;
const children = (props: Props, argument?: unknown) => typeof props.children === "function"
  ? (props.children as (value?: unknown) => unknown)(argument)
  : props.children;
const refresh = () => {
  pending = read!().then((next) => { value = next; error = undefined; }, (cause: unknown) => { error = cause; });
  return pending;
};

// Render-only primitives expose the real Home component's resource, conditional
// Toast and retry handler in Bun. They do not model browser DOM/reactivity/auth.
mock.module("solid-js", () => ({
  createMemo: (compute: () => unknown) => compute,
  createSignal: <T>(initial: T) => {
    let current = initial;
    return [() => current, (next: T | ((previous: T) => T)) => {
      current = typeof next === "function" ? (next as (previous: T) => T)(current) : next;
      return current;
    }];
  },
  createResource: (_source: unknown, load: () => Promise<HomeRead>) => {
    read = load;
    const resource = Object.defineProperties(() => value, {
      latest: { get: () => value }, error: { get: () => error }, loading: { get: () => false },
    });
    return [resource, { refetch: refresh }];
  },
  createUniqueId: () => "home-caption",
  createEffect: () => undefined,
  onCleanup: () => undefined,
  untrack: (compute: () => unknown) => compute(),
  For: (props: Props) => (props.each as readonly unknown[]).map((entry) => children(props, entry)),
  Match: match,
  Show: (props: Props) => props.when ? children(props, () => props.when) : props.fallback,
  Switch: (props: Props) => {
    const selected = (props.children as readonly Element[]).find((entry) => entry.props.when);
    return selected?.props.children;
  },
}));
for (const runtime of ["react/jsx-dev-runtime", "react/jsx-runtime", "solid-js/jsx-dev-runtime", "solid-js/jsx-runtime"]) {
  mock.module(runtime, () => ({ Fragment: fragment, jsxDEV: jsx, jsx, jsxs: jsx }));
}
mock.module("lucide-solid", () => Object.fromEntries(
  ["Plus", "Settings2", "Sparkles", "ChevronDown", "ExternalLink", "Smartphone"].map((name) => [name, () => null]),
));
mock.module(resolve(root, "dashboard/src/components/ui/index.ts"), () => ({
  Button: (props: Props) => jsx("button", props),
  Toast: (props: Props) => jsx("div", { ...props, role: "alert" }),
}));
mock.module(resolve(root, "dashboard/src/views/account/components/auth/Page.tsx"), () => ({
  default: (props: Props) => props.children,
}));
for (const path of ["dashboard/src/views/apps/IncomingOwnershipTransfers.tsx", "dashboard/src/components/AppFace.tsx"]) {
  mock.module(resolve(root, path), () => ({ default: () => null }));
}

const { default: Home } = await import("../../../../../dashboard/src/views/apps/AppListView.tsx");
const { resetAppOwnershipCache } = await import("../../../../../dashboard/src/lib/control-api.ts");
const { clearWorkspaceListCache } = await import("../../../../../dashboard/src/lib/workspace-list.ts");
const { clearSharedAuthSessionPreflight } = await import("../../../../../dashboard/src/lib/shared-auth-session-preflight.ts");
const { setLocale, t } = await import("../../../../../dashboard/src/i18n/index.ts");
const originalFetch = globalThis.fetch;
const calls: { readonly path: string; readonly method: string; readonly credentials: RequestCredentials | undefined }[] = [];
let respond: (path: string) => Response;

function renderHome() {
  const elements: Element[] = [];
  const text: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === "function") { visit(node()); return; }
    if (typeof node === "string" || typeof node === "number") { text.push(String(node)); return; }
    if (node === null || typeof node !== "object") return;
    const element = node as Element;
    if (typeof element.type === "function") { visit(element.type(element.props)); return; }
    if (element.type !== fragment) elements.push(element);
    visit(element.props.children);
  };
  visit(Home());
  return { elements, text: text.join(" ") };
}

function app(incomplete?: readonly CapsuleAppIncompleteSection[], screens: CapsuleAppView["screens"] = []): CapsuleAppView {
  return {
    kind: "takosumi.capsule-app@v1", capsuleId: "cap_home", workspaceId: "ws_home", projectId: "prj_home",
    name: "Fixture app", environment: "test", status: "active", applied: true, state: "installed", primaryAction: "open",
    problems: [], screens, links: { uses: [], usedBy: [] },
    version: { updateAvailable: false, stale: false, autoUpdate: false }, progress: { revisionPreparing: false },
    uninstall: { impact: { usedBy: [] }, mode: "none" }, ...(incomplete ? { incomplete } : {}),
    observedAt: "2026-11-14T00:00:00Z",
  };
}
const screen = { interfaceId: "if_home", name: "Home", url: "https://screen.example.test/" };
const appsResponse = () => Response.json({ apps: [{
  capsuleId: "cap_home", name: "Fixture app", role: "owner", ownerDisplayName: "Fixture owner", state: "installed", primaryAction: "open",
}] });
const alerts = () => renderHome().elements.filter((node) => node.props.role === "alert");
const tile = () => renderHome().elements.find((node) => node.props["data-testid"] === "home-app");
const assertGetOnly = () => {
  expect(calls.every((call) => call.method === "GET" && call.credentials === "include")).toBe(true);
};

beforeEach(() => {
  value = undefined; error = undefined; read = undefined; pending = undefined; calls.length = 0;
  resetAppOwnershipCache(); clearWorkspaceListCache(); clearSharedAuthSessionPreflight(); setLocale("en");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, method: init?.method ?? "GET", credentials: init?.credentials });
    return respond(path);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

test("Home exposes a 200 incomplete screen read and retries through its existing button", async () => {
  let current = app(["screens"]);
  respond = (path) => {
    if (path === "/api/v1/apps") return appsResponse();
    if (path === "/api/v1/capsules/cap_home/app") return Response.json({ app: current });
    throw new Error("unexpected local fixture read");
  };
  renderHome(); await refresh();
  expect(alerts()).toHaveLength(1);
  expect(renderHome().text).toContain(t("apps.listIncomplete"));
  expect(tile()?.props["data-app-opens"]).toBe("false");
  const retry = renderHome().elements.find((node) => node.type === "button" && node.props.children === t("common.retry"));
  expect(retry).toBeDefined();
  current = app(undefined, [screen]);
  (retry!.props.onClick as () => void)(); await pending;
  expect(alerts()).toHaveLength(0);
  expect(tile()?.props["data-app-opens"]).toBe("true");
  expect(renderHome().elements.some((node) => node.type === "a" && node.props.href === screen.url)).toBe(true);
  expect(calls.map((call) => call.path)).toEqual([
    "/api/v1/apps", "/api/v1/capsules/cap_home/app", "/api/v1/capsules/cap_home/app",
  ]);
  assertGetOnly();
});

test("Home keeps authorized screens during partial reads without promoting invalid URLs", async () => {
  respond = (path) => path === "/api/v1/apps" ? appsResponse() : Response.json({
    app: app(["screens"], [screen, { ...screen, interfaceId: "if_invalid", url: "not-a-url" }]),
  });
  renderHome(); await refresh();
  expect(alerts()).toHaveLength(1);
  expect(tile()?.props["data-app-opens"]).toBe("true");
  expect(renderHome().elements.filter((node) => node.type === "a").map((node) => node.props.href)).toContain(screen.url);
  expect(renderHome().elements.some((node) => node.props.href === "not-a-url")).toBe(false);
  assertGetOnly();
});

test("Home does not turn other incomplete sections or a legitimate empty screen list into screen failures", async () => {
  for (const current of [app(), app(["display", "version", "links", "screen_problems"], [screen])]) {
    resetAppOwnershipCache(); value = undefined;
    respond = (path) => path === "/api/v1/apps" ? appsResponse() : Response.json({ app: current });
    renderHome(); await refresh();
    expect(alerts()).toHaveLength(0);
    expect(tile()?.props["data-app-opens"]).toBe(current.screens.length ? "true" : "false");
  }
  assertGetOnly();
});

test("Home retains HTTP screen failures and refuses legacy fallback on an app-list authorization failure", async () => {
  respond = (path) => path === "/api/v1/apps" ? appsResponse() : Response.json({ error: "unavailable" }, { status: 503 });
  renderHome(); await refresh();
  expect(alerts()).toHaveLength(1);
  expect(renderHome().text).toContain(t("apps.listIncomplete"));
  resetAppOwnershipCache(); value = undefined; calls.length = 0;
  respond = () => Response.json({ error: "forbidden" }, { status: 403 });
  renderHome(); await refresh();
  expect(alerts()).toHaveLength(1);
  expect(renderHome().text).not.toContain(t("apps.listIncomplete"));
  expect(calls.map((call) => call.path)).toEqual(["/api/v1/apps"]);
  assertGetOnly();
});

test("Home still uses the existing legacy path only for an absent app-list route", async () => {
  respond = (path) => {
    if (path === "/api/v1/apps") return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    if (path.startsWith("/api/v1/dashboard/bootstrap?")) return Response.json({ workspaces: [] });
    throw new Error("unexpected local fixture read");
  };
  renderHome(); await refresh();
  expect(alerts()).toHaveLength(0);
  expect(tile()).toBeUndefined();
  expect(calls.map((call) => call.path)).toEqual([
    "/api/v1/apps", "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50",
  ]);
  assertGetOnly();
});
