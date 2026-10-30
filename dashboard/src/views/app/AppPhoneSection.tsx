/**
 * 「スマホで使う」: how this app opens on a phone, and how to get it there.
 *
 * On a phone it is the chooser (TASK-0119; takos-control
 * `docs/platform/takosumi-app-clients.md`, 「選ぶ画面」), in this order:
 *
 * 1. the native app, when the screen declares one for this phone:
 *    「{name}で開く」 and the store link, with where notifications go;
 * 2. the web: 「ブラウザで開く」 and the add-to-home-screen steps;
 * 3. the QR code and sharing, to hand the URL to people who only use the app;
 * 4. 「この端末で覚える」, and what this device remembered, with a way to
 *    forget it.
 *
 * An unverified native app is never opened by a single tap: its real
 * destination (Android package, link scheme, link domain, store page) stays
 * on screen, opening needs an explicit confirmation, and it is never
 * remembered. Opening in a browser view or inside Takosumi belongs to
 * Takosumi Mobile and is not offered here.
 *
 * On a computer it keeps its first job: the QR code and share actions to get
 * the app onto a phone, with the declared native apps listed for reference
 * and both phones' home-screen steps.
 *
 * Shown wherever the dashboard already offers to open the app's screen: the
 * app page, the end of an install and the end of an applied run. Only the app
 * page knows the screen's native clients; elsewhere the section offers the
 * web only.
 */
import "./app-page.css";
import "./app-phone.css";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Copy, ExternalLink, Share2, Smartphone } from "lucide-solid";
import { Badge, Button } from "../../components/ui/index.ts";
import { t, type MessageKey } from "../../i18n/index.ts";
import {
  browserShareEnvironment,
  canShareUrl,
  copyUrl,
  phoneGuidanceOrder,
  phoneLaunchUrl,
  type PhonePlatform,
  qrCodeSvg,
  type ShareOutcome,
  shareOrCopyUrl,
} from "../../lib/phone-use.ts";
import {
  chosenNativeHref,
  declaredPhoneClients,
  type PhoneClient,
  phoneClient,
  rememberableChoice,
  storeDestination,
  storeKind,
} from "../../lib/open-routing.ts";
import {
  currentOpenPlatform,
  forgetRememberedOpenChoice,
  openChoiceStorageAvailable,
  openChooserFallbackUrl,
  rememberedOpenChoice,
  rememberOpenChoice,
} from "../../lib/open-choice-state.ts";
import { AppSection } from "./app-ui.tsx";

const GUIDANCE: Record<PhonePlatform, { readonly title: MessageKey; readonly steps: MessageKey }> = {
  ios: { title: "app.phone.iosTitle", steps: "app.phone.iosSteps" },
  android: { title: "app.phone.androidTitle", steps: "app.phone.androidSteps" },
};

const PLATFORM_LABEL: Record<PhonePlatform, MessageKey> = {
  ios: "app.phone.platformIos",
  android: "app.phone.platformAndroid",
};

const STORE_LABEL: Record<NonNullable<ReturnType<typeof storeKind>>, MessageKey> = {
  appStore: "app.phone.storeAppStore",
  testFlight: "app.phone.storeTestFlight",
  googlePlay: "app.phone.storeGooglePlay",
  fDroid: "app.phone.storeFDroid",
};

/** How long "URL copied." stays before the line clears. */
const COPIED_NOTICE_MS = 4000;

export default function AppPhoneSection(props: {
  /** The app's launch URL (the screen this section is for). */
  readonly url: string;
  /** The app's display name; empty while it is unknown. */
  readonly appName: string;
  /** The app and screen, for remembering a choice; without them nothing is remembered. */
  readonly capsuleId?: string;
  readonly interfaceId?: string;
  /** The screen's `clients` from the app view, as the server verified them. */
  readonly clients?: unknown;
  /** Back from Android's fallback link: the native app did not open. */
  readonly missing?: boolean;
}): JSX.Element {
  return (
    <Show when={phoneLaunchUrl(props.url)}>
      {(url) => (
        <PhoneSection
          url={url()}
          appName={props.appName}
          {...(props.capsuleId && props.interfaceId
            ? { identity: { capsuleId: props.capsuleId, interfaceId: props.interfaceId } }
            : {})}
          clients={props.clients}
          missing={props.missing === true}
        />
      )}
    </Show>
  );
}

/** The label of a native client: its checked name, else a neutral one (never the screen's title). */
function clientLabel(client: PhoneClient): string {
  return client.name ?? t("app.phone.unverifiedName");
}

function PhoneSection(props: {
  readonly url: string;
  readonly appName: string;
  readonly identity?: { readonly capsuleId: string; readonly interfaceId: string };
  readonly clients: unknown;
  readonly missing: boolean;
}): JSX.Element {
  const env = browserShareEnvironment();
  const platform = currentOpenPlatform();
  const phone = platform === "desktop" ? undefined : platform;
  const qr = createMemo(() => qrCodeSvg(props.url));
  const name = () => props.appName.trim();
  /** The share sheet's title is the app's name when it is known. */
  const shareData = () => ({ ...(name() ? { title: name() } : {}), url: props.url });
  const shareable = () => canShareUrl(shareData(), env);
  const connectHost = () => new URL(props.url).host;
  const client = createMemo(() => phoneClient(props.clients, platform));
  const declared = createMemo(() => (phone ? [] : declaredPhoneClients(props.clients)));
  const fallbackUrl = () =>
    props.identity ? openChooserFallbackUrl(props.identity.capsuleId, props.identity.interfaceId) : undefined;
  const nativeHref = () => {
    const value = client();
    return value ? chosenNativeHref(value, fallbackUrl()) : undefined;
  };
  const remembered = () =>
    props.identity ? rememberedOpenChoice(props.identity.capsuleId, props.identity.interfaceId) : undefined;
  /** "native" counts only for the verified client it was chosen for. */
  const rememberedNativeHere = () => {
    const choice = remembered();
    const value = client();
    return choice?.choice === "native" && value?.verified === true &&
      choice.platform === value.platform && choice.trustedClientId === value.trustedClientId;
  };
  const [remember, setRemember] = createSignal(false);
  const [rememberFailed, setRememberFailed] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  let confirmLink: HTMLAnchorElement | undefined;

  const keep = (choice: "web" | "native") => {
    const identity = props.identity;
    if (!identity || !remember()) return;
    const value = rememberableChoice(choice, client(), platform);
    if (!value) return;
    setRememberFailed(!rememberOpenChoice(identity.capsuleId, identity.interfaceId, value));
  };
  const forget = () => {
    const identity = props.identity;
    if (!identity) return;
    setRememberFailed(!forgetRememberedOpenChoice(identity.capsuleId, identity.interfaceId));
  };
  const askToOpenUnverified = () => {
    setConfirming(true);
    queueMicrotask(() => confirmLink?.focus());
  };

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

  const qrBlock = () => (
    <div class="ap-phone" data-testid="app-phone-share">
      <Show when={qr()} fallback={<p class="ap-muted ap-phone-noqr">{t("app.phone.qrUnavailable")}</p>}>
        {(code) => (
          <figure class="ap-phone-qr" data-testid="app-phone-qr">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox={`0 0 ${code().size} ${code().size}`}
              shape-rendering="crispEdges"
              role="img"
              aria-label={name() ? t("app.phone.qrAria", { name: name() }) : t("app.phone.qrAriaUnnamed")}
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
                variant="secondary"
                type="button"
                icon={<Share2 size={16} />}
                disabled={busy()}
                onClick={() => void run(() => shareOrCopyUrl(shareData(), env))}
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
  );

  const homeSteps = () => (
    <>
      <h4 class="ap-phone-subhead">{t("app.phone.homeTitle")}</h4>
      <p class="ap-muted">{t("app.phone.homeHint")}</p>
      <ul class="ap-phone-steps">
        <For each={phoneGuidanceOrder(phone)}>
          {(item) => (
            <li class="ap-phone-step" data-platform={item} data-current={item === phone ? "" : undefined}>
              <strong>
                {t(GUIDANCE[item].title)}
                <Show when={item === phone}>
                  <Badge tone="info">{t("app.phone.thisDevice")}</Badge>
                </Show>
              </strong>
              <p>{t(GUIDANCE[item].steps)}</p>
            </li>
          )}
        </For>
      </ul>
    </>
  );

  const storeButton = (value: PhoneClient) => (
    <Show when={value.storeUrl}>
      {(store) => {
        const kind = storeKind(store());
        return (
          <Button variant="secondary" href={store()} rel="noreferrer noopener" target="_blank">
            {kind ? t(STORE_LABEL[kind]) : t("app.phone.nativeInstall", { name: clientLabel(value) })}
          </Button>
        );
      }}
    </Show>
  );

  /** Where an unverified client really goes; always on screen, never folded. */
  const destination = (value: PhoneClient) => (
    <ul class="ap-phone-target" data-testid="app-phone-target">
      <Show when={value.target.package}>
        {(item) => <li>{t("app.phone.targetPackage")} <code>{item()}</code></li>}
      </Show>
      <Show when={value.target.scheme}>
        {(item) => <li>{t("app.phone.targetScheme")} <code>{`${item()}:`}</code></li>}
      </Show>
      <Show when={value.target.host}>
        {(item) => <li>{t("app.phone.targetHost")} <code>{item()}</code></li>}
      </Show>
      <Show when={value.storeUrl ? storeDestination(value.storeUrl) : undefined}>
        {(item) => <li>{t("app.phone.storeDestination")} <code>{item()}</code></li>}
      </Show>
    </ul>
  );

  return (
    <AppSection
      id="phone"
      class="ap-phone-section"
      title={t("app.phone.title")}
      subtitle={phone ? t("app.phone.chooseSubtitle") : t("app.phone.subtitle")}
      testId="app-phone"
    >
      <div class="ap-phone-options" data-platform={platform}>
        {/* 1. The native app this phone can open. */}
        <Show when={client()}>
          {(value) => (
            <div
              class="ap-phone-option"
              data-testid="app-phone-native"
              data-verified={value().verified ? "true" : "false"}
            >
              <h3 class="ap-phone-option-title">
                <Smartphone size={18} aria-hidden="true" />
                <span>{t("app.phone.nativeTitle")}</span>
                <span class="ap-phone-client-name">{clientLabel(value())}</span>
                <Badge tone={value().verified ? "ok" : "warn"}>
                  {value().verified ? t("app.phone.verifiedBadge") : t("app.phone.unverifiedBadge")}
                </Badge>
              </h3>
              <Show when={props.missing}>
                <p class="ap-phone-missing" role="status" data-testid="app-phone-missing">
                  {t("app.phone.missing", { name: clientLabel(value()) })}
                </p>
              </Show>
              <p class="ap-muted">{t("app.phone.nativeNotify")}</p>
              <p class="ap-muted">{t("app.phone.connectsTo", { host: connectHost() })}</p>
              <Show when={!value().verified}>
                <div class="ap-phone-unverified" role="note">
                  <p>{t("app.phone.unverifiedWarning")}</p>
                  {destination(value())}
                  <p class="ap-muted">{t("app.phone.unverifiedNoRemember")}</p>
                </div>
              </Show>
              <div class="ap-row-actions">
                <Show when={nativeHref()}>
                  {(href) => (
                    <Show
                      when={value().verified}
                      fallback={
                        <Button
                          variant="secondary"
                          type="button"
                          icon={<Smartphone size={16} />}
                          disabled={confirming()}
                          onClick={askToOpenUnverified}
                        >
                          {t("app.phone.nativeOpen", { name: clientLabel(value()) })}
                        </Button>
                      }
                    >
                      <Button
                        variant="secondary"
                        href={href()}
                        rel="noreferrer"
                        icon={<Smartphone size={16} />}
                        data-open-choice="native"
                        onClick={() => keep("native")}
                      >
                        {t("app.phone.nativeOpen", { name: clientLabel(value()) })}
                      </Button>
                    </Show>
                  )}
                </Show>
                {storeButton(value())}
              </div>
              <Show when={!value().verified && confirming() ? nativeHref() : undefined}>
                {(href) => (
                  <div class="ap-phone-confirm" role="group" aria-labelledby="app-phone-confirm-title" data-testid="app-phone-confirm">
                    <p id="app-phone-confirm-title"><strong>{t("app.phone.confirmTitle", { name: clientLabel(value()) })}</strong></p>
                    <p class="ap-muted">{t("app.phone.confirmBody", { host: connectHost() })}</p>
                    <div class="ap-row-actions">
                      <a
                        ref={confirmLink}
                        class="tg-btn tg-btn-secondary"
                        href={href()}
                        rel="noreferrer"
                        data-open-choice="native-unverified"
                      >
                        {t("app.phone.confirmOpen")}
                      </a>
                      <Button variant="ghost" type="button" onClick={() => setConfirming(false)}>
                        {t("app.phone.confirmCancel")}
                      </Button>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          )}
        </Show>

        {/* On a computer: the native apps declared for each phone, for reference. */}
        <Show when={declared().length > 0}>
          <div class="ap-phone-option" data-testid="app-phone-native-list">
            <h3 class="ap-phone-option-title">
              <Smartphone size={18} aria-hidden="true" />
              <span>{t("app.phone.nativeTitle")}</span>
            </h3>
            <p class="ap-muted">{t("app.phone.desktopNative")}</p>
            <ul class="ap-phone-native-list">
              <For each={declared()}>
                {(value) => (
                  <li data-platform={value.platform} data-verified={value.verified ? "true" : "false"}>
                    <strong>
                      {t(PLATFORM_LABEL[value.platform])}: {clientLabel(value)}
                      <Badge tone={value.verified ? "ok" : "warn"}>
                        {value.verified ? t("app.phone.verifiedBadge") : t("app.phone.unverifiedBadge")}
                      </Badge>
                    </strong>
                    <Show when={!value.verified}>{destination(value)}</Show>
                    <div class="ap-row-actions">{storeButton(value)}</div>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>

        {/* On a computer the QR code comes first: it is how the app gets to a phone. */}
        <Show when={!phone}>{qrBlock()}</Show>

        {/* 2. The web, in the browser or from the home screen. */}
        <div class="ap-phone-option" data-testid="app-phone-web">
          <h3 class="ap-phone-option-title">
            <ExternalLink size={18} aria-hidden="true" />
            <span>{t("app.phone.webTitle")}</span>
          </h3>
          <p class="ap-muted">{t("app.phone.webNotify")}</p>
          <Show when={phone}>
            <div class="ap-row-actions">
              <Button
                variant="secondary"
                href={props.url}
                target="_blank"
                rel="noreferrer noopener"
                icon={<ExternalLink size={16} />}
                data-open-choice="web"
                onClick={() => keep("web")}
              >
                {t("app.phone.webOpen")}
              </Button>
            </div>
          </Show>
          {homeSteps()}
        </div>

        {/* 3. The QR code and sharing, for people who only use the app. */}
        <Show when={phone}>{qrBlock()}</Show>

        {/* 4. Remember the choice on this device. */}
        <Show when={phone && props.identity}>
          <div class="ap-phone-remember" data-testid="app-phone-remember">
            <Show
              when={openChoiceStorageAvailable()}
              fallback={<p class="ap-muted" data-testid="app-phone-no-storage">{t("app.phone.storageUnavailable")}</p>}
            >
              <label class="ap-phone-check">
                <input
                  type="checkbox"
                  checked={remember()}
                  onChange={(event) => setRemember(event.currentTarget.checked)}
                />
                <span>{t("app.phone.remember")}</span>
              </label>
              <p class="ap-muted">{t("app.phone.rememberHint")}</p>
            </Show>
            <p class="ap-phone-remembered" role="status" aria-live="polite" data-testid="app-phone-remembered">
              <Show when={rememberFailed()}>{t("app.phone.rememberFailed")}</Show>
              <Show when={!rememberFailed() && remembered()}>
                {(choice) => (
                  <>
                    <span>
                      {choice().choice === "web"
                        ? t("app.phone.rememberedWeb")
                        : rememberedNativeHere()
                        ? t("app.phone.rememberedNative", { name: client()?.name ?? "" })
                        : t("app.phone.rememberedNativeOther")}
                    </span>
                    <Button variant="secondary" size="sm" type="button" onClick={forget}>
                      {t("app.phone.forget")}
                    </Button>
                  </>
                )}
              </Show>
            </p>
          </div>
        </Show>
      </div>
    </AppSection>
  );
}
