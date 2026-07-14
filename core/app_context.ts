import {
  InMemoryObservabilitySink,
  type ObservabilitySink,
  wrapObservabilitySinkWithOtlpMetrics,
} from "./domains/observability/mod.ts";
import { log } from "./shared/log.ts";
import { currentRuntime } from "./shared/runtime/index.ts";

export interface AppContextOptions {
  readonly adapters?: Partial<AppAdapters>;
  readonly runtimeConfig?: AppRuntimeConfig;
  readonly loadRuntimeConfig?: boolean;
  readonly runtimeEnv?: Record<string, string | undefined>;
}

export interface AppRuntimeConfig {
  readonly environment?: string;
  readonly processRole?: string;
  readonly allowUnsafeProductionDefaults?: boolean;
}

export interface AppAdapters {
  readonly observability: ObservabilitySink;
}

export interface AppContext {
  readonly adapters: AppAdapters;
}

export function createInMemoryAppContext(
  options: AppContextOptions = {},
): AppContext {
  return { adapters: createDefaultAdapters(options) };
}

export async function createAppContext(
  options: AppContextOptions = {},
): Promise<AppContext> {
  return createInMemoryAppContext(await withOptionalRuntimeConfig(options));
}

export async function createConfiguredAppContext(
  options: AppContextOptions = {},
): Promise<AppContext> {
  return await createAppContext({ ...options, loadRuntimeConfig: true });
}

export function createDefaultAdapters(
  options: AppContextOptions = {},
): AppAdapters {
  assertNoStrictRuntimeAdapterFallbacks(options);
  warnAboutDevAdapterFallbacks(options);
  return {
    observability: wrapObservabilitySinkWithOtlpMetrics(
      options.adapters?.observability ?? new InMemoryObservabilitySink(),
      options.runtimeEnv,
    ),
  };
}

async function withOptionalRuntimeConfig(
  options: AppContextOptions,
): Promise<AppContextOptions> {
  if (options.runtimeConfig || !options.loadRuntimeConfig) return options;
  try {
    const configModule = await import("./config/mod.ts");
    const runtimeConfig = await configModule.loadRuntimeConfigFromEnv({
      env: options.runtimeEnv,
    });
    return { ...options, runtimeConfig };
  } catch (error) {
    if (
      error instanceof TypeError ||
      currentRuntime().fs.isNotFoundError(error)
    ) {
      return options;
    }
    throw error;
  }
}

function assertNoStrictRuntimeAdapterFallbacks(
  options: AppContextOptions,
): void {
  const environment = options.runtimeConfig?.environment;
  if (environment !== "production" && environment !== "staging") return;
  for (const adapter of ["observability"] as const) {
    if (options.adapters?.[adapter]) continue;
    throw new Error(
      `${environment} runtime requires an explicit ${adapter} adapter`,
    );
  }
}

function warnAboutDevAdapterFallbacks(options: AppContextOptions): void {
  const environment = options.runtimeConfig?.environment;
  if (environment === "production" || environment === "staging") return;
  if (!options.adapters) return;
  const fallbacks = (["observability"] as const).filter(
    (adapter) => !options.adapters?.[adapter],
  );
  if (fallbacks.length === 0) return;
  log.warn("service.boot.in_memory_fallbacks", {
    adapters: fallbacks,
    hint: "inject durable storage and observability adapters for operators",
  });
}
