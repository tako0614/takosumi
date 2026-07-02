import { fileURLToPath, URL } from "node:url";

export interface CreateTauriMobileViteConfigInput {
  readonly devPort: number;
  readonly importMetaUrl: string;
  readonly plugins?: readonly unknown[];
  readonly env?: {
    readonly TAURI_DEV_HOST?: string | undefined;
  };
}

export function createTauriMobileViteConfig(
  input: CreateTauriMobileViteConfigInput,
) {
  const host = (input.env ?? process.env).TAURI_DEV_HOST;
  return {
    plugins: [...(input.plugins ?? [])],
    resolve: {
      alias: {
        "@takosjp/takosumi-mobile-kit/solid": fileURLToPath(
          new URL(
            "../../takosumi/mobile-kit/src/solid.ts",
            input.importMetaUrl,
          ),
        ),
        "@takosjp/takosumi-mobile-kit": fileURLToPath(
          new URL(
            "../../takosumi/mobile-kit/src/index.ts",
            input.importMetaUrl,
          ),
        ),
      },
    },
    server: {
      port: input.devPort,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: input.devPort + 1,
          }
        : undefined,
      fs: {
        allow: [fileURLToPath(new URL("../..", input.importMetaUrl))],
      },
    },
    clearScreen: false,
  };
}
