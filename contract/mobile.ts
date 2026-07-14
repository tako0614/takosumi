import type { TakosumiAppProductKey } from "./app-handoff.ts";
import { isTakosumiAppProductKey } from "./app-handoff.ts";

export type MobileHostableProductKind = TakosumiAppProductKey;

export type MobileProductKind = TakosumiAppProductKey;

export type MobilePushProvider = "apns" | "fcm";

export interface MobilePushClientRegistration {
  readonly token: string;
  readonly provider?: MobilePushProvider;
  readonly environment?: string;
}

export interface MobileProductWellKnownEndpoints {
  readonly api?: string;
  readonly authProviders?: string;
  readonly currentUser?: string;
  readonly spaces?: string;
  readonly apps?: string;
  readonly timeline?: string;
  readonly notifications?: string;
  readonly notificationPushers?: string;
  readonly [key: string]: string | undefined;
}

export interface MobileProductWellKnown {
  readonly product?: MobileProductKind;
  readonly name?: string;
  readonly issuer?: string;
  /**
   * Public native-app OIDC client registered by this product host's operator.
   * A mobile shell must keep this exact value through code exchange and token
   * refresh; product-wide fallback ids are not host registration authority.
   */
  readonly oidcClientId?: string;
  readonly apiBaseUrl?: string;
  readonly endpoints?: MobileProductWellKnownEndpoints;
  readonly [key: string]: unknown;
}

export function isMobileProductKind(
  value: unknown,
): value is MobileProductKind {
  return isTakosumiAppProductKey(value);
}
