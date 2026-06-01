import { A } from "@solidjs/router";
import { Bell } from "lucide-solid";
import ThemeToggle from "../ui/ThemeToggle";
import UserMenu from "../auth/UserMenu";

export default function TopBar() {
  return (
    <header class="topbar">
      <div class="topbar-actions">
        <A href="/notifications" class="topbar-icon-btn" aria-label="通知">
          <Bell size={18} />
        </A>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
