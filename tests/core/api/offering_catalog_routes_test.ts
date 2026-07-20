import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { OfferingCatalog } from "takosumi-contract";
import { registerOfferingCatalogRoutes } from "../../../core/api/offering_catalog_routes.ts";
import {
  InMemoryOfferingCatalogReader,
  OfferingCatalogAdminService,
  OfferingService,
} from "../../../core/domains/offerings/mod.ts";

const TOKEN = "operator-offering-catalog-token";
const SUBJECT_FINGERPRINT = `sha256:${"b".repeat(64)}`;

describe("generic Offering operator API", () => {
  test("publishes immutable catalogs and rejects commercial/private fields", async () => {
    const app = fixture();
    expect((await app.request("/v1/offering-catalogs")).status).toBe(401);

    const created = await request(app, "/v1/offering-catalogs", {
      method: "POST",
      body: JSON.stringify(catalog()),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(catalog());

    const idempotent = await request(app, "/v1/offering-catalogs", {
      method: "POST",
      body: JSON.stringify(catalog()),
    });
    expect(idempotent.status).toBe(200);

    const conflict = await request(app, "/v1/offering-catalogs", {
      method: "POST",
      body: JSON.stringify({
        ...catalog(),
        offerings: [{ ...catalog().offerings[0], profile: "changed" }],
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("failed_precondition");

    const commercial = catalog() as OfferingCatalog & {
      offerings: Array<
        OfferingCatalog["offerings"][number] & { price: number }
      >;
    };
    commercial.offerings[0] = {
      ...commercial.offerings[0]!,
      price: 100,
    };
    const rejected = await request(app, "/v1/offering-catalogs", {
      method: "POST",
      body: JSON.stringify({ ...commercial, version: "commercial" }),
    });
    expect(rejected.status).toBe(400);
    expect(await errorCode(rejected)).toBe("invalid_argument");
  });

  test("lists, reads, evaluates, and resolves exact non-Form offerings", async () => {
    const app = fixture();
    await request(app, "/v1/offering-catalogs", {
      method: "POST",
      body: JSON.stringify(catalog()),
    });

    const list = await request(app, "/v1/offering-catalogs?limit=1");
    expect(list.status).toBe(200);
    expect(
      (
        (await list.json()) as { catalogs: readonly OfferingCatalog[] }
      ).catalogs.map((entry) => entry.id),
    ).toEqual(["public-services"]);

    const read = await request(
      app,
      "/v1/offering-catalogs/public-services/versions/2026-07-20",
    );
    expect(read.status).toBe(200);
    expect(
      ((await read.json()) as OfferingCatalog).offerings[0]?.subject.type,
    ).toBe("services.example.test/v1/Endpoint");

    const availability = await request(app, "/v1/offering-availability/query", {
      method: "POST",
      body: JSON.stringify({
        catalogId: "public-services",
        catalogVersion: "2026-07-20",
      }),
    });
    expect(availability.status).toBe(200);
    expect(
      (
        (await availability.json()) as {
          availability: readonly { availableToPrincipal: boolean }[];
        }
      ).availability[0]?.availableToPrincipal,
    ).toBe(true);

    const selection = await request(app, "/v1/offering-selections/resolve", {
      method: "POST",
      body: JSON.stringify({
        reference: {
          catalogId: "public-services",
          catalogVersion: "2026-07-20",
          offeringId: "ai-gateway",
          offeringVersion: "v1",
        },
      }),
    });
    expect(selection.status).toBe(200);
    const selected = (await selection.json()) as {
      resolverId: string;
      resolutionFingerprint: string;
    };
    expect(selected.resolverId).toBe("endpoint-host");
    expect(selected.resolutionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(selected.resolutionFingerprint).not.toBe(SUBJECT_FINGERPRINT);
  });
});

function fixture(): Hono {
  const store = new InMemoryOfferingCatalogReader();
  const catalogs = new OfferingCatalogAdminService({
    store,
    now: () => "2026-07-20T00:00:00.000Z",
  });
  const offerings = new OfferingService({
    catalogs: store,
    now: () => "2026-07-20T00:00:01.000Z",
    resolvers: [
      {
        subjectType: "services.example.test/v1/Endpoint",
        resolve: async () => ({
          ready: true,
          resolverId: "endpoint-host",
          resolutionFingerprint: SUBJECT_FINGERPRINT,
        }),
      },
    ],
  });
  const app = new Hono();
  registerOfferingCatalogRoutes(app, {
    catalogs,
    offerings,
    getBearerToken: () => TOKEN,
  });
  return app;
}

function catalog(): OfferingCatalog {
  return {
    id: "public-services",
    version: "2026-07-20",
    effectiveAt: "2026-07-19T00:00:00.000Z",
    offerings: [
      {
        id: "ai-gateway",
        version: "v1",
        subject: {
          type: "services.example.test/v1/Endpoint",
          ref: "endpoint/ai-gateway",
          version: "v1",
          digest: `sha256:${"a".repeat(64)}`,
        },
        requirements: [],
        profile: "global",
        region: "global",
        maturity: "stable",
        audience: { public: true },
        status: "active",
      },
    ],
  };
}

function request(app: Hono, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}
