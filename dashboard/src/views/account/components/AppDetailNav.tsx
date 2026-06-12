import Tabs, { type TabItem } from "../../../components/ui/Tabs.tsx";

/** Ported from takosumi dashboard-ui/src/components/apps/AppDetailNav.tsx. */
export default function AppDetailNav(props: { installationId: string }) {
  const base = `/apps/${encodeURIComponent(props.installationId)}`;
  const items: TabItem[] = [
    { href: base, label: "概要", end: true },
    { href: `${base}/danger`, label: "削除", end: true },
  ];
  return <Tabs items={items} aria-label="App sections" />;
}
