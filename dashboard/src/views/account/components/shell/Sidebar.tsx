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
  Users,
  UserCircle2,
} from "lucide-solid";
import Wordmark from "../brand/Wordmark.tsx";

type NavItem = { href: string; label: string; sub?: string; icon: typeof Home };

/**
 * Primary nav: everyday wording, always visible. These six cover the whole
 * "git URL のボタン → 導入 → 使う" loop without any spec jargon. `/installations`
 * ("アプリ") is the CONTROL-plane Installation list — the plane that both
 * bundled first-party apps and `/install` installs actually write — so a
 * just-installed app shows up here (the legacy `/apps` list read a different,
 * near-empty plane and never surfaced control-plane installs).
 */
const PRIMARY: NavItem[] = [
  { href: "/home", label: "ホーム", icon: Home },
  { href: "/installations", label: "アプリ", icon: LayoutGrid },
  { href: "/install", label: "導入", sub: "Git から", icon: GitBranch },
  { href: "/connections", label: "接続", icon: KeyRound },
  { href: "/activity", label: "アクティビティ", icon: Activity },
  { href: "/account", label: "アカウント", icon: UserCircle2 },
];

/**
 * Advanced nav: every remaining spec-vocab surface, collapsed by default but
 * fully reachable once expanded. Nothing is removed — this only folds the
 * developer-facing detail screens out of the everyday line of sight. Plain
 * Japanese leads; the spec term rides along as a sub-label where it helps a
 * developer recognize the surface.
 */
const ADVANCED: NavItem[] = [
  { href: "/sources", label: "ソース", sub: "Sources", icon: GitBranch },
  { href: "/providers", label: "プロバイダ", sub: "Providers", icon: PackageSearch },
  { href: "/graph", label: "依存グラフ", sub: "Dependency graph", icon: Network },
  { href: "/output-shares", label: "出力の共有", sub: "Output shares", icon: Share2 },
  { href: "/backups", label: "バックアップ", sub: "Backups", icon: Archive },
  { href: "/members", label: "メンバー", sub: "Members", icon: Users },
  { href: "/notifications", label: "通知", icon: Bell },
  { href: "/account/settings", label: "設定", sub: "Settings", icon: Settings },
  { href: "/account/billing", label: "お支払い", sub: "Billing", icon: CreditCard },
];

/** Ported from takosumi dashboard-ui/src/components/shell/Sidebar.tsx. */
export default function Sidebar() {
  const loc = useLocation();
  const isActive = (href: string) =>
    loc.pathname === href || loc.pathname.startsWith(href + "/");
  /** Keep the advanced section open if the current route lives inside it, so a
   * deep-link to e.g. /providers doesn't hide its own nav entry. */
  const advancedActive = () => ADVANCED.some((it) => isActive(it.href));
  const renderLink = (it: NavItem) => (
    <A
      href={it.href}
      class="sidebar-link"
      classList={{ active: isActive(it.href) }}
    >
      <it.icon size={18} />
      <span class="sidebar-link-label">
        {it.label}
        {it.sub ? <span class="sidebar-link-spec">{it.sub}</span> : null}
      </span>
    </A>
  );
  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <Wordmark href="/home" size={22} />
      </div>
      <nav class="sidebar-nav" aria-label="Primary">
        {PRIMARY.map(renderLink)}
      </nav>
      <details class="sidebar-advanced" open={advancedActive()}>
        <summary class="sidebar-advanced-summary">
          <Settings size={16} />
          <span>詳細・上級設定</span>
        </summary>
        <nav class="sidebar-nav sidebar-advanced-nav" aria-label="Advanced">
          {ADVANCED.map(renderLink)}
        </nav>
      </details>
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
