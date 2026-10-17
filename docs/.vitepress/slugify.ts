// VitePress builds heading ids by decomposing the title (NFKD) and removing
// only the Latin combining marks. A heading with a voiced kana such as で, ぶ
// or プ therefore keeps a separate U+3099 or U+309A in its id. Links written
// in the docs use the composed character, and browsers compare fragments code
// point by code point, so those links did not reach their heading. This is
// VitePress's slugify with the result recomposed (NFC); ids without such
// characters are unchanged.

const CONTROL = /[\u0000-\u001f]/g;
const SPECIAL = /[\s~`!@#$%^&*()\-_+=[\]{}|\;:"'“”‘’<>,.?/]+/g;
const COMBINING = /[̀-ͯ]/g;

export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(COMBINING, "")
    .replace(CONTROL, "")
    .replace(SPECIAL, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase()
    .normalize("NFC");
}
