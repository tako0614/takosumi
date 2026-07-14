/** Generic provider-source presentation with no built-in provider catalog. */
export function readableProviderSourceLabel(source: string): string {
  const trimmed = source.trim().replace(/^registry\.opentofu\.org\//u, "");
  const tail = trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
  const readable = tail.replaceAll(/[_-]+/gu, " ").trim();
  if (!readable) return source;
  if (/^[a-z0-9]{2,3}$/u.test(readable)) return readable.toUpperCase();
  return readable.replace(/\b\p{Ll}/gu, (letter) => letter.toUpperCase());
}
