import {
  TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
 takosumiAccountsInstallationPath,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "./store.ts";
import type { SharedCellRuntimeAllocator } from "./runtime.ts";
import { handleCreateAppInstallation } from "./installation-lifecycle-routes.ts";
import {
  handleIssueLaunchToken,
  launchRedirectUrl,
} from "./installation-routes-internal.ts";
import type { AppBindingMaterializer, LaunchTokenOptions } from "./mod.ts";
import {
  isRecord,
  json,
  stringValue,
 takosumiSubjectValue,
} from "./http-helpers.ts";
import { requireAccountSession } from "./account-session.ts";

export async function handleUseTakosStart(input: {
  request: Request;
  url: URL;
  store: AccountsStore;
  issuer: string;
  launchTokens: LaunchTokenOptions;
  bindingMaterializer?: AppBindingMaterializer;
  sharedCellRuntime?: SharedCellRuntimeAllocator;
}): Promise<Response> {
  // /start mutates LedgerAccount / Space / Installation state and therefore
  // cannot accept anonymous subject overrides from URL params. Require an
  // authenticated session and pin the request's subject to the session
  // subject regardless of what the URL claims.
  const session = await requireAccountSession({
    request: input.request,
    store: input.store,
  });
  if (!session.ok) return session.response;
  const start = useTakosStartRequest(input.url, session.subject);
  if (start instanceof Response) return start;
  const now = Date.now();
  const existingInstallation = await input.store.findAppInstallation(
    start.installationId,
  );
  if (existingInstallation) {
    const mismatch = existingInstallation.accountId !== start.accountId ||
      existingInstallation.spaceId !== start.spaceId ||
      existingInstallation.appId !== start.appId ||
      existingInstallation.createdBySubject !== start.subject ||
      existingInstallation.sourceGitUrl !== "takos-product://managed/takos";
    if (mismatch) {
      return json({
        error: "use_takos_installation_mismatch",
        error_description:
          "existing installation does not match the Use Takos start request",
      }, 409);
    }
  }

  if (!existingInstallation && !input.sharedCellRuntime) {
    return json({
      error: "feature_unavailable",
      error_description: "Use Takos is temporarily unavailable.",
    }, 503);
  }

  const existingAccount = await input.store.findAccount(start.subject);
  await input.store.saveAccount({
    subject: start.subject,
    ...((start.email ?? existingAccount?.email)
      ? { email: start.email ?? existingAccount?.email }
      : {}),
    ...((start.displayName ?? existingAccount?.displayName)
      ? { displayName: start.displayName ?? existingAccount?.displayName }
      : {}),
    termsVersion: start.termsVersion,
    termsAcceptedAt: now,
    termsAcceptedSource: "use-takos-start",
    createdAt: existingAccount?.createdAt ?? now,
    updatedAt: now,
  });

  if (!existingInstallation) {
    const createResponse = await handleCreateAppInstallation({
      request: new Request(
        `${input.url.origin}${TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(useTakosInstallationBody(start)),
        },
      ),
      store: input.store,
      issuer: input.issuer,
      launchTokens: input.launchTokens,
      bindingMaterializer: input.bindingMaterializer,
      sharedCellRuntime: input.sharedCellRuntime,
    });
    if (createResponse.status < 200 || createResponse.status >= 300) {
      return createResponse;
    }
    await createResponse.body?.cancel();
  }

  const launchRedirect = new URL(start.redirectUri);
  launchRedirect.searchParams.set("return_to", start.returnTo);
  const launchResponse = await handleIssueLaunchToken({
    installationId: start.installationId,
    request: new Request(
      `${input.url.origin}${
       takosumiAccountsInstallationPath(start.installationId)
      }/launch-token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "install-bootstrap",
          ttlSeconds: 120,
          redirectUri: launchRedirect.toString(),
        }),
      },
    ),
    store: input.store,
    issuer: input.issuer,
    launchTokens: input.launchTokens,
  });
  if (launchResponse.status < 200 || launchResponse.status >= 300) {
    return launchResponse;
  }
  const launchBody = await launchResponse.json().catch(() => null) as unknown;
  const launchUrl = isRecord(launchBody) ? stringValue(launchBody.url) : "";
  if (!launchUrl) {
    return json({
      error: "invalid_launch_response",
      error_description: "launch token response did not include a URL",
    }, 502);
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: launchUrl,
      "referrer-policy": "no-referrer",
    },
  });
}

type UseTakosStartRequest = {
  subject: TakosumiSubject;
  accountId: string;
  spaceId: string;
  installationId: string;
  appId: string;
  redirectUri: string;
  returnTo: string;
  sourceRef: string;
  sourceCommit: string;
  planSnapshotDigest: string;
  artifactDigest?: string;
  termsVersion: string;
  email?: string;
  displayName?: string;
};

function useTakosStartRequest(
  url: URL,
  sessionSubject: TakosumiSubject,
): UseTakosStartRequest | Response {
  // The URL subject parameter is permitted only as an explicit assertion that
  // the caller is acting on behalf of the session subject. Any mismatch is a
  // 403 — we never let URL params override the authenticated identity.
  const subjectParam = startParam(url, "subject");
  if (subjectParam) {
    const parsed = takosumiSubjectValue(subjectParam);
    if (!parsed) {
      return json({
        error: "invalid_request",
        error_description:
          "subject must be a Takosumi subject starting with tsub_",
      }, 400);
    }
    if (parsed !== sessionSubject) {
      return json({
        error: "subject_mismatch",
        error_description:
          "subject query parameter does not match the authenticated session",
      }, 403);
    }
  }
  const subject = sessionSubject;
  const accountId = startParam(url, "account_id", "accountId") ??
    `acct_${shortUuid()}`;
  const spaceId = startParam(url, "space_id", "spaceId") ??
    `space_${shortUuid()}`;
  const installationId = startParam(url, "installation_id", "installationId") ??
    `inst_takos_${shortUuid()}`;
  const appId = startParam(url, "app_id", "appId") ?? "takos.chat";
  const redirectUri = useTakosRedirectUri(url);
  if (!redirectUri) {
    return json({
      error: "invalid_request",
      error_description:
        "Use Takos requires redirect_uri or takos_url pointing to /_takosumi/launch",
    }, 400);
  }
  const returnTo = startParam(url, "return_to", "returnTo") ??
    `/spaces/${spaceId}/threads`;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) {
    return json({
      error: "invalid_request",
      error_description: "return_to must be a local absolute path",
    }, 400);
  }
  const termsVersion = startParam(url, "terms_version", "termsVersion");
  if (!termsVersion || !validTermsVersion(termsVersion)) {
    return json({
      error: "invalid_request",
      error_description:
        "Use Takos requires a current terms_version such as terms-2026-05-13",
    }, 400);
  }
  if (!startBooleanParam(url, "terms_accepted", "termsAccepted")) {
    return json({
      error: "terms_acceptance_required",
      error_description:
        "Use Takos requires terms_accepted=true before public managed signup can continue",
    }, 400);
  }
  return {
    subject,
    accountId,
    spaceId,
    installationId,
    appId,
    redirectUri,
    returnTo,
    sourceRef: startParam(url, "ref") ?? "managed",
    sourceCommit: startParam(url, "source_commit", "commit") ??
      "managed-prebuilt",
    planSnapshotDigest: startParam(url, "plan_snapshot_digest") ??
      "sha256:takos-product-managed",
    termsVersion,
    ...(startParam(url, "artifact_digest")
      ? { artifactDigest: startParam(url, "artifact_digest") }
      : {}),
    ...(startParam(url, "email") ? { email: startParam(url, "email") } : {}),
    ...(startParam(url, "display_name", "displayName")
      ? { displayName: startParam(url, "display_name", "displayName") }
      : {}),
  };
}

function useTakosInstallationBody(
  start: UseTakosStartRequest,
): Record<string, unknown> {
  return {
    installationId: start.installationId,
    accountId: start.accountId,
    spaceId: start.spaceId,
    appId: start.appId,
    source: {
      gitUrl: "takos-product://managed/takos",
      ref: start.sourceRef,
      commit: start.sourceCommit,
      planSnapshotDigest: start.planSnapshotDigest,
      ...(start.artifactDigest
        ? { artifactDigest: start.artifactDigest }
        : {}),
    },
    mode: "shared-cell",
    status: "ready",
    createdBySubject: start.subject,
    spaceKind: "personal",
    spaceDisplayName: "Takos Space",
    useEdges: [{
      name: "bootstrap",
      kind: "install-launch-token@v1",
      configRef: "takos-product://managed/takos/use-edges/bootstrap",
      secretRefs: [],
    }],
  };
}

function startParam(url: URL, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function startBooleanParam(url: URL, ...names: readonly string[]): boolean {
  const value = startParam(url, ...names)?.toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function validTermsVersion(value: string): boolean {
  return /^[a-z][a-z0-9._-]{0,63}$/.test(value);
}

function useTakosRedirectUri(url: URL): string | undefined {
  const explicit = startParam(url, "redirect_uri", "redirectUri");
  if (explicit) {
    const parsed = launchRedirectUrl(explicit);
    return parsed?.toString();
  }
  const base = startParam(url, "takos_url", "takosUrl", "takos_base_url");
  if (!base) return undefined;
  try {
    const parsed = new URL(base);
    parsed.pathname = "/_takosumi/launch";
    parsed.search = "";
    parsed.hash = "";
    const launch = launchRedirectUrl(parsed.toString());
    return launch?.toString();
  } catch {
    return undefined;
  }
}

function shortUuid(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
