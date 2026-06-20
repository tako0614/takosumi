export function isTakosumiCloudRuntime(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  if (env.VITE_TAKOSUMI_CLOUD === "1") return true;
  if (typeof window === "undefined") return false;
  return ["app.takosumi.com", "app.takosumi.test"].includes(
    window.location.hostname,
  );
}
