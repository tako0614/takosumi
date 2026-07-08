export function isTakosEmbeddedRuntime(): boolean {
  return import.meta.env.VITE_TAKOS_EMBEDDED === "1";
}

export function isTakosumiCloudRuntime(): boolean {
  if (import.meta.env.VITE_TAKOSUMI_CLOUD === "1") return true;
  if (typeof window === "undefined") return false;
  return [
    "app.takosumi.com",
    "app-staging.takosumi.com",
    "app.takosumi.test",
  ].includes(window.location.hostname);
}

export function dashboardProductName(): "Takos" | "Takosumi" {
  return isTakosEmbeddedRuntime() ? "Takos" : "Takosumi";
}

export function dashboardDocsHref(): string {
  return isTakosEmbeddedRuntime()
    ? "https://docs.takos.jp"
    : "https://app.takosumi.com/docs/";
}
