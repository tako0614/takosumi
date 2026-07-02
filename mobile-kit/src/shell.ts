import type { MobileClipboardText, MobileProductAdapter } from "./types.ts";
import { createTakosumiHostCenterUrl } from "./url.ts";
import { requireMobileProductKey } from "./product-key.ts";

export interface FirstRunAction {
  readonly id: "url" | "qr" | "host";
  readonly label: string;
  readonly description: string;
}

export interface CopyMobileTextInput {
  readonly text: string;
  readonly label?: string;
  readonly writeClipboardText?: (input: MobileClipboardText) => Promise<void>;
  readonly unavailableMessage?: string;
}

export function createFirstRunActions(
  adapter: MobileProductAdapter,
): readonly FirstRunAction[] {
  const actions: FirstRunAction[] = [
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
  ];
  if (adapter.hostCenterLabel && adapter.hostCenterSource) {
    actions.push({
      id: "host",
      label: adapter.hostCenterLabel,
      description: "Create a new host in Takosumi Host Center.",
    });
  }
  return actions;
}

export function createHostCenterHref(input: {
  readonly adapter: MobileProductAdapter;
  readonly returnUri: string;
}): string {
  if (!input.adapter.hostCenterLabel) {
    throw new Error("Host Center action is not configured for this app.");
  }
  if (!input.adapter.hostCenterSource) {
    throw new Error("Host Center source is not configured for this app.");
  }
  return createTakosumiHostCenterUrl({
    product: requireMobileProductKey(
      input.adapter.hostCenterProduct ?? input.adapter.product,
      "Host Center product",
    ),
    source: input.adapter.hostCenterSource,
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

export async function copyMobileText(input: CopyMobileTextInput): Promise<void> {
  if (!input.writeClipboardText) {
    throw new Error(input.unavailableMessage ?? "Clipboard is unavailable.");
  }
  await input.writeClipboardText({
    text: input.text,
    label: input.label,
  });
}
