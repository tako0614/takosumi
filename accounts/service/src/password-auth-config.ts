export type PasswordAuthMode = "disabled" | "login";

export function parsePasswordAuthMode(value: string | undefined): PasswordAuthMode {
  if (value === undefined || value === "" || value === "disabled") return "disabled";
  if (value === "login") return value;
  throw new TypeError("TAKOSUMI_ACCOUNTS_PASSWORD_AUTH must be disabled or login");
}

export function permitsPasswordTransport(issuer: string): boolean {
  const url = new URL(issuer);
  return url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}
