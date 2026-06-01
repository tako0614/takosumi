import type { JSX } from "solid-js";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import MobileTabs from "./MobileTabs";

interface Props {
  children: JSX.Element;
}

export default function AppShell(props: Props) {
  return (
    <div class="app-shell">
      <a href="#main" class="skip-link">本文へスキップ</a>
      <Sidebar />
      <div class="app-shell-main">
        <TopBar />
        <main class="app-shell-content" id="main" tabindex="-1">
          {props.children}
        </main>
      </div>
      <MobileTabs />
    </div>
  );
}
