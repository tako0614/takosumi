/**
 * Helpers behind 「スマホで使う」: a QR code of an app's launch URL, sharing
 * that URL, and which phone's add-to-home-screen steps to show first.
 *
 * Most apps installed through Takosumi have no native store app, so the
 * dashboard helps an owner put the app's own web page on a phone's home
 * screen and hand its URL to the people who only use it (they are not
 * members). Everything here is local: the QR code is encoded in the browser
 * and nothing is sent anywhere.
 */
import { isSafeLinkHref } from "takosumi-contract";
import { encode } from "uqr";

/** Light modules around the code, as the QR specification asks for. */
export const QR_QUIET_ZONE = 4;

/**
 * The URL a phone can open: an absolute http(s) address, the same rule the
 * app page's Open uses. Anything else gets no QR code and no share action.
 */
export function phoneLaunchUrl(url: string | undefined): string | undefined {
  const value = url?.trim();
  return value && /^https?:\/\//iu.test(value) && isSafeLinkHref(value) ? value : undefined;
}

/** A QR code as one SVG path over a square `0 0 size size` view box. */
export interface QrCodeSvg {
  /** View box edge in modules, quiet zone included. */
  readonly size: number;
  /** Dark modules as an SVG path (`M x y h n v 1 h -n z` per run). */
  readonly path: string;
}

/**
 * Encode `text` (an app URL) as a QR code. Error correction M survives a
 * smudged or glare-covered screen. Returns undefined for empty input or for
 * text longer than a QR code holds, so the URL is shown without a code.
 */
export function qrCodeSvg(text: string): QrCodeSvg | undefined {
  if (!text) return undefined;
  let modules: readonly (readonly boolean[])[];
  try {
    modules = encode(text, { ecc: "M", border: 0 }).data;
  } catch {
    return undefined;
  }
  const runs: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      const width = x - start;
      runs.push(`M${start + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h${width}v1h-${width}z`);
    }
  });
  return { size: modules.length + QR_QUIET_ZONE * 2, path: runs.join("") };
}

/** The parts of `navigator` sharing uses; injected so tests can stand in. */
export interface ShareEnvironment {
  readonly share?: (data: ShareData) => Promise<void>;
  readonly canShare?: (data: ShareData) => boolean;
  readonly writeText?: (text: string) => Promise<void>;
}

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

/** The browser's own sharing and clipboard, where it has them. */
export function browserShareEnvironment(): ShareEnvironment {
  if (typeof navigator === "undefined") return {};
  const share = typeof navigator.share === "function" ? navigator.share.bind(navigator) : undefined;
  const canShare = typeof navigator.canShare === "function" ? navigator.canShare.bind(navigator) : undefined;
  const clipboard = navigator.clipboard;
  const writeText = clipboard && typeof clipboard.writeText === "function"
    ? clipboard.writeText.bind(clipboard)
    : undefined;
  return {
    ...(share ? { share } : {}),
    ...(canShare ? { canShare } : {}),
    ...(writeText ? { writeText } : {}),
  };
}

/** Whether this browser can open its share sheet for `data`. */
export function canShareUrl(data: ShareData, env: ShareEnvironment): boolean {
  if (!env.share) return false;
  try {
    return env.canShare ? env.canShare(data) : true;
  } catch {
    return false;
  }
}

/** Copy `text`; "failed" leaves the visible URL for the person to copy. */
export async function copyUrl(text: string, env: ShareEnvironment): Promise<"copied" | "failed"> {
  if (!env.writeText) return "failed";
  try {
    await env.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

/**
 * Open the share sheet for the app's URL, or copy the URL where the browser
 * has no share sheet or refuses this one. Closing the sheet is "cancelled":
 * the person chose not to share, so nothing is copied behind their back.
 */
export async function shareOrCopyUrl(data: ShareData & { readonly url: string }, env: ShareEnvironment): Promise<ShareOutcome> {
  if (canShareUrl(data, env)) {
    try {
      await env.share!(data);
      return "shared";
    } catch (cause) {
      if (isAbort(cause)) return "cancelled";
      // NotAllowedError, a sheet already open, or an unsupported payload:
      // copying still hands the URL over.
    }
  }
  return await copyUrl(data.url, env);
}

function isAbort(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "AbortError";
}

export type PhonePlatform = "ios" | "android";

/** The phone this page runs on, if it is one: iPhone, iPad (also iPadOS's desktop agent) or Android. */
export function detectPhonePlatform(input: {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
}): PhonePlatform | undefined {
  const agent = input.userAgent;
  if (/android/iu.test(agent)) return "android";
  if (/iphone|ipad|ipod/iu.test(agent)) return "ios";
  // iPadOS 13+ asks for desktop pages with a Mac agent; a Mac has no touch.
  if (/macintosh/iu.test(agent) && (input.maxTouchPoints ?? 0) > 1) return "ios";
  return undefined;
}

/** Both phones' steps are always shown; the detected phone's come first. */
export function phoneGuidanceOrder(current: PhonePlatform | undefined): readonly PhonePlatform[] {
  return current === "android" ? ["android", "ios"] : ["ios", "android"];
}
