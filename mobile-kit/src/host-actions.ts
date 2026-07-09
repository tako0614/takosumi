import type { MobileSession } from "./types.ts";

export type MobileShellNativeIntent = "open" | "call";

export interface MobileShellHostActionContext<Home> {
  readonly session: MobileSession;
  readonly home: Home | undefined;
}

export interface MobileShellHostAction<Home = unknown> {
  readonly label: string;
  readonly description: string;
  readonly path:
    | string
    | ((context: MobileShellHostActionContext<Home>) => string | undefined);
  readonly nativeIntent?: MobileShellNativeIntent;
}

export function defineMobileHostActions<Home>(
  actions: readonly MobileShellHostAction<Home>[],
): readonly MobileShellHostAction<Home>[] {
  for (const action of actions) {
    if (!action.label.trim()) {
      throw new Error("Host action label is required.");
    }
    if (!action.description.trim()) {
      throw new Error(`Host action description is required: ${action.label}`);
    }
    if (typeof action.path === "string") {
      validateHostActionPath(action.path, action.label);
    }
  }
  return actions;
}

function validateHostActionPath(path: string, label: string): void {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`Host action path must be same-origin: ${label}`);
  }
}
