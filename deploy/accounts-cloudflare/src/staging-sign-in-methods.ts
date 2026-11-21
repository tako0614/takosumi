import { authLanguage, authPage, escapeAuthHtml as esc } from "../../../accounts/service/src/auth-page.ts";

const methodsPath = "/api/v1/account/sign-in-methods";
const copy = {
  en: {
    title: "Sign-in methods",
    username: "Username",
    usernameHint: "Use 3–32 letters, numbers, dots, underscores, or hyphens. Start with a letter or number.",
    usernameUnavailable: "That username is already taken.",
    password: "New password",
    current: "Current password",
    add: "Set password",
    change: "Change password",
    again: "Sign in with Google or GitHub",
    stale: "Sign in again to set a password.",
    unavailable: "Connect Google or GitHub to set a password.",
    hint: "Use 15 to 128 characters.",
    failed: "Could not save the password. Check your input or sign in again.",
    saved: "Password saved.",
  },
  ja: {
    title: "ログイン方法",
    username: "ユーザー名",
    usernameHint: "半角英数字と . _ - で3〜32文字。先頭は英数字にしてください。",
    usernameUnavailable: "このユーザー名はすでに使われています。",
    password: "新しいパスワード",
    current: "現在のパスワード",
    add: "パスワードを設定",
    change: "パスワードを変更",
    again: "Google または GitHub でログイン",
    stale: "パスワードを設定するには、ログインし直してください。",
    unavailable: "パスワードを設定するには、GoogleまたはGitHubの連携が必要です。",
    hint: "15〜128文字で入力してください。",
    failed: "保存できませんでした。入力を確認するか、ログインし直してください。",
    saved: "パスワードを保存しました。",
  },
} as const;

export async function handleStagingSignInMethods(
  request: Request,
  accounts: (request: Request) => Promise<Response> | Response,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const cookie = request.headers.get("cookie");
  if (!cookie) return new Response(null, { status: 303, headers: { Location: "/sign-in?return=%2Faccount" } });
  const result = await accounts(new Request(new URL(methodsPath, url.origin), { headers: { cookie } }));
  if (result.status === 401) return new Response(null, { status: 303, headers: { Location: "/sign-in?return=%2Faccount" } });
  if (!result.ok) return new Response(null, { status: result.status });
  const methods = await result.json() as { username: string | null; eligible: boolean; hasPassword: boolean; canSetPassword: boolean };
  const lang = authLanguage(request);
  const labels = copy[lang];
  const nonce = crypto.randomUUID();
  const form = methods.canSetPassword ? `<form id="password-form"><fieldset disabled>
    ${methods.username ? "" : `<label>${esc(labels.username)}<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" title="${esc(labels.usernameHint)}" required></label>`}
    ${methods.hasPassword ? `<label>${esc(labels.current)}<input name="currentPassword" type="password" autocomplete="current-password"></label>` : ""}
    <label>${esc(labels.password)}<input name="password" type="password" autocomplete="new-password" required aria-describedby="password-hint"></label>
    <p class="auth-hint" id="password-hint">${esc(labels.hint)}</p>
    <button class="auth-button auth-button--primary" type="submit">${esc(methods.hasPassword ? labels.change : labels.add)}</button>
  </fieldset></form>` : "";
  const body = `<style nonce="${nonce}">
    .methods{display:grid;gap:.875rem}.methods fieldset{border:0;margin:0;padding:0;display:grid;gap:.6rem}
    .methods label{display:grid;gap:.25rem;font-size:.875rem}.methods input{padding:.65rem;border-radius:.5rem;border:1px solid var(--auth-control-border);color:var(--auth-fg);background:var(--auth-panel);font:inherit;min-width:0}
    .methods input:focus-visible{outline:2px solid var(--auth-accent)}.methods a{color:var(--auth-fg)}
  </style>
  <div class="methods">
    ${methods.username ? `<p>${esc(labels.username)} <strong>${esc(methods.username)}</strong></p>` : ""}
    ${form}
    <p id="password-status" role="status" data-failed="${esc(labels.failed)}" data-username-unavailable="${esc(labels.usernameUnavailable)}">${esc(url.searchParams.get("saved") === "1" ? labels.saved : !methods.eligible ? labels.unavailable : !methods.canSetPassword ? labels.stale : "")}</p>
    <a href="/sign-in?return=%2Faccount">${esc(labels.again)}</a>
  </div>${form ? `<script nonce="${nonce}">${settingsScript}</script>` : ""}`;
  return new Response(request.method === "HEAD" ? null : authPage({ language: lang, nonce, title: labels.title, issuer: url.origin, body }), {
    headers: {
      "content-type": "text/html; charset=utf-8", "content-language": lang,
      "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    },
  });
}

const settingsScript = `
const form = document.getElementById("password-form");
const fieldset = form.querySelector("fieldset");
const status = document.getElementById("password-status");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const inputs = { password: data.get("password") };
  if (data.get("username")) inputs.username = data.get("username");
  if (data.get("currentPassword")) inputs.currentPassword = data.get("currentPassword");
  fieldset.disabled = true;
  status.textContent = "";
  try {
    const response = await fetch("${methodsPath}/password", {
      method: "POST", headers: { "content-type": "application/json" },
      credentials: "same-origin", cache: "no-store", body: JSON.stringify(inputs)
    });
    if (!response.ok) {
      const problem = await response.json();
      status.textContent = problem?.error === "username_unavailable" ? status.dataset.usernameUnavailable : status.dataset.failed;
      fieldset.disabled = false;
      return;
    }
    form.reset();
    location.replace("/account?saved=1");
  } catch {
    status.textContent = status.dataset.failed;
    fieldset.disabled = false;
  }
});
fieldset.disabled = false;
`;
