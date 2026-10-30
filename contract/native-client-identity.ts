/**
 * Identities that belong to Takosumi itself and that no app's native-client
 * declaration may claim (TASK-0119, ADR 0026 in takos-control).
 *
 * The Takosumi host refuses them in `interface.ui.surface`
 * `document.clients`; Takosumi Mobile uses the same constants so it never
 * hands a screen to itself, to a Takosumi-owned domain, or to an app that
 * calls itself Takosumi. This module is dependency-free on purpose.
 */

/** Takosumi Mobile's iOS bundle id. */
export const TAKOSUMI_MOBILE_BUNDLE_ID = "com.takosumi" as const;
/** Takosumi Mobile's Android applicationId. */
export const TAKOSUMI_MOBILE_ANDROID_PACKAGE = "com.takosumi" as const;
/** Takosumi Mobile's custom URL scheme. */
export const TAKOSUMI_MOBILE_SCHEME = "takosumi" as const;
/**
 * Universal link / App Link domains of Takosumi Mobile. It declares none yet;
 * a domain added here is refused like a Takosumi-owned domain.
 */
export const TAKOSUMI_MOBILE_ASSOCIATED_DOMAINS: readonly string[] = Object.freeze([]);
/** Domains Takosumi owns. Each one also covers all of its subdomains. */
export const TAKOSUMI_OWNED_DOMAINS: readonly string[] = Object.freeze([
  "takosumi.com",
]);
/**
 * Bundle ids / applicationIds in Takosumi's namespace. Each one also covers
 * every id below it (`com.takosumi.*`).
 */
export const TAKOSUMI_RESERVED_APP_ID_NAMESPACES: readonly string[] = Object.freeze([
  "com.takosumi",
]);
/**
 * Names an app's native client may not show, compared after folding lookalikes
 * (Latin) or kana forms (Japanese).
 */
export const TAKOSUMI_RESERVED_CLIENT_NAMES: readonly string[] = Object.freeze([
  "takosumi",
  "たこすみ",
  "タコスミ",
]);

/** True for a bundle id or applicationId in Takosumi's namespace. */
export function isTakosumiReservedAppId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return TAKOSUMI_RESERVED_APP_ID_NAMESPACES.some((namespace) =>
    normalized === namespace || normalized.startsWith(`${namespace}.`)
  );
}

/**
 * True for a Takosumi-owned host: an owned domain or a subdomain of one, a
 * Takosumi Mobile associated domain, or one of `extraHosts` (the instance's
 * own issuer and dashboard hosts, matched exactly).
 */
export function isTakosumiReservedHost(
  host: string,
  extraHosts: readonly string[] = [],
): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/u, "");
  if (!normalized) return false;
  const covered = (domain: string): boolean => {
    const owned = domain.trim().toLowerCase().replace(/\.$/u, "");
    return owned !== "" &&
      (normalized === owned || normalized.endsWith(`.${owned}`));
  };
  return TAKOSUMI_OWNED_DOMAINS.some(covered) ||
    TAKOSUMI_MOBILE_ASSOCIATED_DOMAINS.some(covered) ||
    extraHosts.some((extra) =>
      extra.trim().toLowerCase().replace(/\.$/u, "") === normalized
    );
}

const CONFUSABLE_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  "$": "s",
  "!": "i",
  "|": "i",
  "l": "i",
  // Cyrillic
  "а": "a",
  "е": "e",
  "о": "o",
  "р": "p",
  "с": "c",
  "у": "y",
  "х": "x",
  "к": "k",
  "т": "t",
  "м": "m",
  "і": "i",
  "ј": "j",
  "ѕ": "s",
  "ԁ": "d",
  "ս": "u",
  // Greek
  "α": "a",
  "ε": "e",
  "ο": "o",
  "ρ": "p",
  "κ": "k",
  "τ": "t",
  "μ": "u",
  "ι": "i",
  "υ": "u",
  "ν": "v",
  // Latin lookalikes
  "ı": "i",
  "ɩ": "i",
  "ʋ": "u",
  "µ": "u",
});

/**
 * A lowercase Latin skeleton of a display name: compatibility forms and
 * accents removed, common digit, Cyrillic and Greek lookalikes mapped to
 * Latin letters, `rn` read as `m`, everything else dropped. Two names whose
 * skeletons overlap may look alike on a phone screen.
 */
export function foldNativeClientName(name: string): string {
  const decomposed = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let folded = "";
  for (const character of decomposed) {
    folded += CONFUSABLE_LETTERS[character] ?? character;
  }
  return folded.replace(/[^a-z]/gu, "").replaceAll("rn", "m");
}

/** ASCII letters, digits, spaces and ASCII punctuation. */
const ASCII_NAME = /^[\x20-\x7e]*$/u;
/**
 * Kana, kanji and Japanese punctuation with ASCII digits, spaces and ASCII
 * punctuation, but no ASCII letter.
 */
const JAPANESE_NAME =
  /^[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}\u3000-\u303f\x20-\x40\x5b-\x60\x7b-\x7e]*$/u;

/**
 * True when folding can compare every character of `name`: after removing
 * accents and compatibility forms (full-width, ligatures, styled letters), it
 * is ASCII text, or Japanese text without Latin letters. Other scripts
 * (Cyrillic, Greek, Cherokee and so on), small capitals, symbols and emoji can
 * imitate a Latin letter that no lookalike table lists, and kana or kanji
 * between Latin letters can stand in for one (`Takロsumi`), so a name using
 * them is never treated as safe. Letters without a decomposition (`ß`, `Ø`,
 * `Ł`, `Æ`) and symbols such as `©` are refused for the same reason, and so
 * are combining marks that do not compose into a precomposed letter
 * (overlays such as U+0337 on every letter, stacked accents), which can hide
 * the letters under them; the dakuten and handakuten of kana compose and
 * pass.
 */
function isComparableClientName(name: string): boolean {
  if (/\p{M}/u.test(name.normalize("NFKC"))) return false;
  const base = name.normalize("NFKD").replace(/\p{M}/gu, "");
  return ASCII_NAME.test(base) || JAPANESE_NAME.test(base);
}

/** Small kana and their full-size forms, after katakana is read as hiragana. */
const SMALL_KANA: Readonly<Record<string, string>> = Object.freeze({
  "ぁ": "あ",
  "ぃ": "い",
  "ぅ": "う",
  "ぇ": "え",
  "ぉ": "お",
  "っ": "つ",
  "ゃ": "や",
  "ゅ": "ゆ",
  "ょ": "よ",
  "ゎ": "わ",
  "ゕ": "か",
  "ゖ": "け",
  "ㇰ": "く",
  "ㇱ": "し",
  "ㇲ": "す",
  "ㇳ": "と",
  "ㇴ": "ぬ",
  "ㇵ": "は",
  "ㇶ": "ひ",
  "ㇷ": "ふ",
  "ㇸ": "へ",
  "ㇹ": "ほ",
  "ㇺ": "む",
  "ㇻ": "ら",
  "ㇼ": "り",
  "ㇽ": "る",
  "ㇾ": "れ",
  "ㇿ": "ろ",
});

/**
 * The comparison key of Japanese text: compatibility forms composed (NFKC,
 * so half-width kana become full-width), katakana read as hiragana, small
 * kana read as full-size, and everything but kana and kanji dropped (spaces,
 * middle dots, long-vowel marks, punctuation, digits). `ユルコミュ`,
 * `ゆる・こみゅ` and `ﾕﾙｺﾐｭ` share the key `ゆるこみゆ`.
 */
function kanaClientNameKey(name: string): string {
  let key = "";
  for (const character of name.normalize("NFKC")) {
    const code = character.codePointAt(0)!;
    const katakana = (code >= 0x30a1 && code <= 0x30f6) || code === 0x30fd || code === 0x30fe;
    const hiragana = katakana ? String.fromCodePoint(code - 0x60) : character;
    key += SMALL_KANA[hiragana] ?? hiragana;
  }
  return key.replace(/[^\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/gu, "");
}

/**
 * Whether two kana keys may name the same app: equal, one containing the
 * other, or the other containing a short one (at least two characters), so
 * `ゆるこみゅ公式` and `ゆるこ` both overlap `ゆるこみゅ`.
 */
function kanaKeysOverlap(name: string, reserved: string): boolean {
  if (!name || !reserved) return false;
  return name === reserved ||
    ([...reserved].length >= 2 && name.includes(reserved)) ||
    ([...name].length >= 2 && reserved.includes(name));
}

/**
 * True when `name` may imitate a reserved Takosumi name (including its kana
 * forms) or one of `extraNames` (for example the names of trusted native
 * clients): its Latin skeleton contains one, its Japanese kana key overlaps
 * one (`ユルコミュ公式` against `ゆるこみゅ`), or it uses characters folding
 * cannot compare (anything but ASCII text after removing accents and
 * compatibility forms with NFKD, or Japanese text without Latin letters).
 * Refusing every such name is simpler and more robust than listing every
 * lookalike of every script.
 */
export function isTakosumiReservedClientName(
  name: string,
  extraNames: readonly string[] = [],
): boolean {
  if (!isComparableClientName(name)) return true;
  const reservedNames = [...TAKOSUMI_RESERVED_CLIENT_NAMES, ...extraNames];
  const folded = foldNativeClientName(name);
  if (
    folded &&
    reservedNames.some((reserved) => {
      const skeleton = foldNativeClientName(reserved);
      return skeleton !== "" && folded.includes(skeleton);
    })
  ) {
    return true;
  }
  const kana = kanaClientNameKey(name);
  return kana !== "" &&
    reservedNames.some((reserved) => kanaKeysOverlap(kana, kanaClientNameKey(reserved)));
}
