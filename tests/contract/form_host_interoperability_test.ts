import { expect, test } from "bun:test";
import {
  createTakoformHostDiscovery,
  TAKOFORM_FORM_HOST_FORM_DEFINITIONS_PATH,
  portableTypeForShapeKind,
  shapeKindForPortableType,
} from "../../contract/form-host-interoperability.ts";
import type {
  TakoformHostErrorCode,
  TakoformHostErrorEnvelope,
} from "../../contract/form-host-interoperability.ts";

test("Takoform host errors include the public policy denial code", () => {
  const envelope: TakoformHostErrorEnvelope = {
    error: {
      code: "policy_denied",
      message: "portable form operation was rejected",
      requestId: "req_policy_denied",
      retryable: false,
      hostCode: "deployment_admission_denied",
    },
  };
  const code: TakoformHostErrorCode = envelope.error.code;
  expect(code).toBe("policy_denied");
  expect(envelope.error.retryable).toBe(false);
  expect(envelope.error.hostCode).toBe("deployment_admission_denied");
});

test("Takoform discovery keeps the closed v1alpha1 endpoint vocabulary", () => {
  const discovery = createTakoformHostDiscovery("https://host.test/");
  expect(discovery.endpoints).toEqual({
    api: "https://host.test/apis/forms.takoform.com/v1alpha1",
    forms: "https://host.test/apis/forms.takoform.com/v1alpha1/forms",
  });
  expect(discovery.endpoints).not.toHaveProperty("form_definitions");
  expect(TAKOFORM_FORM_HOST_FORM_DEFINITIONS_PATH).toBe(
    "/apis/forms.takoform.com/v1alpha1/form-definitions",
  );
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
