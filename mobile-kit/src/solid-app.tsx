import { render } from "solid-js/web";
import {
  MobileClientShell,
  type MobileClientShellProps,
} from "./solid-shell.tsx";
import type { NativeBridge } from "./types.ts";

const mobileClientRootDisposeKey = Symbol.for(
  "takosumi.mobile-client.root-dispose",
);

type DisposableMobileClientRoot = HTMLElement & {
  [mobileClientRootDisposeKey]?: () => void;
};

export interface MobileClientAppProps<Home> extends Omit<
  MobileClientShellProps<Home>,
  "nativeBridge"
> {
  readonly createNativeBridge: () => NativeBridge;
}

export interface RenderMobileClientAppOptions<
  Home,
> extends MobileClientAppProps<Home> {
  readonly root?: HTMLElement | string | null;
}

export function MobileClientApp<Home>(props: MobileClientAppProps<Home>) {
  return (
    <MobileClientShell<Home>
      {...props}
      nativeBridge={props.createNativeBridge()}
    />
  );
}

export function renderMobileClientApp<Home>(
  options: RenderMobileClientAppOptions<Home>,
): () => void {
  const root = resolveMobileClientAppRoot(
    options.root ?? "root",
  ) as DisposableMobileClientRoot;
  root[mobileClientRootDisposeKey]?.();
  root.replaceChildren();
  const dispose = render(() => <MobileClientApp<Home> {...options} />, root);
  const trackedDispose = () => {
    dispose();
    delete root[mobileClientRootDisposeKey];
  };
  root[mobileClientRootDisposeKey] = trackedDispose;
  return trackedDispose;
}

function resolveMobileClientAppRoot(root: HTMLElement | string): HTMLElement {
  if (typeof root !== "string") return root;
  const element = document.getElementById(root);
  if (!element) throw new Error(`Mobile app root not found: ${root}`);
  return element;
}
