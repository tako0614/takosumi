import { expect, test } from "bun:test";
import {
  portableTypeForShapeKind,
  shapeKindForPortableType,
} from "../../contract/form-host-interoperability.ts";

test("Takoform kind translation retains legacy aliases and accepts open Form kinds", () => {
  expect(portableTypeForShapeKind("EdgeWorker")).toBe("edge_worker");
  expect(shapeKindForPortableType("edge_worker")).toBe("EdgeWorker");
  expect(portableTypeForShapeKind("KVStore")).toBe("kv_store");

  for (const [kind, type] of [
    ["HttpService", "http_service"],
    ["KeyValueStore", "key_value_store"],
    ["RelationalDatabase", "relational_database"],
    ["TlsCertificate", "tls_certificate"],
    ["IdentityClient", "identity_client"],
  ] as const) {
    expect(portableTypeForShapeKind(kind)).toBe(type);
    expect(shapeKindForPortableType(type)).toBe(kind);
  }
});

test("Takoform kind translation rejects malformed or unbounded tokens", () => {
  expect(portableTypeForShapeKind("httpService")).toBeUndefined();
  expect(portableTypeForShapeKind("Http Service")).toBeUndefined();
  expect(shapeKindForPortableType("HttpService")).toBeUndefined();
  expect(shapeKindForPortableType("http-service")).toBeUndefined();
});
