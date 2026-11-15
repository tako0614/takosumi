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

// Shared account presentation. The pixel mark matches Takoserver Console;
// inline SVG keeps every screen within the existing nonce-only style CSP.
const authMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34" shape-rendering="crispEdges" class="auth-mark" width="30" height="30" aria-hidden="true">
  <rect x="9" y="0" width="17" height="8" fill="currentColor"/>
  <rect x="8" y="1" width="1" height="30" fill="currentColor"/>
  <rect x="26" y="1" width="1" height="33" fill="currentColor"/>
  <rect x="7" y="2" width="1" height="30" fill="currentColor"/>
  <rect x="27" y="2" width="1" height="30" fill="currentColor"/>
  <rect x="6" y="3" width="1" height="31" fill="currentColor"/>
  <rect x="28" y="3" width="1" height="22" fill="currentColor"/>
  <rect x="29" y="4" width="1" height="20" fill="currentColor"/>
  <rect x="5" y="5" width="1" height="29" fill="currentColor"/>
  <rect x="4" y="6" width="1" height="15" fill="currentColor"/>
  <rect x="30" y="6" width="1" height="17" fill="currentColor"/>
  <rect x="3" y="7" width="1" height="13" fill="currentColor"/>
  <rect x="31" y="7" width="1" height="15" fill="currentColor"/>
  <rect x="2" y="8" width="1" height="9" fill="currentColor"/>
  <rect x="9" y="8" width="4" height="23" fill="currentColor"/>
  <rect x="15" y="8" width="5" height="3" fill="currentColor"/>
  <rect x="22" y="8" width="4" height="23" fill="currentColor"/>
  <rect x="32" y="8" width="1" height="13" fill="currentColor"/>
  <rect x="1" y="10" width="1" height="4" fill="currentColor"/>
  <rect x="13" y="10" width="2" height="21" fill="currentColor"/>
  <rect x="20" y="10" width="2" height="24" fill="currentColor"/>
  <rect x="33" y="10" width="1" height="10" fill="currentColor"/>
  <rect x="17" y="11" width="3" height="20" fill="currentColor"/>
  <rect x="16" y="12" width="1" height="1" fill="currentColor"/>
  <rect x="15" y="14" width="1" height="20" fill="currentColor"/>
  <rect x="16" y="16" width="1" height="18" fill="currentColor"/>
  <rect x="0" y="20" width="3" height="2" fill="currentColor"/>
  <rect x="1" y="22" width="2" height="2" fill="currentColor"/>
  <rect x="3" y="23" width="2" height="8" fill="currentColor"/>
  <rect x="2" y="24" width="1" height="2" fill="currentColor"/>
  <rect x="28" y="27" width="1" height="4" fill="currentColor"/>
  <rect x="29" y="28" width="1" height="3" fill="currentColor"/>
  <rect x="2" y="29" width="1" height="2" fill="currentColor"/>
  <rect x="30" y="29" width="1" height="2" fill="currentColor"/>
  <rect x="1" y="30" width="1" height="1" fill="currentColor"/>
  <rect x="31" y="30" width="1" height="1" fill="currentColor"/>
  <rect x="10" y="31" width="3" height="1" fill="currentColor"/>
  <rect x="17" y="31" width="1" height="1" fill="currentColor"/>
  <rect x="22" y="31" width="1" height="1" fill="currentColor"/>
  <rect x="25" y="31" width="1" height="3" fill="currentColor"/>
  <rect x="10" y="32" width="2" height="2" fill="currentColor"/>
  <rect x="13" y="8" width="2" height="2" fill="var(--auth-mark-face)"/>
  <rect x="20" y="8" width="2" height="2" fill="var(--auth-mark-face)"/>
  <rect x="15" y="11" width="2" height="1" fill="var(--auth-mark-face)"/>
  <rect x="15" y="12" width="1" height="2" fill="var(--auth-mark-face)"/>
  <rect x="16" y="13" width="1" height="3" fill="var(--auth-mark-face)"/>
</svg>`;
const authStyle = `
:root {
  color-scheme: light dark;
  --auth-bg: #ffffff;
  --auth-panel: #ffffff;
  --auth-hover: #f6f6f7;
  --auth-fg: #0e0e10;
  --auth-muted: #6e7076;
  --auth-border: #e6e6e8;
  --auth-control-border: #d3d4d7;
  --auth-accent: #b0301f;
  --auth-action: var(--auth-accent);
  --auth-action-hover: #94281a;
  --auth-action-text: #ffffff;
  --auth-mark-face: #17100f;
  --auth-google-blue: #4285f4;
  --auth-google-green: #34a853;
  --auth-google-yellow: #fbbc05;
  --auth-google-red: #ea4335;
  --auth-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", "Noto Sans JP", "Hiragino Sans", sans-serif;
  --auth-space-xs: .5rem;
  --auth-space-sm: .75rem;
  --auth-space-md: 1rem;
  --auth-space-lg: 1.5rem;
  --auth-space-xl: 2rem;
  --auth-space-2xl: 2.5rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --auth-bg: #101012;
    --auth-panel: #17171a;
    --auth-hover: #1f1f23;
    --auth-fg: #f2f2f3;
    --auth-muted: #a4a6ad;
    --auth-border: #2a2a30;
    --auth-control-border: #3e3e47;
    --auth-accent: #f17d6c;
    --auth-action: #e0533c;
    --auth-action-hover: #ef6349;
    --auth-action-text: #150907;
    --auth-mark-face: #0b0b0c;
  }
}
* { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { min-height: 100svh; margin: 0; display: flex; flex-direction: column; background: var(--auth-bg); color: var(--auth-fg); font: 400 .9375rem/1.65 var(--auth-font); -webkit-font-smoothing: antialiased; }
.auth-shell { width: min(100%, 25.5rem); margin: auto; padding: var(--auth-space-2xl) var(--auth-space-lg) 5rem; }
.auth-shell--consent { width: min(100%, 29rem); }
.auth-brand { display: flex; align-items: center; justify-content: center; gap: var(--auth-space-sm); margin-bottom: var(--auth-space-xl); }
.auth-mark { flex: 0 0 auto; color: var(--auth-accent); }
.auth-wordmark { font-size: 1.5rem; line-height: 1; letter-spacing: -.045em; font-weight: 650; }
.auth-badge { color: var(--auth-muted); text-align: center; margin: var(--auth-space-lg) 0 0; font-size: .6875rem; }
h1 { margin: 0; font-size: 1.375rem; font-weight: 600; font-style: normal; line-height: 1.5; letter-spacing: -.025em; text-align: center; text-wrap: balance; overflow-wrap: anywhere; }
.auth-summary { margin: var(--auth-space-sm) 0 0; color: var(--auth-muted); font-size: .875rem; line-height: 1.8; text-align: center; text-wrap: balance; overflow-wrap: anywhere; }
.auth-task { margin-top: var(--auth-space-xl); min-width: 0; overflow-wrap: anywhere; }
.auth-providers, .auth-permissions { list-style: none; padding: 0; margin: 0; }
.auth-providers { display: grid; gap: var(--auth-space-sm); }
.auth-provider-label { display: flex; justify-content: center; align-items: center; gap: var(--auth-space-sm); padding: var(--auth-space-xs) 0; color: var(--auth-muted); }
.auth-button { display: flex; align-items: center; justify-content: center; gap: var(--auth-space-sm); min-height: 3rem; width: 100%; padding: var(--auth-space-sm) var(--auth-space-md); border: 1px solid var(--auth-control-border); border-radius: .5rem; background: var(--auth-panel); color: var(--auth-fg); text-align: center; text-decoration: none; font: 500 .875rem/1.5 var(--auth-font); cursor: pointer; }
.auth-provider-icon { flex: 0 0 auto; width: 1.125rem; height: 1.125rem; }
.auth-button:hover:not(:disabled) { background: var(--auth-hover); }
.auth-button:active:not(:disabled) { border-color: var(--auth-muted); }
.auth-button:focus-visible { outline: 2px solid var(--auth-accent); outline-offset: 3px; }
.auth-button:disabled { color: var(--auth-muted); border-color: var(--auth-border); background: var(--auth-hover); cursor: default; }
.auth-button:disabled .auth-provider-icon { opacity: .5; }
.auth-button--primary { background: var(--auth-action); color: var(--auth-action-text); border-color: var(--auth-action); }
.auth-button--primary:hover:not(:disabled) { background: var(--auth-action-hover); border-color: var(--auth-action-hover); }
.auth-hint, dt { color: var(--auth-muted); }
.auth-hint { margin: var(--auth-space-xs) 0 0; font-size: .75rem; }
.auth-permissions { padding-block: var(--auth-space-sm); border-block: 1px solid var(--auth-border); }
.auth-permissions li { position: relative; padding: var(--auth-space-xs) 0 var(--auth-space-xs) var(--auth-space-lg); font-size: .875rem; }
.auth-permissions li::before { content: ''; position: absolute; top: 1.1em; left: .125rem; width: .625rem; height: .3125rem; border-bottom: 1.5px solid var(--auth-muted); border-left: 1.5px solid var(--auth-muted); transform: rotate(-45deg); }
.auth-context { margin: var(--auth-space-md) 0 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--auth-space-xs) var(--auth-space-sm); font-size: .75rem; }
.auth-context dd { margin: 0; overflow-wrap: anywhere; }
.warn { font-size: .8125rem; margin: var(--auth-space-md) 0 0; }
.warn { color: var(--auth-muted); }
.actions { display: flex; flex-wrap: wrap; gap: var(--auth-space-sm); margin-top: var(--auth-space-lg); }
.actions > * { flex: 1 1 8rem; width: auto; }
@media (max-width: 43rem) {
  .auth-shell { padding-block: var(--auth-space-2xl) 4rem; }
}
`;

export function authPage(input: {
  language: AuthLanguage;
  nonce: string;
  title: string;
  body?: string;
  description?: string;
  badge?: string;
  variant?: "consent";
}): string {
  const title = escapeAuthHtml(input.title);
  const badge = input.badge ? `<p class="auth-badge">${escapeAuthHtml(input.badge)}</p>` : "";
  const description = input.description ? `<p class="auth-summary">${escapeAuthHtml(input.description)}</p>` : "";
  const task = input.body ? `<div class="auth-task">${input.body}</div>` : "";
  return `<!doctype html><html lang="${input.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Takos</title><style nonce="${escapeAuthHtml(input.nonce)}">${authStyle}</style></head><body><main class="auth-shell${input.variant === "consent" ? " auth-shell--consent" : ""}"><div class="auth-brand">${authMark}<span class="auth-wordmark">Takos</span></div><h1>${title}</h1>${description}${task}${badge}</main></body></html>`;
}
