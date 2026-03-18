import type { Page } from "../App";

interface SidebarProps {
  currentPage: string;
  onNavigate: (page: Page) => void;
  daemonStatus: string;
}

const navItems: { id: Page; label: string }[] = [
  { id: "stacks", label: "Stacks" },
  { id: "containers", label: "Containers" },
  { id: "images", label: "Images" },
  { id: "volumes", label: "Volumes" },
  { id: "networks", label: "Networks" },
  { id: "machine", label: "Machine" },
];

export default function Sidebar(props: SidebarProps) {
  const statusColor = () => {
    switch (props.daemonStatus) {
      case "running":
        return "#3fb950";
      case "stopped":
        return "#f85149";
      default:
        return "#848d97";
    }
  };

  return (
    <aside class="sidebar">
      <div class="sidebar-brand">Vessel</div>

      <nav class="sidebar-nav">
        {navItems.map((item) => (
          <button
            class={`nav-item ${props.currentPage === item.id ? "active" : ""}`}
            onClick={() => props.onNavigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div class="sidebar-footer">
        <span
          class="status-dot"
          style={{ background: statusColor() }}
        />
        Engine: {props.daemonStatus}
      </div>
    </aside>
  );
}
