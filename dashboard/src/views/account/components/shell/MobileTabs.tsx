import { A, useLocation } from "@solidjs/router";
import {
  Activity,
  GitBranch,
  Home,
  KeyRound,
  LayoutGrid,
  UserCircle2,
} from "lucide-solid";

/**
 * Mobile bottom bar mirrors the sidebar's primary (everyday) set so phone users
 * get the same plain-Japanese entry points. The desktop sidebar is hidden on
 * phones (account.css `@media (max-width: 880px) .sidebar { display: none }`),
 * so on mobile the advanced management surfaces (Installations / Sources /
 * Providers / Graph / Output shares / Backups / Members) are reached through the
 * "アカウント" tab → /account hub, whose "アプリの管理" section links to every
 * one of them. Nothing is removed; every route stays reachable from nav chrome.
 */
const TABS = [
  { href: "/home", label: "ホーム", icon: Home },
  { href: "/installations", label: "アプリ", icon: LayoutGrid },
  { href: "/install", label: "導入", icon: GitBranch },
  { href: "/connections", label: "接続", icon: KeyRound },
  { href: "/activity", label: "履歴", icon: Activity },
  { href: "/account", label: "アカウント", icon: UserCircle2 },
];

/** Ported from takosumi dashboard-ui/src/components/shell/MobileTabs.tsx. */
export default function MobileTabs() {
  const loc = useLocation();
  return (
    <nav class="mobile-tabs" aria-label="Mobile primary">
      {TABS.map((t) => (
        <A
          href={t.href}
          class="mobile-tab"
          classList={{
            active: loc.pathname === t.href ||
              loc.pathname.startsWith(t.href + "/"),
          }}
        >
          <t.icon size={20} />
          <span>{t.label}</span>
        </A>
      ))}
    </nav>
  );
}
