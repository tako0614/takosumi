export interface ConfirmMobileActionInput {
  readonly message: string;
  readonly confirm?: (message: string) => boolean;
  readonly fallback?: boolean;
}

export function confirmMobileAction(input: ConfirmMobileActionInput): boolean {
  const confirm = input.confirm ?? readGlobalConfirm();
  if (!confirm) return input.fallback ?? true;
  return confirm(input.message);
}

function readGlobalConfirm(): ((message: string) => boolean) | undefined {
  const scope = globalThis as {
    readonly window?: {
      readonly confirm?: unknown;
    };
  };
  if (typeof scope.window?.confirm === "function") {
    return scope.window.confirm.bind(scope.window) as (
      message: string,
    ) => boolean;
  }
  return undefined;
}
