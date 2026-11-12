import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createApiApp } from "../../../core/api/app.ts";
import { createInMemoryInterfaceStores, InterfaceService } from "../../../core/domains/interfaces/mod.ts";
import {
  MalformedJsonRequestError,
  readJsonObject,
  registerApiErrorHandler,
  RequestBodyTooLargeError,
} from "../../../core/api/errors.ts";

const encoder = new TextEncoder();

function streamedRequest(
  chunks: readonly Uint8Array[],
  headers: HeadersInit = {},
  cancel: () => void | Promise<void> = () => {},
  path = "/body",
) {
  let delivered = 0;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[delivered];
      if (chunk === undefined) controller.close();
      else {
        delivered++;
        controller.enqueue(chunk);
      }
    },
    cancel() {
      cancelled++;
      return cancel();
    },
  }, { highWaterMark: 0 });
  return {
    request: new Request(`https://example.test${path}`, { method: "POST", body, headers }),
    observed: () => ({ delivered, cancelled, locked: body.locked }),
  };
}

test("JSON body reader accepts the exact byte cap across chunks", async () => {
  const fixture = streamedRequest(["{\"a\":", "1}", " "].map((s) => encoder.encode(s)));
  expect(await readJsonObject(fixture.request, { maxBytes: 8 })).toEqual({ a: 1 });
  expect(fixture.observed()).toEqual({ delivered: 3, cancelled: 0, locked: false });
});

for (const declared of [undefined, "2"]) {
  test(`JSON body cap cancels at the first excess byte with no tail read: ${declared ?? "absent length"}`, async () => {
    const fixture = streamedRequest(
      ["{}", " ", " ", "unused"].map((s) => encoder.encode(s)),
      declared === undefined ? {} : { "content-length": declared },
    );
    const app = new Hono();
    registerApiErrorHandler(app);
    let effects = 0;
    app.post("/body", async (c) => {
      const value = await readJsonObject(c.req.raw, { maxBytes: 3 });
      effects++;
      return c.json(value);
    });

    const response = await app.fetch(fixture.request);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("payload_too_large");
    expect(effects).toBe(0);
    expect(fixture.observed()).toEqual({ delivered: 3, cancelled: 1, locked: false });
  });
}

test("declared oversized JSON is rejected without reading the stream", async () => {
  const fixture = streamedRequest([encoder.encode("{}")], { "content-length": "9" });
  await expect(readJsonObject(fixture.request, { maxBytes: 8 })).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  expect(fixture.observed()).toEqual({ delivered: 0, cancelled: 0, locked: false });
});

test("JSON body reader preserves BOM and split UTF-8 while counting wire bytes", async () => {
  const bytes = encoder.encode("\uFEFF{\"value\":\"é🙂\"}");
  const chunks = [...bytes].map((byte) => Uint8Array.of(byte));
  const exact = streamedRequest(chunks);
  expect(await readJsonObject(exact.request, { maxBytes: bytes.byteLength })).toEqual({ value: "é🙂" });
  const excess = streamedRequest(chunks);
  await expect(readJsonObject(excess.request, { maxBytes: bytes.byteLength - 1 })).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  expect(excess.observed().cancelled).toBe(1);
});

test("JSON body cap is not delayed or replaced by failing stream cleanup", async () => {
  for (const cancel of [
    () => Promise.reject(new Error("cleanup failed")),
    () => new Promise<void>(() => {}),
  ]) {
    const fixture = streamedRequest([encoder.encode("{} ")], {}, cancel);
    await expect(readJsonObject(fixture.request, { maxBytes: 2 })).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(fixture.observed()).toEqual({ delivered: 1, cancelled: 1, locked: false });
  }
});

test("JSON body reader preserves empty, scalar, array, invalid JSON and uncapped semantics", async () => {
  for (const text of ["", " ", "null", "1", "[]"]) {
    const request = new Request("https://example.test/body", { method: "POST", body: text });
    expect(await readJsonObject(request, { maxBytes: 8 })).toEqual({});
  }
  expect(await readJsonObject(new Request("https://example.test/body"), { maxBytes: 8 })).toEqual({});
  await expect(readJsonObject(new Request("https://example.test/body", { method: "POST", body: "{" }), { maxBytes: 8 })).rejects.toBeInstanceOf(MalformedJsonRequestError);
  expect(await readJsonObject(new Request("https://example.test/body", { method: "POST", body: "{\"ok\":true}" }))).toEqual({ ok: true });
});

test("JSON body reader preserves stream failures and releases its reader", async () => {
  const failure = new Error("fixture stream failed");
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  }, { highWaterMark: 0 });
  const request = new Request("https://example.test/body", { method: "POST", body });
  await expect(readJsonObject(request, { maxBytes: 8 })).rejects.toBe(failure);
  expect(body.locked).toBe(false);
});

test("Interface create keeps declared body rejection before service mutation", async () => {
  const stores = createInMemoryInterfaceStores();
  const service = new InterfaceService({ stores });
  const api = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: { service, getInterfaceBearerToken: () => "interface-test-token" },
    requestCorrelation: false,
  });
  const fixture = streamedRequest([encoder.encode("{}")], {
    authorization: "Bearer interface-test-token",
    "content-type": "application/json",
    "content-length": "1048577",
  }, () => {}, "/api/v1/interfaces");
  const response = await api.fetch(fixture.request);
  expect(response.status).toBe(413);
  expect((await response.json()).error.code).toBe("payload_too_large");
  expect(fixture.observed().delivered).toBe(0);
  expect((await service.list({ workspaceId: "ws_test" })).length).toBe(0);
});
