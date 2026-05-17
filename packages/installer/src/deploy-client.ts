/**
 * HTTP client for Takosumi's 5-endpoint installer API.
 *
 * Thin wrapper over `fetch` that knows the wire shape of
 * `/v1/installations/*`. Used by the CLI and any operator script that
 * wants to drive installs / deploys / rollbacks without re-implementing
 * the request envelopes.
 *
 * This module replaces the prior `takosumi-git/packages/deploy-client/
 * src/mod.ts` `parseManifestEnvelope` / `postDeployment` flow with the
 * new 5-endpoint surface.
 */

import {
  type DeploymentApplyRequest,
  type DeploymentApplyResponse,
  type DeploymentDryRunRequest,
  type DeploymentDryRunResponse,
  INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_ROLLBACK_PATH,
  INSTALLATIONS_DRY_RUN_PATH,
  INSTALLATIONS_PATH,
  type InstallationApplyRequest,
  type InstallationApplyResponse,
  type InstallationDryRunRequest,
  type InstallationDryRunResponse,
  type InstallerErrorEnvelope,
  type RollbackRequest,
  type RollbackResponse,
} from "@takos/takosumi-contract/installer-api";

export interface InstallerClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export class InstallerHttpError extends Error {
  readonly status: number;
  readonly envelope: InstallerErrorEnvelope;

  constructor(status: number, envelope: InstallerErrorEnvelope) {
    super(envelope.error.message);
    this.name = "InstallerHttpError";
    this.status = status;
    this.envelope = envelope;
  }
}

export class InstallerClient {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: InstallerClientOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  installDryRun(
    request: InstallationDryRunRequest,
  ): Promise<InstallationDryRunResponse> {
    return this.#post(INSTALLATIONS_DRY_RUN_PATH, request);
  }

  install(
    request: InstallationApplyRequest,
  ): Promise<InstallationApplyResponse> {
    return this.#post(INSTALLATIONS_PATH, request);
  }

  deployDryRun(
    installationId: string,
    request: DeploymentDryRunRequest,
  ): Promise<DeploymentDryRunResponse> {
    return this.#post(
      INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH(installationId),
      request,
    );
  }

  deploy(
    installationId: string,
    request: DeploymentApplyRequest,
  ): Promise<DeploymentApplyResponse> {
    return this.#post(
      INSTALLATION_DEPLOYMENTS_PATH(installationId),
      request,
    );
  }

  rollback(
    installationId: string,
    request: RollbackRequest,
  ): Promise<RollbackResponse> {
    return this.#post(INSTALLATION_ROLLBACK_PATH(installationId), request);
  }

  async #post<TBody, TResponse>(
    path: string,
    body: TBody,
  ): Promise<TResponse> {
    const response = await this.#fetch(`${this.#endpoint}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text.length === 0 ? null : JSON.parse(text);
    if (!response.ok) {
      throw new InstallerHttpError(
        response.status,
        parsed as InstallerErrorEnvelope,
      );
    }
    return parsed as TResponse;
  }
}
