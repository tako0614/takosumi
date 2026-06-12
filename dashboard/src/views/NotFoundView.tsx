/**
 * Real 404. The previous SPA had a silent catch-all that bounced any unknown
 * URL to /home, which hid typos and dead links; this page says so instead.
 * Signed-out visitors still get the sign-in redirect from AuthGuard-gated
 * pages they navigate to — this view itself is public on purpose so the 404
 * answer never depends on a session probe.
 */
import { Compass } from "lucide-solid";
import { setDocumentTitle, t } from "../i18n/index.ts";
import { onMount } from "solid-js";
import InkBackdrop from "../components/ui/InkBackdrop.tsx";
import Button from "../components/ui/Button.tsx";

export default function NotFoundView() {
  onMount(() => setDocumentTitle(t("notFound.title")));
  return (
    <div class="auth-page">
      <InkBackdrop density="auth" />
      <div class="sign-in-panel notfound-panel">
        <Compass size={40} aria-hidden="true" />
        <h1 class="sign-in-title">{t("notFound.title")}</h1>
        <p class="sign-in-sub">{t("notFound.message")}</p>
        <Button variant="primary" href="/">
          {t("notFound.goHome")}
        </Button>
      </div>
    </div>
  );
}
