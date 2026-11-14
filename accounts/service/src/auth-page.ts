/** Shared presentation for issuer pages. This module does not interpret auth parameters. */
export type AuthLanguage = "ja" | "en";

export function authLanguage(request: Request): AuthLanguage {
  let language: AuthLanguage = "en";
  let bestWeight = 0;
  for (const preference of (request.headers.get("accept-language") ?? "").split(",")) {
    const [tag = "", quality] = preference.trim().split(";");
    const primary = tag.trim().toLowerCase().split("-")[0];
    if (primary !== "ja" && primary !== "en") continue;
    const weight = quality === undefined ? 1 : Number(/^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/iu.exec(quality)?.[1]);
    if (weight > bestWeight && weight <= 1) {
      bestWeight = weight;
      language = primary;
    }
  }
  return language;
}

export function escapeAuthHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

// Takosumi's neutral surfaces and red controls, with the compact card used by
// Takoserver sign-in. Keep the HTML usable under default-src 'none'.
const authStyle = `
:root {
  color-scheme: light dark;
  --auth-bg: #f7f7f8;
  --auth-panel: #fff;
  --auth-hover: #f1f1f3;
  --auth-fg: #18181b;
  --auth-muted: #66666f;
  --auth-border: #d6d6db;
  --auth-control-border: #898992;
  --auth-accent: #c42f24;
  --auth-action: #d32f24;
  --auth-action-hover: #b7261d;
  --auth-action-text: #fff;
  --auth-font: system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --auth-bg: #0a0a0b;
    --auth-panel: #151517;
    --auth-hover: #26262a;
    --auth-fg: #f5f5f6;
    --auth-muted: #a1a1a8;
    --auth-border: #37373d;
    --auth-control-border: #73737c;
    --auth-accent: #ff8b83;
    --auth-action: #d63a2f;
    --auth-action-hover: #c93025;
  }
}
* { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { margin: 0; background: var(--auth-bg); color: var(--auth-fg); font: 1rem/1.55 var(--auth-font); }
.auth-shell { min-height: 100svh; display: grid; place-items: center; padding: 1.25rem 1rem; }
.auth-card { width: min(100%, 26rem); min-width: 0; padding: clamp(1rem, 5vw, 1.75rem); border: 1px solid var(--auth-border); border-radius: .875rem; background: var(--auth-panel); overflow-wrap: anywhere; }
.auth-brand { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-weight: 650; font-size: .875rem; margin: 0 0 1rem; }
.auth-brand::before { content: ''; width: .625rem; height: .625rem; border-radius: .2rem; background: var(--auth-accent); }
.auth-badge { border: 1px solid var(--auth-border); border-radius: .375rem; padding: .0625rem .375rem; color: var(--auth-muted); font-weight: 500; font-size: .75rem; }
h1 { font-size: 1.375rem; line-height: 1.3; margin: 0 0 .5rem; font-style: normal; }
p, ul, dl { margin: .75rem 0; }
.auth-summary, small, dt, .auth-hint { color: var(--auth-muted); }
.auth-providers { list-style: none; padding: 0; display: grid; gap: .5rem; margin: 1.25rem 0 0; }
.auth-hint, .warn { font-size: .875rem; }
.auth-hint { margin: .5rem 0 0; }
.auth-permissions { padding-inline-start: 1.25rem; }
.auth-permissions li + li { margin-top: .375rem; }
dd { margin: 0 0 .5rem; }
.note { font-weight: 600; }
.warn { background: var(--auth-hover); padding: .625rem; border-radius: .5rem; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1.25rem; }
.actions > * { flex: 1 1 auto; }
.auth-button { display: grid; place-items: center; min-height: 2.75rem; width: 100%; padding: .5rem .75rem; border: 1px solid var(--auth-control-border); border-radius: .5rem; background: var(--auth-panel); color: var(--auth-fg); text-align: center; text-decoration: none; font: 600 .9375rem/1.4 var(--auth-font); cursor: pointer; }
.auth-button:hover:not(:disabled) { background: var(--auth-hover); }
.auth-button:active:not(:disabled) { border-color: var(--auth-accent); }
.auth-button:focus-visible { outline: 2px solid var(--auth-accent); outline-offset: 3px; }
.auth-button:disabled { color: var(--auth-muted); border-color: var(--auth-border); background: var(--auth-hover); cursor: default; }
.auth-button--primary { background: var(--auth-action); color: var(--auth-action-text); border-color: var(--auth-action); }
.auth-button--primary:hover:not(:disabled) { background: var(--auth-action-hover); }
`;

export function authPage(input: {
  language: AuthLanguage;
  nonce: string;
  title: string;
  body: string;
  badge?: string;
}): string {
  const brand = input.language === "ja" ? "Takos アカウント" : "Takos Account";
  const title = escapeAuthHtml(input.title);
  const badge = input.badge ? `<span class="auth-badge">${escapeAuthHtml(input.badge)}</span>` : "";
  return `<!doctype html><html lang="${input.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${escapeAuthHtml(input.nonce)}">${authStyle}</style></head><body><div class="auth-shell"><main class="auth-card"><div class="auth-brand">${brand}${badge}</div><h1>${title}</h1>${input.body}</main></div></body></html>`;
}
