// takos-secret-scan: synthetic — every value here is a literal fixture string.
//
// The contract this file pins: Takosumi OSS learns a Capsule's public origin by
// ASKING its host composition over the provider-neutral platform-extension
// seam, and never by deriving one. The envelope is therefore the whole
// interface, and it is pinned byte-exactly on both sides: the Hosted parser
// that receives it accepts closed key sets only, so a field this side adds,
// renames, or reorders into a different set is a hard 400 in production and a
// failing assertion here.
import { expect, spyOn, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import {
  capsulePublicOriginFromPlatformExtensions,
  capsulePublicOriginRequestedLabel,
  platformExtensionProviderCredentialComposition,
  type PlatformExtensionCapsulePublicOriginLedger,
} from "../../../deploy/platform/platform_extension_provider_credentials.ts";
import type { CapsulePublicOriginReservation } from "../../../contract/capsules.ts";

const ISSUER = "https://app.takosumi.test";
const PROVIDER_SOURCE = "registry.terraform.io/tako0614/takoform";
const ORIGIN = "https://yurucommu-abcdef.takoform.app";

/**
 * The exact route a Hosted-style composition installs. `publicInputPath` is the
 * only thing that says this extension can answer the origin question at all.
 */
function routes(
  overrides: Record<string, unknown> = {},
  handlerKey = "HOSTED",
): string {
  return JSON.stringify([
    {
      basePath: "/extensions/hosted/marketplace",
      handlerKey,
      authDelivery: "context",
      workspaceContext: "query-required",
      requiredScopes: [],
      runCredential: {
        audience: "takosumi-hosted.takoform.v1",
        requiredScopes: ["takoform.run"],
      },
      providerCredentialBroker: {
        connectionId: "conn_takosumiHostedTakoform01",
        recipeId: "takosumi-hosted-takoform-run",
        providerSource: PROVIDER_SOURCE,
        displayName: "Takosumi Hosted",
        exchangePath: "/provider-credentials/takoform",
        publicInputExchangePath: "/public-inputs/http-endpoint",
        publicInputCapabilities: ["http_endpoint_url"],
        envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
        runCredentialSettings: { requiredAvailableMinor: 2300 },
        runtimeInputs: {
          contract: "takosumi.provider-runtime-inputs/v1",
          nonceArgument: "runtime_input_nonce",
          mapArgument: "runtime_inputs",
          minimumProviderVersion: "4.0.0",
        },
        ...overrides,
      },
    },
  ]);
}

function capsule(overrides: Partial<Capsule> = {}): Capsule {
  return {
    id: "cap_yurucommu",
    workspaceId: "workspace_abcdef123456",
    projectId: "prj_default",
    name: "Yurucommu",
    slug: "yurucommu",
    sourceId: "src_1",
    installConfigId: "icfg_1",
    environment: "production",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function installConfig(overrides: Partial<InstallConfig> = {}): InstallConfig {
  return {
    id: "icfg_1",
    workspaceId: "workspace_abcdef123456",
    name: "Yurucommu",
    variableMapping: { project_name: "yurucommu" },
    installExperience: {
      projections: [{ kind: "service_name", variable: "project_name" }],
    },
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as InstallConfig;
}

function memoryLedger(
  seed?: CapsulePublicOriginReservation,
): PlatformExtensionCapsulePublicOriginLedger & {
  readonly current: () => CapsulePublicOriginReservation | undefined;
} {
  let held = seed;
  return {
    read: async () => held,
    write: async (_capsuleId, reservation) => {
      held = reservation;
    },
    current: () => held,
  };
}

function reservationHandler(
  responses: readonly { readonly status: number; readonly body: unknown }[],
) {
  const calls: unknown[] = [];
  let index = 0;
  return {
    calls,
    handler: {
      exchangeProviderPublicInput: async (input: unknown) => {
        calls.push(input);
        const next = responses[Math.min(index, responses.length - 1)]!;
        index += 1;
        return { status: next.status, body: JSON.stringify(next.body) };
      },
    },
  };
}

const RESERVED = {
  kind: "takosumi.provider-public-input-reservation@v1",
  publicInputs: {
    httpEndpointUrl: ORIGIN,
    reservationRef: "tshpr_opaque_reference",
  },
};

test("the first ask is a reservation request with the exact Hosted key sets", async () => {
  const { calls, handler } = reservationHandler([
    { status: 200, body: RESERVED },
  ]);
  const ledger = memoryLedger();
  const port = capsulePublicOriginFromPlatformExtensions(
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: routes(),
      TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
      HOSTED: handler,
    },
    ledger,
    () => new Date("2026-09-01T12:00:00.000Z"),
  );
  expect(port).toBeDefined();

  expect(
    await port!.resolve({ capsule: capsule(), installConfig: installConfig() }),
  ).toBe(ORIGIN);

  // Byte-exact envelope. Every one of these key sets is compared with an
  // exact-key check on the receiving side, so an extra or missing member is a
  // 400 rather than a tolerated difference.
  expect(calls).toHaveLength(1);
  const sent = calls[0] as {
    url: string;
    request: Record<string, unknown>;
    context: Record<string, unknown>;
  };
  expect(Object.keys(sent).sort()).toEqual(["context", "request", "url"]);
  expect(sent.url).toBe(
    "https://app.takosumi.test/extensions/hosted/marketplace/public-inputs/http-endpoint",
  );
  // The public-input route is an exact leaf: a query string it does not expect
  // (the credential lane appends one) is rejected outright.
  expect(new URL(sent.url).search).toBe("");
  expect(sent.context).toEqual({
    authKind: "provider-public-input",
    providerSource: PROVIDER_SOURCE,
    workspaceId: "workspace_abcdef123456",
  });
  expect(Object.keys(sent.request).sort()).toEqual([
    "kind",
    "providerSource",
    "publicInputs",
    "settings",
  ]);
  expect(sent.request.kind).toBe(
    "takosumi.provider-public-input-reservation-request@v1",
  );
  expect(sent.request.providerSource).toBe(PROVIDER_SOURCE);
  expect(sent.request.settings).toEqual({ requiredAvailableMinor: 2300 });
  const publicInputs = sent.request.publicInputs as {
    httpEndpointUrl: Record<string, unknown>;
  };
  expect(Object.keys(publicInputs)).toEqual(["httpEndpointUrl"]);
  // A first ask carries NO reservationRef: presence of the reference is exactly
  // what the host reads as "read the one you already fixed".
  expect(Object.keys(publicInputs.httpEndpointUrl).sort()).toEqual([
    "clientIdempotencyKey",
    "requestedSubdomain",
  ]);
  expect(publicInputs.httpEndpointUrl.clientIdempotencyKey).toMatch(
    /^endpoint_request_[a-f0-9]{64}$/u,
  );
  expect(publicInputs.httpEndpointUrl.requestedSubdomain).toBe(
    "yurucommu-abcdef",
  );

  expect(ledger.current()).toEqual({
    reservationRef: "tshpr_opaque_reference",
    origin: ORIGIN,
    requestedLabel: "yurucommu-abcdef",
    reservedAt: "2026-09-01T12:00:00.000Z",
  });
});

test("a held reservation is read back, never prepared a second time", async () => {
  const { calls, handler } = reservationHandler([
    { status: 200, body: RESERVED },
  ]);
  const ledger = memoryLedger({
    reservationRef: "tshpr_opaque_reference",
    origin: ORIGIN,
    requestedLabel: "yurucommu-abcdef",
    reservedAt: "2026-09-01T12:00:00.000Z",
  });
  const port = capsulePublicOriginFromPlatformExtensions(
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: routes(),
      TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
      HOSTED: handler,
    },
    ledger,
  );
  expect(
    await port!.resolve({ capsule: capsule(), installConfig: installConfig() }),
  ).toBe(ORIGIN);
  const sent = calls[0] as { request: { publicInputs: { httpEndpointUrl: object } } };
  expect(
    Object.keys(sent.request.publicInputs.httpEndpointUrl).sort(),
  ).toEqual(["clientIdempotencyKey", "requestedSubdomain", "reservationRef"]);
  // Plan and Apply both call the port. Asking for a NEW origin on the second
  // call would burn a reservation and move the redirect URI a reviewed plan
  // already committed to.
  expect(calls).toHaveLength(1);
});

test("an origin that moved under a held reservation fails the pinned descriptor", async () => {
  const { handler } = reservationHandler([
    {
      status: 200,
      body: {
        kind: "takosumi.provider-public-input-reservation@v1",
        publicInputs: {
          httpEndpointUrl: "https://someone-else.takoform.app",
          reservationRef: "tshpr_opaque_reference",
        },
      },
    },
  ]);
  const port = capsulePublicOriginFromPlatformExtensions(
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: routes(),
      TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
      HOSTED: handler,
    },
    memoryLedger({
      reservationRef: "tshpr_opaque_reference",
      origin: ORIGIN,
      requestedLabel: "yurucommu-abcdef",
      reservedAt: "2026-09-01T12:00:00.000Z",
    }),
  );
  // A reservation can lapse and be handed to someone else. Registering the new
  // origin as a redirect URI would silently repoint the Capsule's login.
  await expect(
    port!.resolve({ capsule: capsule(), installConfig: installConfig() }),
  ).rejects.toThrow("no longer matches the pinned origin");
});

test("a non-2xx or malformed answer fails closed with no origin and no ledger write", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const response of [
      { status: 503, body: { error: { code: "provider_public_input_unavailable" } } },
      { status: 200, body: { kind: "takosumi.provider-public-input-reservation@v1" } },
      {
        status: 200,
        body: {
          kind: "takosumi.provider-public-input-reservation@v1",
          publicInputs: {
            httpEndpointUrl: ORIGIN,
            reservationRef: "tshpr_ref",
            extra: "widened",
          },
        },
      },
      {
        status: 200,
        body: {
          kind: "takosumi.provider-public-input-reservation@v1",
          publicInputs: {
            // Not an exact HTTPS origin: a path is a hostname claim this lane
            // is not allowed to interpret.
            httpEndpointUrl: "https://app.takoform.app/tenant",
            reservationRef: "tshpr_ref",
          },
        },
      },
    ]) {
      const { handler } = reservationHandler([response]);
      const ledger = memoryLedger();
      const port = capsulePublicOriginFromPlatformExtensions(
        {
          TAKOSUMI_PLATFORM_EXTENSIONS: routes(),
          TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
          HOSTED: handler,
        },
        ledger,
      );
      expect(
        await port!.resolve({
          capsule: capsule(),
          installConfig: installConfig(),
        }),
      ).toBeUndefined();
      expect(ledger.current()).toBeUndefined();
    }
    // Only the non-secret boundary is ever logged.
    for (const call of warn.mock.calls) {
      const entry = JSON.parse(call[0] as string) as Record<string, unknown>;
      expect(Object.keys(entry).sort()).toEqual(
        entry.status === undefined ? ["event", "stage"] : ["event", "stage", "status"],
      );
      expect(entry.event).toBe(
        "platform_extension_provider_public_input_exchange_failed",
      );
    }
  } finally {
    warn.mockRestore();
  }
});

test("a route that cannot answer the question composes no port at all", () => {
  expect(
    capsulePublicOriginFromPlatformExtensions(
      {
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify(
          JSON.parse(routes()).map((route: Record<string, unknown>) => ({
            ...route,
            providerCredentialBroker: {
              connectionId: "conn_takosumiHostedTakoform01",
              recipeId: "takosumi-hosted-takoform-run",
              providerSource: PROVIDER_SOURCE,
              displayName: "Takosumi Hosted",
              exchangePath: "/provider-credentials/takoform",
              envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
            },
          })),
        ),
        TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
        HOSTED: { exchangeProviderPublicInput: async () => ({ status: 200, body: "{}" }) },
      },
      memoryLedger(),
    ),
  ).toBeUndefined();
});

test("two routes claiming the same question fail closed instead of picking one", () => {
  const one = JSON.parse(routes()) as Record<string, unknown>[];
  const two = JSON.parse(routes({}, "OTHER")) as Record<string, unknown>[];
  two[0]!.basePath = "/extensions/other/marketplace";
  two[0]!.runCredential = {
    audience: "other-host.takoform.v1",
    requiredScopes: ["takoform.run"],
  };
  two[0]!.providerCredentialBroker = {
    ...(two[0]!.providerCredentialBroker as Record<string, unknown>),
    connectionId: "conn_otherTakoform0001",
    recipeId: "other-takoform-run",
  };
  expect(() =>
    capsulePublicOriginFromPlatformExtensions(
      {
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([...one, ...two]),
        TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
      },
      memoryLedger(),
    ),
  ).toThrow("a Capsule has one public origin");
});

test("release sends the release kind and clears the ledger only when confirmed", async () => {
  const held: CapsulePublicOriginReservation = {
    reservationRef: "tshpr_opaque_reference",
    origin: ORIGIN,
    requestedLabel: "yurucommu-abcdef",
    reservedAt: "2026-09-01T12:00:00.000Z",
  };
  const { calls, handler } = reservationHandler([
    {
      status: 200,
      body: {
        kind: "takosumi.provider-public-input-release@v1",
        status: "released",
        reservationRef: "tshpr_opaque_reference",
      },
    },
  ]);
  const ledger = memoryLedger(held);
  const port = capsulePublicOriginFromPlatformExtensions(
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: routes(),
      TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
      HOSTED: handler,
    },
    ledger,
  );
  await port!.release({
    workspaceId: "workspace_abcdef123456",
    capsuleId: "cap_yurucommu",
  });
  const sent = calls[0] as {
    request: { kind: string; publicInputs: { httpEndpointUrl: object } };
  };
  expect(sent.request.kind).toBe(
    "takosumi.provider-public-input-reservation-release@v1",
  );
  // A release must name the reservation; the receiving parser rejects a release
  // that does not.
  expect(
    Object.keys(sent.request.publicInputs.httpEndpointUrl).sort(),
  ).toEqual(["clientIdempotencyKey", "requestedSubdomain", "reservationRef"]);
  expect(ledger.current()).toBeUndefined();

  // An unconfirmed release keeps the reference: forgetting one the host still
  // holds would leak the origin with nothing left able to release it.
  const failing = reservationHandler([{ status: 503, body: {} }]);
  const keptLedger = memoryLedger(held);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await capsulePublicOriginFromPlatformExtensions(
      {
        TAKOSUMI_PLATFORM_EXTENSIONS: routes(),
        TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
        HOSTED: failing.handler,
      },
      keptLedger,
    )!.release({
      workspaceId: "workspace_abcdef123456",
      capsuleId: "cap_yurucommu",
    });
  } finally {
    warn.mockRestore();
  }
  expect(keptLedger.current()).toEqual(held);
});

test("the requested label is the reviewed service name, scoped to the Workspace", () => {
  // One reservation namespace is shared by every Workspace on a host, and the
  // reviewed name of a popular app is the same string in all of them.
  expect(
    capsulePublicOriginRequestedLabel({
      capsule: capsule(),
      installConfig: installConfig(),
    }),
  ).toBe("yurucommu-abcdef");
  expect(
    capsulePublicOriginRequestedLabel({
      capsule: capsule({ workspaceId: "workspace_zzzzzz999999" }),
      installConfig: installConfig(),
    }),
  ).toBe("yurucommu-zzzzzz");
  // A manifest that already scoped its own service name is not scoped twice.
  expect(
    capsulePublicOriginRequestedLabel({
      capsule: capsule(),
      installConfig: installConfig({
        variableMapping: { project_name: "yurucommu-abcdef" },
      }),
    }),
  ).toBe("yurucommu-abcdef");
  // No service-name projection: the Capsule's own slug is the reviewed name.
  expect(
    capsulePublicOriginRequestedLabel({
      capsule: capsule(),
      installConfig: installConfig({
        installExperience: { projections: [] },
        variableMapping: {},
      }),
    }),
  ).toBe("yurucommu-abcdef");
});

test("the broker recipe declares the run-scoped input protocol its route pinned", () => {
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: routes(),
    TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
  });
  // Without this descriptor a Hosted broker Connection is invisible to the
  // run-scoped lane, and a Capsule whose manifest asks for binding-delivered
  // values has nowhere to deliver them.
  expect(
    composition?.credentialRecipes[0]?.authModes.broker?.runtimeInputs,
  ).toEqual({
    contract: "takosumi.provider-runtime-inputs/v1",
    nonceArgument: "runtime_input_nonce",
    mapArgument: "runtime_inputs",
    minimumProviderVersion: "4.0.0",
  });
});

test("a route may not declare a public-input path it cannot canonicalize", () => {
  for (const broken of [
    { publicInputExchangePath: "/provider-credentials/takoform" },
    { publicInputExchangePath: "public-inputs" },
    { publicInputExchangePath: "/" },
  ]) {
    expect(() =>
      platformExtensionProviderCredentialComposition({
        TAKOSUMI_PLATFORM_EXTENSIONS: routes(broken),
        TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
      }),
    ).toThrow("publicInputExchangePath is invalid");
  }
  expect(() =>
    platformExtensionProviderCredentialComposition({
      TAKOSUMI_PLATFORM_EXTENSIONS: routes({
        runtimeInputs: {
          contract: "takosumi.provider-runtime-inputs/v1",
          nonceArgument: "runtime_input_nonce",
          mapArgument: "runtime_input_nonce",
          minimumProviderVersion: "4.0.0",
        },
      }),
      TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
    }),
  ).toThrow("runtimeInputs is invalid");
});

test("apply carries the plan-pinned reservation into the credential exchange", async () => {
  const exchanges: unknown[] = [];
  const composition = platformExtensionProviderCredentialComposition(
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: routes(),
      TAKOSUMI_ACCOUNTS_ISSUER: ISSUER,
      HOSTED: {
        exchangeProviderCredential: async (input: unknown) => {
          exchanges.push(input);
          return {
            status: 200,
            body: JSON.stringify({
              kind: "takosumi.provider-run-credential@v1",
              env: {
                TAKOFORM_ENDPOINT: "https://api.takoserver.test",
                TAKOFORM_SPACE: "tenant:tsh_opaque",
                TAKOFORM_TOKEN: "tfr_runner_only",
              },
              expiresAt: "2026-09-01T12:05:00.000Z",
            }),
          };
        },
      },
    },
    {
      capsulePublicOriginReservations: memoryLedger({
        reservationRef: "tshpr_opaque_reference",
        origin: ORIGIN,
        requestedLabel: "yurucommu-abcdef",
        reservedAt: "2026-09-01T12:00:00.000Z",
      }),
    },
  );
  const driver =
    composition?.credentialRecipeDrivers["takosumi-hosted-takoform-run/broker"];
  await driver!.mint!({
    connection: {
      id: "conn_takosumiHostedTakoform01",
      workspaceId: "operator",
      provider: PROVIDER_SOURCE,
      providerSource: PROVIDER_SOURCE,
      scope: { kind: "operator" },
      materialization: "run-issued",
      status: "verified",
      envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
      requiredEnvGroups: [
        ["TAKOFORM_ENDPOINT"],
        ["TAKOFORM_SPACE"],
        ["TAKOFORM_TOKEN"],
      ],
      credentialRecipe: {
        id: "takosumi-hosted-takoform-run",
        authMode: "broker",
      },
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
    runCredentialSettings: { requiredAvailableMinor: 2300 },
    values: {},
    files: [],
    run: {
      workspaceId: "workspace_abcdef123456",
      capsuleId: "cap_yurucommu",
      runId: "run_1",
      installingPrincipalId: "tsub_installer",
      phase: "apply",
      lifecycleIntent: "provision",
    },
    issueRunCredential: async () => ({
      token: "platform_run_token",
      expiresAt: "2026-09-01T12:10:00.000Z",
      ttlSeconds: 600,
    }),
    fetch: async () => {
      throw new Error("credential broker must not use an external self-fetch");
    },
    now: () => new Date("2026-09-01T12:00:00.000Z"),
    staticEvidence: () => ({
      connectionId: "conn_takosumiHostedTakoform01",
      provider: PROVIDER_SOURCE,
      temporary: false,
      ttlEnforced: false,
      secretValueStored: false,
    }),
  });
  // The host publishing the endpoint has to be told WHICH reservation this
  // Capsule's reviewed plan pinned; otherwise its endpoint apply has no origin
  // to consume and the two halves silently disagree.
  expect(
    (exchanges[0] as { request: { settings: unknown } }).request.settings,
  ).toEqual({
    requiredAvailableMinor: 2300,
    publicInputReservationRef: "tshpr_opaque_reference",
  });
});
