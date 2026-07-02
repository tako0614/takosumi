import type { MobileClipboardText } from "./types.ts";

export interface MobileShareUrlInput {
  readonly title?: string;
  readonly url: string;
  readonly clipboardLabel?: string;
  readonly writeClipboardText?: (
    input: MobileClipboardText,
  ) => Promise<void>;
  readonly navigator?: MobileShareNavigator;
  readonly unavailableMessage?: string;
}

export interface MobileShareNavigator {
  readonly share?: (data: MobileShareData) => Promise<void>;
  readonly clipboard?: {
    readonly writeText?: (text: string) => Promise<void>;
  };
}

export interface MobileShareData {
  readonly title?: string;
  readonly url: string;
}

export async function shareMobileUrl(input: MobileShareUrlInput): Promise<void> {
  const navigatorRef = input.navigator ?? readGlobalNavigator();
  if (navigatorRef?.share) {
    await navigatorRef.share({
      title: input.title,
      url: input.url,
    });
    return;
  }
  if (input.writeClipboardText) {
    await input.writeClipboardText({
      text: input.url,
      label: input.clipboardLabel ?? input.title,
    });
    return;
  }
  const browserWriteText = navigatorRef?.clipboard?.writeText;
  if (browserWriteText) {
    await browserWriteText(input.url);
    return;
  }
  throw new Error(input.unavailableMessage ?? "Sharing is unavailable.");
}

function readGlobalNavigator(): MobileShareNavigator | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator;
}
