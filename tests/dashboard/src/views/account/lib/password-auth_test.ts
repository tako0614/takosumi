import { afterEach, expect, test } from "bun:test";
import { authenticateWithPassword, passwordErrorKey, readSignInMethods, setAccountPassword, validNewPassword } from "../../../../../../dashboard/src/views/account/lib/password-auth.ts";
import { ApiError } from "../../../../../../dashboard/src/views/account/lib/http.ts";

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocation === undefined) Reflect.deleteProperty(globalThis, "location");
  else globalThis.location = originalLocation;
});

test("Unicode password bounds count normalized characters and preserve spaces", () => {
  expect(validNewPassword("🔑".repeat(15))).toBe(true);
  expect(validNewPassword("🔑".repeat(129))).toBe(false);
  expect(validNewPassword("e\u0301".repeat(14))).toBe(false);
  expect(validNewPassword("e\u0301".repeat(15))).toBe(true);
  expect(validNewPassword(" ".repeat(15))).toBe(true);
});

test("password endpoints send credentialed JSON without trimming passwords or adding an identity to settings", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (path, init) => {
    calls.push({ path: String(path), init });
    return Response.json({ subject: "sub_fixture" });
  }) as typeof fetch;
  const password = "  sample password phrase  ";
  await authenticateWithPassword(" person@example.test ", password);
  await setAccountPassword({ password, currentPassword: " current proof " });
  expect(calls.map((call) => call.path)).toEqual([
    "/api/v1/auth/password/login", "/api/v1/account/sign-in-methods/password",
  ]);
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ email: "person@example.test", password });
  expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ password, currentPassword: " current proof " });
  for (const { init } of calls) {
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
  }
});

test("wrong current-password proof does not redirect or clear the account session", async () => {
  const navigations: string[] = [];
  globalThis.location = { assign: (value: string) => navigations.push(value) } as unknown as Location;
  globalThis.fetch = (async () => Response.json({ error: "invalid_credentials", error_description: "private account detail" }, { status: 401 })) as typeof fetch;
  await expect(setAccountPassword({ password: "new password phrase", currentPassword: "wrong" })).rejects.toMatchObject({ status: 401 });
  expect(navigations).toEqual([]);
  expect(passwordErrorKey(new ApiError(401, "invalid_credentials", "private account detail"))).toBe("password.error.credentials");
  expect(passwordErrorKey(new ApiError(429, "rate_limited", "internal limiter"))).toBe("password.error.rateLimited");
  expect(passwordErrorKey(new ApiError(503, "disabled", "operator detail"))).toBe("password.error.unavailable");
});

test("settings discovery accepts the local password state and tolerates an older server", async () => {
  const methods = { passwordEnabled: true, email: "person@example.test", hasPassword: false, canSetPassword: true };
  globalThis.fetch = (async () => Response.json(methods)) as typeof fetch;
  expect(await readSignInMethods()).toEqual(methods);
  globalThis.fetch = (async () => Response.json({ error: "not_found" }, { status: 404 })) as typeof fetch;
  expect(await readSignInMethods()).toBeUndefined();
  globalThis.fetch = (async () => Response.json({ passwordEnabled: true })) as typeof fetch;
  await expect(readSignInMethods()).rejects.toThrow("Invalid sign-in methods response");
});
