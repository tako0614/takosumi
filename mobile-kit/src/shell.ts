import type { MobileProductAdapter } from "./types.ts";
import { createTakosumiHostCenterUrl } from "./url.ts";

export interface FirstRunAction {
  readonly id: "url" | "qr" | "host";
  readonly label: string;
  readonly description: string;
}

export function createFirstRunActions(
  adapter: MobileProductAdapter,
): readonly FirstRunAction[] {
  return [
    {
      id: "url",
      label: "Connect by URL",
      description: `Enter an existing ${adapter.hostNoun} URL.`,
    },
    {
      id: "qr",
      label: "Paste QR payload",
      description: `Use a ${adapter.hostNoun} connection payload.`,
    },
    {
      id: "host",
      label: adapter.hostCenterLabel,
      description: "Create a new host in Takosumi Host Center.",
    },
  ];
}

export function createHostCenterHref(input: {
  readonly adapter: MobileProductAdapter;
  readonly returnUri?: string;
}): string {
  return createTakosumiHostCenterUrl({
    product: input.adapter.product,
    returnUri: input.returnUri,
  });
}

export function createMobileReturnUri(
  adapter: MobileProductAdapter,
  path = "connect",
): string {
  if (!/^[a-z][a-z0-9+.-]*$/i.test(adapter.mobileScheme)) {
    throw new Error(`Invalid mobile scheme: ${adapter.mobileScheme}`);
  }
  const normalizedPath = path.replace(/^\/+/, "") || "connect";
  return `${adapter.mobileScheme}://${normalizedPath}`;
}
