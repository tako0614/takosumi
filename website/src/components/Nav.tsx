import { createSignal, For, onCleanup, onMount } from "solid-js";
import Wordmark from "./brand/Wordmark";

interface NavLink {
  readonly href: string;
  readonly label: string;
  readonly rel?: string;
}

const NAV_LINKS: readonly NavLink[] = [
  { href: "#why", label: "なぜ" },
  { href: "#how", label: "使い方" },
  { href: "#pricing", label: "料金" },
  { href: "/docs/", label: "ドキュメント", rel: "external" },
];

export default function Nav() {
  const [scrolled, setScrolled] = createSignal(false);

  onMount(() => {
    const onScroll = () => {
      // Hero is min-100vh; flip nav state once the user is past ~70vh
      setScrolled(globalThis.scrollY > globalThis.innerHeight * 0.7);
    };
    onScroll();
    globalThis.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => globalThis.removeEventListener("scroll", onScroll));
  });

  return (
    <header class="nav" classList={{ "is-scrolled": scrolled() }}>
      <a class="skip-link" href="#main">
        本文へスキップ
      </a>
      <div class="nav-inner container">
        <Wordmark variant="geometric" />
        <nav class="nav-links" aria-label="Primary">
          <For each={NAV_LINKS}>
            {(l) => (
              <a href={l.href} rel={l.rel}>
                {l.label}
              </a>
            )}
          </For>
        </nav>
        <div class="nav-actions">
          <a
            class="nav-icon"
            href="https://github.com/tako0614/takosumi"
            rel="noopener"
            aria-label="GitHub"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.32-1.28-1.67-1.28-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.07.78 2.15v3.18c0 .31.21.68.8.56C20.21 21.38 23.5 17.07 23.5 12 23.5 5.65 18.35.5 12 .5z" />
            </svg>
          </a>
          <a
            class="btn btn-primary nav-cta"
            href="https://app.takosumi.com/"
            rel="noopener"
          >
            始める
          </a>
          <details class="nav-menu">
            <summary class="nav-icon nav-menu-toggle" aria-label="メニュー">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </summary>
            <nav class="nav-menu-panel" aria-label="メニュー">
              <For each={NAV_LINKS}>
                {(l) => (
                  <a href={l.href} rel={l.rel}>
                    {l.label}
                  </a>
                )}
              </For>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
