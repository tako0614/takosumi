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

// One quiet shell for provider selection and permissions. No external assets
// or scripts: these pages work under the issuer's existing CSP.
const authStyle = `
:root {
  color-scheme: light dark;
  --auth-bg: #fafafb;
  --auth-panel: #fff;
  --auth-hover: #f2f2f4;
  --auth-fg: #111113;
  --auth-muted: #56565f;
  --auth-border: #e4e4e8;
  --auth-control-border: #8b8b95;
  --auth-accent: #b0301f;
  --auth-action: var(--auth-accent);
  --auth-action-hover: #94281a;
  --auth-action-text: #fff;
  --auth-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  --auth-gutter: clamp(1.25rem, 5vw, 3rem);
}
@media (prefers-color-scheme: dark) {
  :root {
    --auth-bg: #0b0b0c;
    --auth-panel: #131315;
    --auth-hover: #202024;
    --auth-fg: #f2f2f3;
    --auth-muted: #b4b5ba;
    --auth-border: #2e2e33;
    --auth-control-border: #777781;
    --auth-accent: #f17d6c;
    --auth-action: #e0533c;
    --auth-action-hover: #ef6349;
    --auth-action-text: #150907;
  }
}
* { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { min-height: 100svh; margin: 0; background: var(--auth-bg); color: var(--auth-fg); font: 1rem/1.6 var(--auth-font); }
.auth-header { border-block-end: 1px solid var(--auth-border); background: var(--auth-panel); }
.auth-bar { max-width: 70rem; min-height: 3.5rem; margin-inline: auto; padding-inline: var(--auth-gutter); display: flex; justify-content: space-between; align-items: center; gap: .75rem; }
.auth-brand { display: flex; align-items: baseline; gap: .625rem; min-width: 0; }
.auth-wordmark { font-size: 1.125rem; line-height: 1; letter-spacing: -.055em; font-weight: 780; }
.auth-wordmark::after { content: ''; display: inline-block; width: .27em; height: .27em; margin-inline-start: .14em; background: var(--auth-accent); }
.auth-brand-label { color: var(--auth-muted); font-size: .8125rem; font-weight: 540; }
.auth-badge { color: var(--auth-muted); border: 1px solid var(--auth-border); padding: .125rem .5rem; border-radius: .375rem; font-size: .75rem; white-space: nowrap; }
.auth-shell { max-width: 60rem; margin-inline: auto; padding: clamp(3.5rem, 15vh, 8.5rem) var(--auth-gutter) 3rem; }
.auth-grid { display: grid; align-items: start; grid-template-columns: minmax(0, .94fr) minmax(0, 1.06fr); gap: clamp(2.25rem, 6vw, 4.75rem); }
.auth-intro, .auth-task { min-width: 0; overflow-wrap: anywhere; }
h1 { margin: 0; font-size: clamp(1.875rem, 4.1vw, 2.625rem); font-weight: 730; font-style: normal; line-height: 1.18; letter-spacing: -.035em; text-wrap: balance; }
.auth-summary { margin: 1rem 0 0; max-width: 30ch; color: var(--auth-muted); }
.auth-task { border-inline-start: 1px solid var(--auth-border); padding-inline-start: clamp(1.5rem, 3vw, 2.25rem); }
.auth-task-title { margin: 0 0 .75rem; font-size: .875rem; line-height: 1.45; font-weight: 680; }
.auth-task > :first-child { margin-block-start: 0; }
.auth-providers, .auth-permissions { list-style: none; padding: 0; margin: 0; }
.auth-providers { display: grid; gap: .625rem; }
.auth-provider-label { display: block; border-block-end: 1px solid var(--auth-border); padding: .625rem 0; font-size: .9375rem; }
.auth-button { display: flex; align-items: center; justify-content: center; min-height: 2.875rem; width: 100%; padding: .625rem .875rem; border: 1px solid var(--auth-control-border); border-radius: .5rem; background: var(--auth-panel); color: var(--auth-fg); text-align: center; text-decoration: none; font: 620 .9375rem/1.35 var(--auth-font); cursor: pointer; }
.auth-provider-choice { position: relative; justify-content: space-between; gap: 1rem; padding-inline: 1rem; text-align: start; }
a.auth-provider-choice::after { content: ''; margin-inline-end: .125rem; width: .375rem; height: .375rem; flex: 0 0 auto; border-block-start: 1.5px solid currentColor; border-inline-end: 1.5px solid currentColor; transform: rotate(45deg); color: var(--auth-muted); }
.auth-button:hover:not(:disabled) { background: var(--auth-hover); }
.auth-button:active:not(:disabled) { border-color: var(--auth-accent); }
.auth-button:focus-visible { outline: 2px solid var(--auth-accent); outline-offset: 3px; }
.auth-button:disabled { color: var(--auth-muted); border-color: var(--auth-border); background: var(--auth-hover); cursor: default; }
.auth-button--primary { background: var(--auth-action); color: var(--auth-action-text); border-color: var(--auth-action); }
.auth-button--primary:hover:not(:disabled) { background: var(--auth-action-hover); }
.auth-hint, small, dt { color: var(--auth-muted); }
.auth-hint { margin: .375rem 0 0; font-size: .8125rem; }
.auth-permissions { border-block-start: 1px solid var(--auth-border); }
.auth-permissions li { position: relative; padding: .625rem 0 .625rem 1.25rem; border-block-end: 1px solid var(--auth-border); font-size: .9375rem; }
.auth-permissions li::before { content: ''; position: absolute; inset-block-start: 1.05em; inset-inline-start: .125rem; width: .375rem; height: .375rem; border: 1px solid var(--auth-control-border); border-radius: 50%; }
.auth-context { margin: 1rem 0 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .375rem .75rem; font-size: .8125rem; }
.auth-context dd { margin: 0; font-weight: 550; overflow-wrap: anywhere; }
.note, .warn { font-size: .875rem; margin: .875rem 0 0; }
.note { font-weight: 600; }
.warn { background: var(--auth-hover); padding: .75rem; border-radius: .5rem; }
.actions { display: flex; flex-wrap: wrap; gap: .625rem; margin-top: 1.375rem; }
.actions > * { flex: 1 1 8rem; width: auto; }
@media (max-width: 43rem) {
  .auth-shell { max-width: 30rem; padding-block-start: clamp(2.75rem, 9vh, 4.5rem); }
  .auth-grid { grid-template-columns: minmax(0, 1fr); gap: 1.625rem; }
  .auth-intro h1 { text-wrap: initial; }
  .auth-summary { max-width: none; margin-block-start: .75rem; }
  .auth-task { border-inline-start: 0; padding-inline-start: 0; }
}
`;

export function authPage(input: {
  language: AuthLanguage;
  nonce: string;
  title: string;
  body?: string;
  description?: string;
  taskTitle?: string;
  badge?: string;
}): string {
  const accountLabel = input.language === "ja" ? "アカウント" : "Account";
  const title = escapeAuthHtml(input.title);
  const badge = input.badge ? `<span class="auth-badge">${escapeAuthHtml(input.badge)}</span>` : "";
  const description = input.description ? `<p class="auth-summary">${escapeAuthHtml(input.description)}</p>` : "";
  const taskTitle = input.taskTitle ? `<h2 class="auth-task-title">${escapeAuthHtml(input.taskTitle)}</h2>` : "";
  const task = input.body ? `<div class="auth-task">${taskTitle}${input.body}</div>` : "";
  return `<!doctype html><html lang="${input.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${escapeAuthHtml(input.nonce)}">${authStyle}</style></head><body><header class="auth-header"><div class="auth-bar"><div class="auth-brand"><span class="auth-wordmark">Takos</span> <span class="auth-brand-label">${accountLabel}</span></div>${badge}</div></header><main class="auth-shell auth-grid"><div class="auth-intro"><h1>${title}</h1>${description}</div>${task}</main></body></html>`;
}
