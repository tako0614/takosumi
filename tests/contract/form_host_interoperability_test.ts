import { expect, test } from "bun:test";
import {
  createTakoformHostDiscovery,
  portableTypeForShapeKind,
  shapeKindForPortableType,
} from "../../contract/form-host-interoperability.ts";

test("Takoform discovery advertises the exact Form Definition endpoint", () => {
  const discovery = createTakoformHostDiscovery("https://host.test/");
  expect(discovery.endpoints).toEqual({
    api: "https://host.test/apis/forms.takoform.com/v1alpha1",
    forms: "https://host.test/apis/forms.takoform.com/v1alpha1/forms",
    form_definitions:
      "https://host.test/apis/forms.takoform.com/v1alpha1/form-definitions",
  });
});

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
