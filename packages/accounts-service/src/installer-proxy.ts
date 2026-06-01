import {
  TAKOSUMI_ACCOUNTS_INSTALLATION_DRY_RUN_PATH,
  TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
 takosumiAccountsInstallationDeploymentDryRunPath,
 takosumiAccountsInstallationDeploymentsPath,
 takosumiAccountsInstallationRollbackPath,
} from "@takosjp/takosumi-accounts-contract";

export interface InstallerProxyOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
}

export async function handleInstallationDryRunProxy(input: {
  request: Request;
  installer: InstallerProxyOptions;
}): Promise<Response> {
  const body = await input.request.text();
  const response = await (input.installer.fetch ?? fetch)(
    installerDryRunUrl(input.installer.url),
    {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": input.request.headers.get("content-type") ??
          "application/json",
        ...(input.installer.token
          ? { authorization: `Bearer ${input.installer.token}` }
          : {}),
      },
      body,
    },
  );
  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ??
        "application/json; charset=utf-8",
    },
  });
}

function installerDryRunUrl(baseUrl: string): string {
  return new URL(
    TAKOSUMI_ACCOUNTS_INSTALLATION_DRY_RUN_PATH,
    baseUrl,
  ).toString();
}

function installerApplyUrl(baseUrl: string): string {
  return new URL(TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH, baseUrl).toString();
}

function installerDeploymentDryRunUrl(
  baseUrl: string,
  installationId: string,
): string {
  return new URL(
   takosumiAccountsInstallationDeploymentDryRunPath(installationId),
    baseUrl,
  ).toString();
}

function installerDeploymentApplyUrl(
  baseUrl: string,
  installationId: string,
): string {
  return new URL(
   takosumiAccountsInstallationDeploymentsPath(installationId),
    baseUrl,
  ).toString();
}

function installerRollbackUrl(
  baseUrl: string,
  installationId: string,
): string {
  return new URL(
   takosumiAccountsInstallationRollbackPath(installationId),
    baseUrl,
  ).toString();
}

async function requestInstallerJson(input: {
  installer: InstallerProxyOptions;
  url: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const response = await (input.installer.fetch ?? fetch)(input.url, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      ...(input.installer.token
        ? { authorization: `Bearer ${input.installer.token}` }
        : {}),
    },
    body: JSON.stringify(input.body),
  });
  const contentType = response.headers.get("content-type") ??
    "application/json; charset=utf-8";
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, contentType, payload };
}

export async function requestInstallationDryRun(input: {
  installer: InstallerProxyOptions;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  return await requestInstallerJson({
    installer: input.installer,
    url: installerDryRunUrl(input.installer.url),
    body: input.body,
  });
}

export async function requestInstallationApply(input: {
  installer: InstallerProxyOptions;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  return await requestInstallerJson({
    installer: input.installer,
    url: installerApplyUrl(input.installer.url),
    body: input.body,
  });
}

export async function requestDeploymentDryRun(input: {
  installer: InstallerProxyOptions;
  installationId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  return await requestInstallerJson({
    installer: input.installer,
    url: installerDeploymentDryRunUrl(
      input.installer.url,
      input.installationId,
    ),
    body: input.body,
  });
}

export async function requestDeploymentApply(input: {
  installer: InstallerProxyOptions;
  installationId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  return await requestInstallerJson({
    installer: input.installer,
    url: installerDeploymentApplyUrl(input.installer.url, input.installationId),
    body: input.body,
  });
}

export async function requestRollback(input: {
  installer: InstallerProxyOptions;
  installationId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  return await requestInstallerJson({
    installer: input.installer,
    url: installerRollbackUrl(input.installer.url, input.installationId),
    body: input.body,
  });
}
