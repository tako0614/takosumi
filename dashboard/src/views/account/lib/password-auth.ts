import type { MessageKey } from "../../../i18n/index.ts";
import { apiFetch, ApiError } from "./http.ts";

export interface PasswordCapability { readonly enabled: boolean }
export interface PasswordResult { readonly subject: string }
export interface SignInMethods {
  readonly passwordEnabled: boolean;
  readonly email: string | null;
  readonly hasPassword: boolean;
  readonly canSetPassword: boolean;
}

export function validNewPassword(value: string): boolean {
  const length = [...value.normalize("NFC")].length;
  return length >= 15 && length <= 128;
}

/** Proof failures stay in the form; a wrong password must not clear a valid session. */
async function passwordMutation(path: string, body: object, signal?: AbortSignal): Promise<PasswordResult> {
  const result = await apiFetch<PasswordResult>(path, { method: "POST", body, auth: false, signal });
  if (!result || typeof result.subject !== "string" || !result.subject) throw new Error("Invalid authentication response");
  return result;
}

export function authenticateWithPassword(email: string, password: string, signal?: AbortSignal): Promise<PasswordResult> {
  return passwordMutation("/api/v1/auth/password/login", { email: email.trim(), password }, signal);
}

export async function readSignInMethods(): Promise<SignInMethods | undefined> {
  try {
    const result = await apiFetch<SignInMethods>("/api/v1/account/sign-in-methods");
    if (!result || typeof result.passwordEnabled !== "boolean" || typeof result.hasPassword !== "boolean" ||
      typeof result.canSetPassword !== "boolean" || (result.email !== null && typeof result.email !== "string")) {
      throw new Error("Invalid sign-in methods response");
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

export function setAccountPassword(input: { readonly password: string; readonly currentPassword?: string }, signal?: AbortSignal): Promise<PasswordResult> {
  return passwordMutation("/api/v1/account/sign-in-methods/password", input, signal);
}

/** Never render server messages that could disclose an account or proof details. */
export function passwordErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 429) return "password.error.rateLimited";
    if (error.status === 404 || error.status === 503) return "password.error.unavailable";
    if (error.status === 401 || error.status === 403) return "password.error.credentials";
  }
  return "password.error.failed";
}
