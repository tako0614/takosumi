import { expect, test } from "bun:test";

import * as identity from "../../contract/native-client-identity.ts";

test("the native client identity subpath publishes Takosumi's own identities and checks", () => {
  expect(Object.keys(identity).sort()).toEqual([
    "TAKOSUMI_MOBILE_ANDROID_PACKAGE",
    "TAKOSUMI_MOBILE_ASSOCIATED_DOMAINS",
    "TAKOSUMI_MOBILE_BUNDLE_ID",
    "TAKOSUMI_MOBILE_SCHEME",
    "TAKOSUMI_OWNED_DOMAINS",
    "TAKOSUMI_RESERVED_APP_ID_NAMESPACES",
    "TAKOSUMI_RESERVED_CLIENT_NAMES",
    "foldNativeClientName",
    "isTakosumiReservedAppId",
    "isTakosumiReservedClientName",
    "isTakosumiReservedHost",
  ]);
  expect(identity.TAKOSUMI_MOBILE_BUNDLE_ID).toBe("com.takosumi");
  expect(identity.TAKOSUMI_MOBILE_ANDROID_PACKAGE).toBe("com.takosumi");
  expect(identity.TAKOSUMI_MOBILE_SCHEME).toBe("takosumi");
  expect(identity.TAKOSUMI_OWNED_DOMAINS).toEqual(["takosumi.com"]);
  expect(Object.isFrozen(identity.TAKOSUMI_OWNED_DOMAINS)).toBe(true);
});

test("Takosumi's app id namespace is reserved, including ids below it", () => {
  for (const id of ["com.takosumi", "COM.Takosumi", "com.takosumi.beta", " com.takosumi "]) {
    expect(identity.isTakosumiReservedAppId(id)).toBe(true);
  }
  for (const id of ["com.takosumix", "com.yurucommu", "jp.takos.mobile", "takosumi"]) {
    expect(identity.isTakosumiReservedAppId(id)).toBe(false);
  }
});

test("Takosumi-owned domains cover their subdomains; extra hosts match exactly", () => {
  for (const host of ["takosumi.com", "app.takosumi.com", "a.b.takosumi.com", "TAKOSUMI.COM", "takosumi.com."]) {
    expect(identity.isTakosumiReservedHost(host)).toBe(true);
  }
  for (const host of ["nottakosumi.com", "takosumi.com.evil.example", "takosumi.co", ""]) {
    expect(identity.isTakosumiReservedHost(host)).toBe(false);
  }
  expect(identity.isTakosumiReservedHost("accounts.example.org", ["accounts.example.org"])).toBe(true);
  expect(identity.isTakosumiReservedHost("x.accounts.example.org", ["accounts.example.org"])).toBe(false);
});

test("reserved names are found through case, accents, width and lookalikes", () => {
  for (const name of [
    "Takosumi",
    "TAKOSUMI Mobile",
    "Tako sumi",
    "Ｔａｋｏｓｕｍｉ",
    "Tákosúmí",
    "T4k0sum1",
    "Takosuml",
    "Takosurni",
    "Тakosumi",
    "takoѕumi",
    "Open in Takosumi",
  ]) {
    expect(identity.isTakosumiReservedClientName(name), name).toBe(true);
  }
  for (const name of ["Takos", "Yurucommu", "Notes", "Tako", "Sumi"]) {
    expect(identity.isTakosumiReservedClientName(name), name).toBe(false);
  }
  expect(identity.isTakosumiReservedClientName("Yurucomrnu", ["Yurucommu"])).toBe(true);
  expect(identity.foldNativeClientName("Ｙｕｒｕ-commu!")).toBe("yurucommui");
});
