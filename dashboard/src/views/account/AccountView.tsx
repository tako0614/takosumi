/** Account settings and their direct links. */
import "../../styles/wave-b.css";
import "../../styles/wave-c.css";
import "../../styles/account-views.css";
import { createEffect, For, Match, onCleanup, Show, Switch } from "solid-js";
import { A, Navigate, useBeforeLeave, useIsRouting, useParams } from "@solidjs/router";
import { ArrowLeft, Bell, ChevronRight, KeyRound, Receipt } from "lucide-solid";
import Page from "./components/auth/Page.tsx";
import type { SessionRecord } from "./lib/session.ts";
import ProfileSection from "./sections/ProfileSection.tsx";
import TakosumiApiKeysCard from "./components/TakosumiApiKeysCard.tsx";
import NotificationDevicesCard from "./components/NotificationDevicesCard.tsx";
import BillingTab from "../workspace/tabs/BillingTab.tsx";
import { type MessageKey, t } from "../../i18n/index.ts";

export type AccountSection = "me" | "usage" | "cli" | "devices";

export const ACCOUNT_SECTIONS: readonly {
  readonly id: AccountSection;
  readonly href: string;
  readonly labelKey: MessageKey;
}[] = [
  { id: "me", href: "/account", labelKey: "account.section.me" },
  { id: "usage", href: "/account/usage", labelKey: "account.section.usage" },
  { id: "cli", href: "/account/cli", labelKey: "account.section.cli" },
  { id: "devices", href: "/account/devices", labelKey: "account.section.devices" },
];

const ACCOUNT_LINK_ICONS = { usage: Receipt, cli: KeyRound, devices: Bell } as const;

function sectionFromParam(raw: string | undefined): AccountSection | undefined {
  if (raw === undefined || raw === "") return "me";
  return ACCOUNT_SECTIONS.find((section) => section.id === raw && raw !== "me")?.id;
}

function sectionFromPath(pathname: string): AccountSection | undefined {
  const path = pathname.replace(/\/+$/u, "");
  return ACCOUNT_SECTIONS.find((item) => item.href === path)?.id;
}

// /account and /account/:section are separate route registrations; navigating
// between them remounts this component. Hand focus to the matching next mount,
// but only when the router is moving between two known Account sections.
let focusHandoff: { readonly from: AccountSection; readonly to: AccountSection } | undefined;

export default function AccountView() {
  useBeforeLeave((event) => {
    focusHandoff = undefined;
    if (event.defaultPrevented) return;
    const from = sectionFromPath(event.from.pathname);
    // On history traversal the browser already exposes the destination URL.
    const destination = typeof event.to === "number"
      ? window.location.pathname
      : new URL(event.to, window.location.href).pathname;
    const to = sectionFromPath(destination);
    if (from && to && from !== to) focusHandoff = { from, to };
  });

  return (
    <Page title={t("account.title")}>
      {(session) => <Inner session={session()} />}
    </Page>
  );
}

function Inner(props: { readonly session: SessionRecord }) {
  const params = useParams<{ section?: string }>();
  const section = () => sectionFromParam(params.section);
  const isRouting = useIsRouting();
  let content: HTMLDivElement | undefined;
  let heading: HTMLHeadingElement | undefined;

  createEffect(() => {
    const target = section();
    const handoff = focusHandoff;
    if (isRouting() || !handoff || target !== handoff.to) return;
    const frame = requestAnimationFrame(() => {
      if (focusHandoff !== handoff || sectionFromPath(window.location.pathname) !== target) return;
      const row = target === "me"
        ? content?.querySelector<HTMLElement>(`[data-account-section="${handoff.from}"]`)
        : undefined;
      const focusTarget = row ?? heading;
      if (!focusTarget?.isConnected) return;
      focusHandoff = undefined;
      focusTarget.focus({ preventScroll: !row });
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const title = () => {
    const current = section();
    const label = ACCOUNT_SECTIONS.find((item) => item.id === current)?.labelKey;
    return current !== "me" && label ? t(label) : t("account.title");
  };

  return (
    <Show when={section()} fallback={<Navigate href="/account" />}>
      {(current) => (
        <div class="acct-page tg-settings-page" ref={content}>
          <Show when={current() !== "me"}>
            <A class="tg-settings-back" href="/account">
              <ArrowLeft size={16} aria-hidden="true" />
              {t("account.title")}
            </A>
          </Show>
          <header class="tg-page-header">
            <div class="tg-page-header-text">
              <h1 class="tg-page-title" tabindex="-1" ref={heading}>{title()}</h1>
            </div>
          </header>
          <div class="acct-section">
            <Switch>
              <Match when={current() === "me"}>
                <ProfileSection session={props.session}>
                  <nav class="tg-settings-group" aria-label={t("account.sectionsLabel")}>
                    <For each={ACCOUNT_SECTIONS.filter((item) => item.id !== "me")}>
                      {(item) => {
                        const Icon = ACCOUNT_LINK_ICONS[item.id as keyof typeof ACCOUNT_LINK_ICONS];
                        return (
                          <A href={item.href} class="tg-settings-row tg-settings-link" data-account-section={item.id}>
                            <span class="tg-settings-symbol"><Icon size={17} aria-hidden="true" /></span>
                            <span class="tg-settings-label">{t(item.labelKey)}</span>
                            <ChevronRight size={16} aria-hidden="true" />
                          </A>
                        );
                      }}
                    </For>
                  </nav>
                </ProfileSection>
              </Match>
              <Match when={current() === "usage"}>
                <BillingTab />
              </Match>
              <Match when={current() === "cli"}>
                <TakosumiApiKeysCard />
              </Match>
              <Match when={current() === "devices"}>
                <NotificationDevicesCard />
              </Match>
            </Switch>
          </div>
        </div>
      )}
    </Show>
  );
}
