/**
 * HTTP client for Takosumi's OpenTofu deployment-control-plane API.
 */

import {
  APPLY_RUN_PATH,
  APPLY_RUNS_PATH,
  type ApplyRunResponse,
  type CreateApplyRunRequest,
  type CreatePlanRunRequest,
  type GetInstallationResponse,
  INSTALLATION_DEPLOYMENT_OUTPUTS_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_PATH,
  type DeployControlErrorEnvelope,
  type ListDeploymentOutputsResponse,
  type ListDeploymentsResponse,
  type ListRunnerProfilesResponse,
  PLAN_RUN_PATH,
  PLAN_RUNS_PATH,
  type PlanRunResponse,
  RUNNER_PROFILES_PATH,
} from "takosumi-contract/deploy-control-api";

export interface DeployControlClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export class DeployControlHttpError extends Error {
  readonly status: number;
  readonly envelope: DeployControlErrorEnvelope;

  constructor(status: number, envelope: DeployControlErrorEnvelope) {
    super(envelope.error.message);
    this.name = "DeployControlHttpError";
    this.status = status;
    this.envelope = envelope;
  }
}

export class DeployControlClient {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: DeployControlClientOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  listRunnerProfiles(): Promise<ListRunnerProfilesResponse> {
    return this.#get(RUNNER_PROFILES_PATH);
  }

  createPlanRun(request: CreatePlanRunRequest): Promise<PlanRunResponse> {
    return this.#post(PLAN_RUNS_PATH, request);
  }

  getPlanRun(id: string): Promise<PlanRunResponse> {
    return this.#get(PLAN_RUN_PATH(id));
  }

  createApplyRun(request: CreateApplyRunRequest): Promise<ApplyRunResponse> {
    return this.#post(APPLY_RUNS_PATH, request);
  }

  getApplyRun(id: string): Promise<ApplyRunResponse> {
    return this.#get(APPLY_RUN_PATH(id));
  }

  getInstallation(id: string): Promise<GetInstallationResponse> {
    return this.#get(INSTALLATION_PATH(id));
  }

  listDeployments(id: string): Promise<ListDeploymentsResponse> {
    return this.#get(INSTALLATION_DEPLOYMENTS_PATH(id));
  }

  listDeploymentOutputs(id: string): Promise<ListDeploymentOutputsResponse> {
    return this.#get(INSTALLATION_DEPLOYMENT_OUTPUTS_PATH(id));
  }

  #get<TResponse>(path: string): Promise<TResponse> {
    return this.#request<TResponse>(path, { method: "GET" });
  }

  #post<TBody, TResponse>(
    path: string,
    body: TBody,
  ): Promise<TResponse> {
    return this.#request<TResponse>(path, {
      method: "POST",
      body,
    });
  }

  async #request<TResponse>(
    path: string,
    input: { readonly method: "GET" | "POST"; readonly body?: unknown },
  ): Promise<TResponse> {
    const response = await this.#fetch(`${this.#endpoint}${path}`, {
      method: input.method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#token}`,
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
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
      throw new DeployControlHttpError(
        response.status,
        isErrorEnvelope(parsed)
          ? parsed
          : synthesizeErrorEnvelope(response, text, parseFailed),
      );
    }
    if (parseFailed) {
      throw new DeployControlHttpError(
        response.status,
        synthesizeErrorEnvelope(response, text, true),
      );
    }
    return parsed as TResponse;
  }
}

function isErrorEnvelope(value: unknown): value is DeployControlErrorEnvelope {
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
): DeployControlErrorEnvelope {
  const detail = parseFailed
    ? "response body was not valid JSON"
    : "response body did not match the deploy control error envelope";
  const snippet = body.slice(0, 200);
  return {
    error: {
      code: "internal_error",
      message:
        `deploy control responded with HTTP ${response.status} ${response.statusText}: ${detail}` +
        (snippet.length > 0 ? ` (body: ${snippet})` : ""),
      requestId: "",
    },
  };
}
