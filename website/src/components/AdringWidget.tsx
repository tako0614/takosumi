import { onCleanup, onMount } from "solid-js";

export default function AdringWidget() {
  let container!: HTMLDivElement;
  let dispose: (() => void) | undefined;

  onMount(() => {
    const script = document.createElement("script");
    script.src = "https://ar-cdn.net/widget/v1.js";
    script.async = true;
    script.referrerPolicy = "origin";
    script.dataset.siteId = "a54761a6-9613-448a-b153-a53acfc0a0e2";
    script.dataset.variant = "card";
    container.append(script);
    dispose = () => {
      (script as HTMLScriptElement & { __adringCleanup?: () => void }).__adringCleanup?.();
      container.replaceChildren();
    };
  });
  onCleanup(() => dispose?.());

  return (
    <aside
      aria-label="広告"
      style={{
        "box-sizing": "border-box",
        width: "100%",
        "max-width": "488px",
        "min-height": "196px",
        margin: "0 auto",
        padding: "24px",
      }}
    >
      <div ref={container} />
    </aside>
  );
}
