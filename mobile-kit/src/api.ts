import type {
  FetchLike,
  MobilePushRegistration,
  MobileSession,
} from "./types.ts";
import {
  createMobilePushHostRegistrationRequest,
  MOBILE_PUSH_REGISTRATION_PATH,
} from "../../contract/mobile.ts";
import { hostEndpoint } from "./url.ts";

export { MOBILE_PUSH_REGISTRATION_PATH };

export interface MobileApiClient {
  readonly session: MobileSession;
  readonly json: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
}

export interface MobileHostPushRegistrationInput {
  readonly session: MobileSession;
  readonly registration: MobilePushRegistration;
  readonly path?: string;
  readonly fetch?: FetchLike;
}

export type MobileHostPushUnregistrationInput = MobileHostPushRegistrationInput;

export function createMobileApiClient(input: {
  readonly session: MobileSession;
  readonly fetch?: FetchLike;
}): MobileApiClient {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    session: input.session,
    async json<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await fetcher(
        hostEndpoint(input.session.hostUrl, path),
        {
          ...init,
          headers: {
            accept: "application/json",
            authorization: `${input.session.tokenType} ${input.session.accessToken}`,
            ...init.headers,
          },
        },
      );
      if (!response.ok) {
        throw new Error(
          `Mobile API request failed: ${response.status} ${path}`,
        );
      }
      return (await response.json()) as T;
    },
  };
}

export async function registerMobilePushWithHost(
  input: MobileHostPushRegistrationInput,
): Promise<void> {
  await sendMobilePushRegistrationToHost(input, "POST");
}

export async function unregisterMobilePushWithHost(
  input: MobileHostPushUnregistrationInput,
): Promise<void> {
  await sendMobilePushRegistrationToHost(input, "DELETE");
}

async function sendMobilePushRegistrationToHost(
  input: MobileHostPushRegistrationInput,
  method: "DELETE" | "POST",
): Promise<void> {
  const path =
    input.path ?? resolveMobilePushRegistrationEndpoint(input.session);
  const client = createMobileApiClient({
    session: input.session,
    fetch: input.fetch,
  });
  await client.json(path, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(
      createMobilePushHostRegistrationRequest({
        hostUrl: input.session.hostUrl,
        product: input.session.product,
        registration: input.registration,
      }),
    ),
  });
}

export function resolveMobilePushRegistrationEndpoint(
  session: Pick<MobileSession, "productEndpoints">,
): string {
  const endpoint = session.productEndpoints?.mobilePushRegistrations?.trim();
  return endpoint || MOBILE_PUSH_REGISTRATION_PATH;
}
