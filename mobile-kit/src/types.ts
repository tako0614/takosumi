import type {
  MobileProductKind as ContractMobileProductKind,
  MobileProductWellKnown as ContractMobileProductWellKnown,
  MobileProductWellKnownEndpoints,
} from "../../contract/mobile.ts";

export type MobileProductKind = ContractMobileProductKind;
export type ProductWellKnown = ContractMobileProductWellKnown;
export type ProductWellKnownEndpoints = MobileProductWellKnownEndpoints;

export interface MobileProductAdapter {
  readonly product: MobileProductKind;
  readonly appName: string;
  readonly hostNoun: string;
  readonly hostCenterLabel: string;
  readonly urlPlaceholder: string;
  readonly primaryActionLabel: string;
  readonly accentColor: string;
  readonly mobileScheme: string;
  readonly oidcClientId?: string;
  readonly requiredHostCapabilities?: readonly string[];
}

export interface MobileConnectPayload {
  readonly hostUrl: string;
  readonly product?: MobileProductKind;
  readonly setupTicket?: string;
}

export interface MobileRoutePayload {
  readonly path: string;
  readonly hostUrl?: string;
  readonly product?: MobileProductKind;
}

export interface MobileKnownHost {
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly oidcIssuer?: string;
  readonly lastSeenAt: string;
  readonly label?: string;
}

export interface TakosumiWellKnown {
  readonly api_versions?: readonly string[];
  readonly issuer?: string;
  readonly capabilitiesUrl?: string;
  readonly product?: string;
  readonly endpoints?: {
    readonly api?: string;
    readonly capabilities?: string;
    readonly oidc_issuer?: string;
  };
  readonly [key: string]: unknown;
}

export interface HostCapabilities {
  readonly product?: string | { readonly kind?: string };
  readonly identity?: {
    readonly oidc_issuer?: boolean;
    readonly issuer?: string;
  };
  readonly resources?: Record<string, unknown>;
  readonly commercial?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface HostDiscovery {
  readonly hostUrl: string;
  readonly expectedProduct?: MobileProductKind;
  readonly detectedProduct?: MobileProductKind;
  readonly takosumi?: TakosumiWellKnown;
  readonly capabilities?: HostCapabilities;
  readonly product?: ProductWellKnown;
  readonly oidcIssuer: string;
  readonly oidcDiscoveryUrl: string;
}

export interface OidcMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint?: string;
  readonly revocation_endpoint?: string;
  readonly introspection_endpoint?: string;
  readonly [key: string]: unknown;
}

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
}

export interface OidcAuthorizationUrlInput {
  readonly metadata: OidcMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scope?: string;
}

export interface OidcCallbackResult {
  readonly code: string;
  readonly state: string;
}

export interface OidcTokenExchangeInput {
  readonly metadata: OidcMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetch?: FetchLike;
}

export interface OidcTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly scope?: string;
  readonly [key: string]: unknown;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface NativeBridgeCapabilities {
  readonly launchPayload: boolean;
  readonly launchPayloadEvents: boolean;
  readonly externalBrowser: boolean;
  readonly inAppBrowser: boolean;
  readonly qrScanner: boolean;
  readonly localNotifications: boolean;
  readonly pushNotifications: boolean;
  readonly biometricAuth: boolean;
  readonly callIntent: boolean;
  readonly secureStorage: boolean;
  readonly persistentStorage: boolean;
}

export interface MobileKeyValueStore {
  readonly kind: "secure" | "device-persistent" | "browser-local";
  readonly get: (key: string) => Promise<string | undefined>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

export type MobileSecureStore = MobileKeyValueStore;

export interface MobileAuthRequest {
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly oidcIssuer: string;
  readonly productEndpoints?: ProductWellKnownEndpoints;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly createdAt: string;
}

export interface MobileSession {
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly oidcIssuer: string;
  readonly productEndpoints?: ProductWellKnownEndpoints;
  readonly accessToken: string;
  readonly tokenType: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly scope?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface MobilePushRegistrationInput {
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly accountId?: string;
}

export interface MobilePushRegistration {
  readonly token: string;
  readonly environment?: string;
}

export interface MobilePushNotification {
  readonly title?: string;
  readonly body?: string;
  readonly data: Record<string, unknown>;
  readonly badge?: number;
  readonly sound?: string;
}

export type MobilePushNotificationEventKind = "received" | "tapped";

export interface MobileCallIntent {
  readonly roomUrl: string;
  readonly title?: string;
}

export interface MobileLocalNotification {
  readonly title: string;
  readonly body?: string;
}

export interface MobileBiometricPrompt {
  readonly message: string;
  readonly allowDeviceCredential?: boolean;
  readonly cancelTitle?: string;
  readonly fallbackTitle?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly confirmationRequired?: boolean;
}

export type MobileSessionUnlockMode = "off" | "if-available" | "required";

export interface MobileSessionUnlockOptions {
  readonly restoreMode?: MobileSessionUnlockMode;
  readonly prompt?:
    | MobileBiometricPrompt
    | ((session: MobileSession) => MobileBiometricPrompt);
}

export interface NativeBridge {
  readonly capabilities: NativeBridgeCapabilities;
  readonly storage?: MobileKeyValueStore;
  readonly secureStore?: MobileSecureStore;
  readonly getLaunchPayload: () => Promise<string | undefined>;
  readonly onLaunchPayload?: (
    handler: (payload: string) => void,
  ) => Promise<() => void>;
  readonly openExternalUrl: (url: string) => Promise<void>;
  readonly scanConnectionPayload?: () => Promise<string | undefined>;
  readonly requestLocalNotificationPermission?: () => Promise<boolean>;
  readonly sendLocalNotification?: (
    notification: MobileLocalNotification,
  ) => Promise<void>;
  readonly registerPushNotifications?: (
    input: MobilePushRegistrationInput,
  ) => Promise<MobilePushRegistration | undefined>;
  readonly onPushNotificationReceived?: (
    handler: (notification: MobilePushNotification) => void,
  ) => Promise<() => void>;
  readonly onPushNotificationTapped?: (
    handler: (notification: MobilePushNotification) => void,
  ) => Promise<() => void>;
  readonly onPushTokenRefresh?: (
    input: MobilePushRegistrationInput,
    handler: (registration: MobilePushRegistration) => void,
  ) => Promise<() => void>;
  readonly authenticateBiometric?: (
    prompt: MobileBiometricPrompt,
  ) => Promise<boolean>;
  readonly requestCall?: (input: MobileCallIntent) => Promise<void>;
}
