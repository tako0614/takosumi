/**
 * 「スマホで使う」: open an installed app on a phone and keep it on the home
 * screen. Most apps have no native store app, so their own web page is what
 * people use: a QR code of the app's URL for an owner at a computer, a share
 * action to hand the URL to people who only use the app (they need no
 * membership), and the add-to-home-screen steps for both phones, all shown.
 *
 * Shown wherever the dashboard already offers to open the app's screen: the
 * app page, the end of an install and the end of an applied run.
 */
import "./app-page.css";
import "./app-phone.css";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Copy, Share2 } from "lucide-solid";
import { Badge, Button } from "../../components/ui/index.ts";
import { t, type MessageKey } from "../../i18n/index.ts";
import {
  browserShareEnvironment,
  canShareUrl,
  copyUrl,
  detectPhonePlatform,
  phoneGuidanceOrder,
  phoneLaunchUrl,
  type PhonePlatform,
  qrCodeSvg,
  type ShareOutcome,
  shareOrCopyUrl,
} from "../../lib/phone-use.ts";
import { AppSection } from "./app-ui.tsx";

const GUIDANCE: Record<PhonePlatform, { readonly title: MessageKey; readonly steps: MessageKey }> = {
  ios: { title: "app.phone.iosTitle", steps: "app.phone.iosSteps" },
  android: { title: "app.phone.androidTitle", steps: "app.phone.androidSteps" },
};

/** How long "URL copied." stays before the line clears. */
const COPIED_NOTICE_MS = 4000;

export default function AppPhoneSection(props: {
  /** The app's launch URL (its primary screen). */
  readonly url: string;
  readonly appName: string;
}): JSX.Element {
  return (
    <Show when={phoneLaunchUrl(props.url)}>
      {(url) => <PhoneSection url={url()} appName={props.appName} />}
    </Show>
  );
}

function PhoneSection(props: { readonly url: string; readonly appName: string }): JSX.Element {
  const env = browserShareEnvironment();
  const qr = createMemo(() => qrCodeSvg(props.url));
  const shareable = () => canShareUrl({ title: props.appName, url: props.url }, env);
  const current = typeof navigator === "undefined"
    ? undefined
    : detectPhonePlatform({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints });
  const [outcome, setOutcome] = createSignal<ShareOutcome>();
  const [busy, setBusy] = createSignal(false);
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(clearTimer));

  const settle = (next: ShareOutcome) => {
    clearTimeout(clearTimer);
    setOutcome(next);
    if (next === "copied") clearTimer = setTimeout(() => setOutcome(undefined), COPIED_NOTICE_MS);
  };
  const run = async (action: () => Promise<ShareOutcome>) => {
    if (busy()) return;
    setBusy(true);
    setOutcome(undefined);
    try {
      settle(await action());
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppSection id="phone" title={t("app.phone.title")} subtitle={t("app.phone.subtitle")} testId="app-phone">
      <div class="ap-phone">
        <Show when={qr()} fallback={<p class="ap-muted ap-phone-noqr">{t("app.phone.qrUnavailable")}</p>}>
          {(code) => (
            <figure class="ap-phone-qr" data-testid="app-phone-qr">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox={`0 0 ${code().size} ${code().size}`}
                shape-rendering="crispEdges"
                role="img"
                aria-label={t("app.phone.qrAria", { name: props.appName })}
              >
                <rect width={code().size} height={code().size} class="ap-phone-qr-bg" />
                <path d={code().path} class="ap-phone-qr-fg" />
              </svg>
            </figure>
          )}
        </Show>
        <div class="ap-phone-body">
          <div class="ap-phone-url">
            <span class="ap-phone-label">{t("app.phone.urlLabel")}</span>
            <code data-testid="app-phone-url">{props.url}</code>
          </div>
          <div class="ap-phone-actions">
            <div class="ap-row-actions">
              <Show when={shareable()}>
                <Button
                  variant="primary"
                  type="button"
                  icon={<Share2 size={16} />}
                  disabled={busy()}
                  onClick={() => void run(() => shareOrCopyUrl({ title: props.appName, url: props.url }, env))}
                >
                  {t("app.phone.share")}
                </Button>
              </Show>
              <Button
                variant="secondary"
                type="button"
                icon={<Copy size={16} />}
                disabled={busy()}
                onClick={() => void run(() => copyUrl(props.url, env))}
              >
                {t("app.phone.copy")}
              </Button>
            </div>
            <p class="ap-phone-feedback" role="status" aria-live="polite" data-outcome={outcome() ?? ""}>
              <Show when={outcome() === "copied"}>{t("app.phone.copied")}</Show>
              <Show when={outcome() === "failed"}>{t("app.phone.copyFailed")}</Show>
            </p>
          </div>
          <p class="ap-muted">{t("app.phone.usersOnly")}</p>
        </div>
      </div>
      <div class="ap-subsection">
        <h3>{t("app.phone.homeTitle")}</h3>
        <p class="ap-muted">{t("app.phone.homeHint")}</p>
        <ul class="ap-phone-steps">
          <For each={phoneGuidanceOrder(current)}>
            {(platform) => (
              <li class="ap-phone-step" data-platform={platform} data-current={platform === current ? "" : undefined}>
                <strong>
                  {t(GUIDANCE[platform].title)}
                  <Show when={platform === current}>
                    <Badge tone="info">{t("app.phone.thisDevice")}</Badge>
                  </Show>
                </strong>
                <p>{t(GUIDANCE[platform].steps)}</p>
              </li>
            )}
          </For>
        </ul>
      </div>
    </AppSection>
  );
}
