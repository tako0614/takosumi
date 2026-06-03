import type { Installation } from "./rpc";
import { tryDefaultTakosUrlForHost } from "./use-takos-start";

export interface AppDetailLaunchState {
  readonly label: string;
  readonly description: string;
  readonly href?: string;
}

export interface AppDetailLaunchEnvironment {
  readonly origin: string;
  readonly hostname: string;
}

export function appDetailLaunchState(
  app: Installation,
  env: AppDetailLaunchEnvironment,
): AppDetailLaunchState {
  if (app.status !== "ready") return unavailableLaunchState(app.status);

  if (app.launchUrl) {
    return {
      label: "Launch app",
      href: app.launchUrl,
      description: "This Installation exposes a Cloud launch URL.",
    };
  }

  if (isManagedTakosInstallation(app)) {
    if (!app.accountId || !app.spaceId || !app.installationId) {
      return {
        label: "Launch unavailable",
        description:
          "Takos launch requires account, space, and installation identifiers.",
      };
    }
    const href = managedTakosLaunchUrl(app, env);
    if (!href) {
      // The operator has not configured a Takos host for this
      // distribution (VITE_TAKOSUMI_DASHBOARD_TAKOS_URL unset on a
      // non-local host). Render a graceful unavailable state instead of
      // throwing during the app detail render.
      return {
        label: "Launch unavailable",
        description:
          "This Installation is ready, but no Takos host is configured for this distribution.",
      };
    }
    return {
      label: "Launch Takos",
      href,
      description:
        "Takos launch issues a short-lived launch token from this account-plane Installation.",
    };
  }

  return {
    label: "Launch unavailable",
    description:
      "This Installation is ready, but no Cloud launch entry is configured.",
  };
}

function isManagedTakosInstallation(app: Installation): boolean {
  return app.appId === "takos.chat" ||
    app.sourceGitUrl === "takos-product://managed/takos";
}

function managedTakosLaunchUrl(
  app: Installation,
  env: AppDetailLaunchEnvironment,
): string | undefined {
  const takosUrl = tryDefaultTakosUrlForHost(env.hostname);
  if (!takosUrl) return undefined;
  // Defensive: the caller guards spaceId, but TS does not narrow across the
  // boundary — never emit a return_to of /spaces/undefined/threads.
  if (!app.spaceId) return undefined;
  const url = new URL("/takos/start", env.origin);
  url.searchParams.set("takos_url", takosUrl);
  url.searchParams.set("account_id", app.accountId ?? "");
  url.searchParams.set("space_id", app.spaceId ?? "");
  url.searchParams.set("installation_id", app.installationId);
  url.searchParams.set("app_id", app.appId || "takos.chat");
  url.searchParams.set("return_to", `/spaces/${app.spaceId}/threads`);
  return url.toString();
}

function unavailableLaunchState(
  status: Installation["status"],
): AppDetailLaunchState {
  switch (status) {
    case "installing":
      return {
        label: "Launch unavailable",
        description:
          "Installation is still preparing. Launch becomes available after it is ready.",
      };
    case "failed":
      return {
        label: "Launch unavailable",
        description: "Installation failed. Resolve the failure before launch.",
      };
    case "suspended":
      return {
        label: "Launch unavailable",
        description:
          "Installation is suspended. Resolve the account or billing action before launch.",
      };
    case "exported":
      return {
        label: "Launch unavailable",
        description: "Installation was exported and cannot be launched here.",
      };
    default:
      return {
        label: "Launch unavailable",
        description:
          "Installation status is unknown. Launch is disabled until status is ready.",
      };
  }
}
