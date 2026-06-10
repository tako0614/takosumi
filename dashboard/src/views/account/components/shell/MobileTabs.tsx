import { A, useLocation } from "@solidjs/router";
import {
  Archive,
  GitBranch,
  Home,
  KeyRound,
  LayoutGrid,
  Network,
  PackageSearch,
  Store,
} from "lucide-solid";

const TABS = [
  { href: "/home", label: "ホーム", icon: Home },
  { href: "/catalog", label: "選ぶ", icon: Store },
  { href: "/installations", label: "Installs", icon: LayoutGrid },
  { href: "/sources", label: "Sources", icon: GitBranch },
  { href: "/providers", label: "Providers", icon: PackageSearch },
  { href: "/graph", label: "Graph", icon: Network },
  { href: "/backups", label: "Backups", icon: Archive },
  { href: "/connections", label: "接続", icon: KeyRound },
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
