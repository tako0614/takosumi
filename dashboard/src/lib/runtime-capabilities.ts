import { createSignal } from "solid-js";
import type {
  TakosumiProductCapabilities,
  TakosumiWellKnownDocument,
} from "takosumi-contract";

const [runtimeCapabilities, setRuntimeCapabilities] =
  createSignal<TakosumiProductCapabilities>();
let capabilityLoad:
  Promise<TakosumiProductCapabilities | undefined> | undefined;

export function isTakosEmbeddedRuntime(): boolean {
  return import.meta.env.VITE_TAKOS_EMBEDDED === "1";
}

/**
 * Loads the server's public capability document once. Feature visibility must
 * use this state instead of build flags or official hostnames, so the same SPA
 * remains truthful in self-host, Operator, and Cloud compositions.
 */
export function initializeTakosumiRuntimeCapabilities(
  fetchImpl: typeof fetch = fetch,
  origin = typeof window === "undefined" ? undefined : window.location.origin,
): Promise<TakosumiProductCapabilities | undefined> {
  if (capabilityLoad) return capabilityLoad;
  if (!origin) return Promise.resolve(undefined);
  capabilityLoad = loadTakosumiRuntimeCapabilities(fetchImpl, origin)
    .then((capabilities) => {
      setRuntimeCapabilities(capabilities);
      return capabilities;
    })
    .catch(() => {
      setRuntimeCapabilities(undefined);
      return undefined;
    });
  return capabilityLoad;
}

export async function loadTakosumiRuntimeCapabilities(
  fetchImpl: typeof fetch,
  origin: string,
): Promise<TakosumiProductCapabilities> {
  const wellKnownUrl = new URL("/.well-known/takosumi", origin);
  const wellKnownResponse = await fetchImpl(wellKnownUrl, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!wellKnownResponse.ok) {
    throw new Error(`Takosumi discovery failed (${wellKnownResponse.status})`);
  }
  const wellKnown =
    (await wellKnownResponse.json()) as TakosumiWellKnownDocument;
  const capabilitiesUrl = new URL(
    wellKnown.endpoints?.capabilities || "/v1/capabilities",
    wellKnownUrl,
  );
  if (capabilitiesUrl.origin !== wellKnownUrl.origin) {
    throw new Error("Takosumi capabilities endpoint must be same-origin");
  }
  const response = await fetchImpl(capabilitiesUrl, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Takosumi capabilities failed (${response.status})`);
  }
  const capabilities = (await response.json()) as unknown;
  if (!isTakosumiProductCapabilities(capabilities)) {
    throw new Error("Takosumi capabilities response is invalid");
  }
  return capabilities;
}

export function hasPlatformExtensionCapability(token: string): boolean {
  return runtimeCapabilities()?.extensions.includes(token) === true;
}

export function dashboardProductName(): "Takos" | "Takosumi" {
  return isTakosEmbeddedRuntime() ? "Takos" : "Takosumi";
}

export function dashboardDocsHref(): string {
  return isTakosEmbeddedRuntime() ? "https://docs.takos.jp" : "/docs/";
}

function isTakosumiProductCapabilities(
  value: unknown,
): value is TakosumiProductCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.apiVersion === "string" &&
    isRecord(record.resources) &&
    isRecord(record.adapters) &&
    isRecord(record.compat) &&
    isRecord(record.identity) &&
    isRecord(record.operator) &&
    Array.isArray(record.extensions)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
