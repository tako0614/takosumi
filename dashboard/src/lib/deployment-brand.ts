export function isTakosumiCloudRuntime(): boolean {
  if (import.meta.env.VITE_TAKOSUMI_CLOUD === "1") return true;
  if (typeof window === "undefined") return false;
  return ["app.takosumi.com", "app.takosumi.test"].includes(
    window.location.hostname,
  );
}
