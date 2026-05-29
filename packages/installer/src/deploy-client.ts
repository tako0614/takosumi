/**
 * HTTP client for Takosumi's 5-endpoint installer API.
 *
 * Thin wrapper over `fetch` that knows the wire shape of
 * `/v1/installations/*`. Used by the CLI and any operator script that
 * wants to drive installs / deploys / rollbacks without re-implementing
 * the request envelopes.
 *
 * This module replaces the prior external git-installer deploy client with
 * the new 5-endpoint surface.
 */

import {
  type DeploymentApplyRequest,
  type DeploymentApplyResponse,
  type DeploymentDryRunRequest,
  type DeploymentDryRunResponse,
  INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_ROLLBACK_PATH,
  type InstallationApplyRequest,
  type InstallationApplyResponse,
  type InstallationDryRunRequest,
  type InstallationDryRunResponse,
  INSTALLATIONS_DRY_RUN_PATH,
  INSTALLATIONS_PATH,
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
    let parsed: unknown = null;
    let parseFailed = false;
    if (text.length !== 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }
    if (!response.ok) {
      // On the failure paths we most need to handle (e.g. an upstream proxy
      // returning a non-JSON 502 HTML page), surface the HTTP status rather
      // than an opaque SyntaxError, and synthesize a closed error envelope
      // when the body is missing or the wrong shape.
      throw new InstallerHttpError(
        response.status,
        isErrorEnvelope(parsed)
          ? parsed
          : synthesizeErrorEnvelope(response, text, parseFailed),
      );
    }
    if (parseFailed) {
      throw new InstallerHttpError(
        response.status,
        synthesizeErrorEnvelope(response, text, true),
      );
    }
    return parsed as TResponse;
  }
}

function isErrorEnvelope(value: unknown): value is InstallerErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, message, requestId } = error as {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
  };
  return typeof code === "string" && typeof message === "string" &&
    typeof requestId === "string";
}

function synthesizeErrorEnvelope(
  response: Response,
  body: string,
  parseFailed: boolean,
): InstallerErrorEnvelope {
  const detail = parseFailed
    ? "response body was not valid JSON"
    : "response body did not match the installer error envelope";
  const snippet = body.slice(0, 200);
  return {
    error: {
      // `internal_error` is the closest closed-envelope code for a response
      // the client could not interpret. `requestId` is empty because the
      // upstream never produced a parseable one.
      code: "internal_error",
      message:
        `installer responded with HTTP ${response.status} ${response.statusText}: ${detail}` +
        (snippet.length > 0 ? ` (body: ${snippet})` : ""),
      requestId: "",
    },
  };
}
