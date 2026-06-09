import { A, useLocation } from "@solidjs/router";
import {
  Activity,
  Archive,
  Bell,
  CreditCard,
  Home,
  KeyRound,
  LayoutGrid,
  Network,
  PackageSearch,
  Settings,
  Share2,
  GitBranch,
  UserCircle2,
} from "lucide-solid";
import Wordmark from "../brand/Wordmark.tsx";

const ITEMS = [
  { href: "/home", label: "ホーム", icon: Home },
  { href: "/installations", label: "Installations", icon: LayoutGrid },
  { href: "/sources", label: "Sources", icon: GitBranch },
  { href: "/providers", label: "Providers", icon: PackageSearch },
  { href: "/graph", label: "依存グラフ", icon: Network },
  { href: "/output-shares", label: "Output shares", icon: Share2 },
  { href: "/backups", label: "Backups", icon: Archive },
  { href: "/connections", label: "接続", icon: KeyRound },
  { href: "/activity", label: "アクティビティ", icon: Activity },
  { href: "/account", label: "アカウント", icon: UserCircle2 },
  { href: "/account/settings", label: "Settings", icon: Settings },
  { href: "/account/billing", label: "Billing", icon: CreditCard },
  { href: "/notifications", label: "通知", icon: Bell },
];

/** Ported from takosumi dashboard-ui/src/components/shell/Sidebar.tsx. */
export default function Sidebar() {
  const loc = useLocation();
  const isActive = (href: string) =>
    loc.pathname === href || loc.pathname.startsWith(href + "/");
  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <Wordmark href="/home" size={22} />
      </div>
      <nav class="sidebar-nav" aria-label="Primary">
        {ITEMS.map((it) => (
          <A
            href={it.href}
            class="sidebar-link"
            classList={{ active: isActive(it.href) }}
          >
            <it.icon size={18} />
            <span>{it.label}</span>
          </A>
        ))}
      </nav>
      <div class="sidebar-footer">
        <a
          href="https://docs.takos.jp/"
          target="_blank"
          rel="external noopener"
          class="sidebar-link sidebar-link-sub"
        >
          ドキュメント →
        </a>
      </div>
    </aside>
  );
}
