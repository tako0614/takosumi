import { onCleanup, onMount } from "solid-js";

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Subtle parallax: translates the element on scroll by `speed` × scrollY while
 * the hero is on screen. Disabled under reduced motion.
 */
export function useParallax(
  getEl: () => HTMLElement | undefined,
  speed = 0.12,
): void {
  onMount(() => {
    if (prefersReducedMotion()) return;
    let ticking = false;
    const update = () => {
      ticking = false;
      const el = getEl();
      if (!el) return;
      const y = globalThis.scrollY ?? 0;
      if (y > globalThis.innerHeight) return; // only while hero is in view
      el.style.transform = `translate3d(0, ${y * speed}px, 0)`;
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };
    update();
    globalThis.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => globalThis.removeEventListener("scroll", onScroll));
  });
}
