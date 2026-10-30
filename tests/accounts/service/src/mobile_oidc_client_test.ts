import { expect, test } from "bun:test";
import {
  composeTakosumiMobileOidcClients,
  parseTakosumiMobileBuiltinClientSetting,
  TAKOSUMI_MOBILE_BUILTIN_OIDC_CLIENT_ID,
  takosumiMobileBuiltinOidcClient,
} from "../../../../accounts/service/src/mobile-oidc-client.ts";

const MOBILE_SCOPES = ["openid", "profile", "offline_access", "capsules:read", "capsules:write"];

test("the built-in client is a public PKCE client with the exact Takosumi Mobile redirect and scopes", () => {
  expect(takosumiMobileBuiltinOidcClient()).toEqual({
    clientId: "takosumi-mobile",
    redirectUris: ["takosumi://oauth/callback"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: MOBILE_SCOPES,
    consent: "always",
    displayName: "Takosumi Mobile",
  });
});

test("composition adds the built-in client next to operator clients without touching them", () => {
  const dashboard = { clientId: "dashboard", redirectUris: ["https://app.example/cb"], tokenEndpointAuthMethod: "none" };
  const composed = composeTakosumiMobileOidcClients({ builtinClient: true, clients: [dashboard] });
  expect(composed.mobileOidcClientId).toBe(TAKOSUMI_MOBILE_BUILTIN_OIDC_CLIENT_ID);
  expect(composed.clients).toEqual([dashboard, takosumiMobileBuiltinOidcClient()]);
});

test("an operator-selected client stays advertised and also gets the consent screen", () => {
  const operatorMobile = {
    clientId: "takosumi-mobile-operator",
    redirectUris: ["takosumi://oauth/callback"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: MOBILE_SCOPES,
  };
  const withBuiltin = composeTakosumiMobileOidcClients({
    configuredClientId: "takosumi-mobile-operator",
    builtinClient: true,
    clients: [operatorMobile],
  });
  expect(withBuiltin.mobileOidcClientId).toBe("takosumi-mobile-operator");
  expect(withBuiltin.clients?.map((client) => [client.clientId, "consent" in client ? client.consent : undefined])).toEqual([
    ["takosumi-mobile-operator", "always"],
    ["takosumi-mobile", "always"],
  ]);

  const withoutBuiltin = composeTakosumiMobileOidcClients({
    configuredClientId: "takosumi-mobile-operator",
    builtinClient: false,
    clients: [operatorMobile],
  });
  expect(withoutBuiltin.clients?.map((client) => client.clientId)).toEqual(["takosumi-mobile-operator"]);
});

test("an operator registration that reuses the built-in id must be a valid Takosumi Mobile client", () => {
  const confidential = {
    clientId: "takosumi-mobile",
    redirectUris: ["takosumi://oauth/callback"],
    tokenEndpointAuthMethod: "client_secret_post",
    clientSecret: "fixture",
    allowedScopes: MOBILE_SCOPES,
  };
  expect(() => composeTakosumiMobileOidcClients({ builtinClient: true, clients: [confidential] }))
    .toThrow("must be a public client");

  const valid = { ...confidential, tokenEndpointAuthMethod: "none", clientSecret: undefined };
  const composed = composeTakosumiMobileOidcClients({ builtinClient: true, clients: [valid] });
  expect(composed.clients).toHaveLength(1);
  expect(composed.clients?.[0]).toMatchObject({ clientId: "takosumi-mobile", consent: "always" });
});

test("turning the built-in client off with no operator clients leaves the registry absent", () => {
  expect(composeTakosumiMobileOidcClients({ builtinClient: false })).toEqual({
    clients: undefined,
    mobileOidcClientId: undefined,
  });
});

test("the built-in switch accepts only true or false", () => {
  expect(parseTakosumiMobileBuiltinClientSetting(undefined, true)).toBe(true);
  expect(parseTakosumiMobileBuiltinClientSetting(" ", false)).toBe(false);
  expect(parseTakosumiMobileBuiltinClientSetting("true", false)).toBe(true);
  expect(parseTakosumiMobileBuiltinClientSetting("false", true)).toBe(false);
  expect(() => parseTakosumiMobileBuiltinClientSetting("0", true)).toThrow("must be true or false");
});

test("an unselected registration for the Takosumi Mobile redirect still requires consent", () => {
  const leftover = {
    clientId: "takosumi-mobile-operator-example",
    redirectUris: ["takosumi://oauth/callback"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: MOBILE_SCOPES,
  };
  const other = { clientId: "takos-mobile", redirectUris: ["takos://oauth/callback"], tokenEndpointAuthMethod: "none" };
  const composed = composeTakosumiMobileOidcClients({ builtinClient: true, clients: [leftover, other] });
  expect(composed.mobileOidcClientId).toBe("takosumi-mobile");
  expect(composed.clients?.find((client) => client.clientId === leftover.clientId)).toMatchObject({ consent: "always" });
  expect(composed.clients?.find((client) => client.clientId === "takos-mobile")).toEqual(other);
});
