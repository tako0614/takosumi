import Wordmark from "./brand/Wordmark";

export default function Footer() {
  return (
    <footer class="site">
      <div class="container">
        <div style="display: flex; align-items: center; gap: 12px;">
          <Wordmark variant="geometric" size={20} />
          <span class="copy">© Takos / Takosumi contributors — MIT</span>
        </div>
        <nav aria-label="Footer">
          <a href="/docs/" rel="external">Docs</a>
          <a href="https://github.com/tako0614/takosumi" rel="noopener">
            GitHub
          </a>
          <a href="https://jsr.io/@takos/takosumi" rel="noopener">JSR</a>
          <a href="https://cloud.takosumi.com/" rel="noopener">Cloud</a>
        </nav>
      </div>
    </footer>
  );
}
