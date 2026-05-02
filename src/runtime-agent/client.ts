/**
 * Lightweight HTTP client a remote runtime-agent uses to talk to the kernel.
 *
 * The agent sits *inside* the operator-owned tenant cloud (AWS EC2 / GCP
 * Compute / k8s pod / etc.) and only needs:
 *
 *   - the kernel base URL,
 *   - the shared internal-service secret,
 *   - the agent's stable identity (provider id + capabilities + host key
 *     digest),
 *   - the kernel-trusted Ed25519 public key it uses to verify the gateway's
 *     {@link SignedGatewayManifest}.
 *
 * Provider plugins are imported separately and registered as `executors` with
 * the {@link RuntimeAgentLoop}.
 *
 * ## Why a signed gateway manifest?
 *
 * The kernel base URL is operator-injected. A malicious operator can swap
 * the URL for an attacker-owned host that captures every signed RPC the
 * agent emits. The agent therefore:
 *
 *  1. Fetches a {@link SignedGatewayManifest} on startup (out-of-band keyed
 *     by the kernel-trusted Ed25519 key the operator-bootstrap configured),
 *  2. Verifies the manifest binds the *exact* URL it was told to talk to,
 *  3. Pins the manifest's per-RPC signing pubkey for the lifetime of the
 *     process, and
 *  4. Verifies an Ed25519 identity signature on every response before it
 *     trusts a single byte.
 *
 * Any mismatch is fail-closed (`GatewayManifestVerificationError` /
 * `GatewayResponseSignatureError`). Cert pinning (TLS public key SHA-256
 * baked into the manifest) is supported via `verifyConnectionPin`.
 */
import {
  type GatewayManifest,
  resolveRuntimeAgentRpcPath,
  RUNTIME_AGENT_RPC_PATHS,
  type RuntimeAgentDrainRequest,
  type RuntimeAgentHeartbeat,
  type RuntimeAgentHeartbeatResponse,
  type RuntimeAgentLeaseRequest,
  type RuntimeAgentLeaseResponse,
  type RuntimeAgentRegistration,
  type RuntimeAgentRegistrationResponse,
  type RuntimeAgentReport,
  type RuntimeAgentReportResponse,
  type SignedGatewayManifest,
  signTakosInternalRequest,
  TAKOS_GATEWAY_IDENTITY_NONCE_HEADER,
  TAKOS_GATEWAY_IDENTITY_REQUEST_ID_HEADER,
  TAKOS_GATEWAY_IDENTITY_SIGNATURE_HEADER,
  TAKOS_GATEWAY_IDENTITY_TIMESTAMP_HEADER,
  type TakosActorContext,
  verifyGatewayManifest,
  verifyGatewayResponseSignature,
} from "takosumi-contract";

const TAKOS_RUNTIME_AGENT_CALLER = "takos-runtime-agent";
const TAKOS_PAAS_AUDIENCE = "takos-paas";

export interface RuntimeAgentHttpClientOptions {
  readonly baseUrl: string;
  readonly internalServiceSecret: string;
  /** Used in {@link TakosActorContext} on every request. */
  readonly actor: TakosActorContext;
  /**
   * Base64-encoded Ed25519 public key the agent trusts to sign gateway
   * manifests. Operator-bootstrap installs this on the agent process (env
   * var, mounted file, etc.) — it must be delivered out-of-band so a
   * malicious URL cannot swap it.
   */
  readonly trustedManifestPubkey: string;
  /**
   * Provider kind (e.g. `aws.ecs-fargate`) the agent serves. The manifest's
   * `allowedProviderKinds` must contain it.
   */
  readonly providerKind: string;
  /** Agent id, used to scope the manifest fetch. */
  readonly agentId: string;
  /**
   * Optional cert-pin verifier. When the manifest carries
   * `tlsPubkeySha256`, the client invokes this hook with the pinned digest
   * before issuing the first RPC. Throw to fail-closed.
   */
  readonly verifyConnectionPin?: (input: {
    readonly tlsPubkeySha256: string;
    readonly gatewayUrl: string;
  }) => Promise<void> | void;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
  /**
   * Maximum permitted clock skew between the agent and the gateway when
   * verifying a per-response identity signature. Default 5 minutes.
   */
  readonly maxResponseClockSkewMs?: number;
}

export class RuntimeAgentRpcError extends Error {
  override readonly name = "RuntimeAgentRpcError";
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`runtime-agent rpc ${path} failed with ${status}`);
  }
}

export class GatewayManifestVerificationError extends Error {
  override readonly name = "GatewayManifestVerificationError";
  constructor(
    readonly reason: string,
    readonly gatewayUrl: string,
  ) {
    super(
      `gateway manifest verification failed for ${gatewayUrl}: ${reason}`,
    );
  }
}

export class GatewayResponseSignatureError extends Error {
  override readonly name = "GatewayResponseSignatureError";
  constructor(readonly path: string) {
    super(`gateway response identity signature missing or invalid for ${path}`);
  }
}

/**
 * Minimal HTTP wrapper. Each call signs the request with the kernel's shared
 * internal-service secret using the canonical `signTakosInternalRequest` helper,
 * and verifies the kernel's Ed25519 identity signature on the response.
 */
export class RuntimeAgentHttpClient {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #actor: TakosActorContext;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;
  readonly #trustedManifestPubkey: string;
  readonly #providerKind: string;
  readonly #agentId: string;
  readonly #verifyConnectionPin?: (input: {
    readonly tlsPubkeySha256: string;
    readonly gatewayUrl: string;
  }) => Promise<void> | void;
  readonly #maxResponseClockSkewMs: number;
  #pinnedManifest: GatewayManifest | undefined;

  constructor(options: RuntimeAgentHttpClientOptions) {
    this.#baseUrl = trimTrailingSlash(options.baseUrl);
    this.#secret = options.internalServiceSecret;
    this.#actor = options.actor;
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#trustedManifestPubkey = options.trustedManifestPubkey;
    this.#providerKind = options.providerKind;
    this.#agentId = options.agentId;
    this.#verifyConnectionPin = options.verifyConnectionPin;
    this.#maxResponseClockSkewMs = options.maxResponseClockSkewMs ??
      5 * 60 * 1000;
  }

  /** Returns the gateway manifest pinned for this client (if loaded). */
  get pinnedManifest(): GatewayManifest | undefined {
    return this.#pinnedManifest;
  }

  /**
   * Fetch and verify the gateway manifest. Pins it on success. Throws
   * {@link GatewayManifestVerificationError} on any tampering / mismatch.
   */
  async loadGatewayManifest(): Promise<GatewayManifest> {
    const basePath = resolveRuntimeAgentRpcPath(
      RUNTIME_AGENT_RPC_PATHS.gatewayManifest,
      this.#agentId,
    );
    const url = `${this.#baseUrl}${basePath}`;
    const body = JSON.stringify({ gatewayUrl: this.#baseUrl });
    // Sign as a regular internal POST so the kernel can authorise the
    // bootstrap itself.
    const timestamp = this.#clock().toISOString();
    const signed = await signTakosInternalRequest({
      method: "POST",
      path: basePath,
      body,
      timestamp,
      actor: this.#actor,
      secret: this.#secret,
      caller: TAKOS_RUNTIME_AGENT_CALLER,
      audience: TAKOS_PAAS_AUDIENCE,
    });
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { ...signed.headers, "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new RuntimeAgentRpcError(response.status, basePath, parsed);
    }
    const signedManifest = parsed as SignedGatewayManifest | undefined;
    if (
      !signedManifest || typeof signedManifest !== "object" ||
      !signedManifest.manifest || !signedManifest.signature
    ) {
      throw new GatewayManifestVerificationError(
        "missing signed manifest envelope",
        this.#baseUrl,
      );
    }
    const verification = await verifyGatewayManifest({
      signed: signedManifest,
      trustedPubkey: this.#trustedManifestPubkey,
      expectedGatewayUrl: this.#baseUrl,
      expectedAgentId: this.#agentId,
      expectedProviderKind: this.#providerKind,
      now: this.#clock,
    });
    if (!verification.ok) {
      throw new GatewayManifestVerificationError(
        verification.reason,
        this.#baseUrl,
      );
    }
    if (verification.manifest.tlsPubkeySha256 && this.#verifyConnectionPin) {
      await this.#verifyConnectionPin({
        tlsPubkeySha256: verification.manifest.tlsPubkeySha256,
        gatewayUrl: this.#baseUrl,
      });
    }
    this.#pinnedManifest = verification.manifest;
    return verification.manifest;
  }

  enroll(
    payload: RuntimeAgentRegistration,
  ): Promise<RuntimeAgentRegistrationResponse> {
    return this.#postJson(RUNTIME_AGENT_RPC_PATHS.enroll, payload);
  }

  heartbeat(
    payload: RuntimeAgentHeartbeat,
  ): Promise<RuntimeAgentHeartbeatResponse> {
    return this.#postJson(
      resolveRuntimeAgentRpcPath(
        RUNTIME_AGENT_RPC_PATHS.heartbeat,
        payload.agentId,
      ),
      payload,
    );
  }

  leaseWork(
    payload: RuntimeAgentLeaseRequest,
  ): Promise<RuntimeAgentLeaseResponse> {
    return this.#postJson(
      resolveRuntimeAgentRpcPath(
        RUNTIME_AGENT_RPC_PATHS.lease,
        payload.agentId,
      ),
      payload,
    );
  }

  report(payload: RuntimeAgentReport): Promise<RuntimeAgentReportResponse> {
    return this.#postJson(
      resolveRuntimeAgentRpcPath(
        RUNTIME_AGENT_RPC_PATHS.report,
        payload.agentId,
      ),
      payload,
    );
  }

  drain(payload: RuntimeAgentDrainRequest): Promise<void> {
    return this.#postJson<void>(
      resolveRuntimeAgentRpcPath(
        RUNTIME_AGENT_RPC_PATHS.drain,
        payload.agentId,
      ),
      payload,
    );
  }

  async #postJson<TResponse>(
    path: string,
    payload: unknown,
  ): Promise<TResponse> {
    const body = JSON.stringify(payload);
    const timestamp = this.#clock().toISOString();
    const signed = await signTakosInternalRequest({
      method: "POST",
      path,
      body,
      timestamp,
      actor: this.#actor,
      secret: this.#secret,
      caller: TAKOS_RUNTIME_AGENT_CALLER,
      audience: TAKOS_PAAS_AUDIENCE,
    });
    const url = `${this.#baseUrl}${path}`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { ...signed.headers, "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new RuntimeAgentRpcError(response.status, path, parsed);
    }
    await this.#verifyResponseIdentity({
      method: "POST",
      path,
      body: text,
      response,
    });
    return parsed as TResponse;
  }

  async #verifyResponseIdentity(input: {
    readonly method: string;
    readonly path: string;
    readonly body: string;
    readonly response: Response;
  }): Promise<void> {
    const manifest = this.#pinnedManifest;
    if (!manifest) {
      throw new GatewayResponseSignatureError(input.path);
    }
    const signature = input.response.headers.get(
      TAKOS_GATEWAY_IDENTITY_SIGNATURE_HEADER,
    );
    const timestamp = input.response.headers.get(
      TAKOS_GATEWAY_IDENTITY_TIMESTAMP_HEADER,
    );
    const requestId = input.response.headers.get(
      TAKOS_GATEWAY_IDENTITY_REQUEST_ID_HEADER,
    );
    const nonce = input.response.headers.get(
      TAKOS_GATEWAY_IDENTITY_NONCE_HEADER,
    );
    if (!signature || !timestamp || !requestId || !nonce) {
      throw new GatewayResponseSignatureError(input.path);
    }
    const valid = await verifyGatewayResponseSignature({
      manifest,
      method: input.method,
      path: input.path,
      body: input.body,
      signature,
      timestamp,
      requestId,
      nonce,
      now: this.#clock,
      maxClockSkewMs: this.#maxResponseClockSkewMs,
    });
    if (!valid) throw new GatewayResponseSignatureError(input.path);
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
