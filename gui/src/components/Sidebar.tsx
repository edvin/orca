interface SidebarProps {
  currentPage: string;
  onNavigate: (page: any) => void;
  daemonStatus: string;
}

const navItems = [
  { id: "containers", label: "Containers" },
  { id: "images", label: "Images" },
  { id: "volumes", label: "Volumes" },
  { id: "machine", label: "Machine" },
] as const;

export default function Sidebar(props: SidebarProps) {
  const statusColor = () => {
    switch (props.daemonStatus) {
      case "running": return "#3fb950";
      case "stopped": return "#f85149";
      default: return "#848d97";
    }
  };

  return (
    <aside style={{
      width: "220px",
      background: "#161b22",
      "border-right": "1px solid #30363d",
      display: "flex",
      "flex-direction": "column",
      padding: "16px 0",
    }}>
      <div style={{ padding: "0 16px 20px", "font-size": "20px", "font-weight": "bold" }}>
        Vessel
      </div>

      <nav style={{ flex: 1 }}>
        {navItems.map((item) => (
          <button
            onClick={() => props.onNavigate(item.id)}
            style={{
              display: "block",
              width: "100%",
              padding: "10px 16px",
              border: "none",
              background: props.currentPage === item.id ? "#1f2937" : "transparent",
              color: props.currentPage === item.id ? "#58a6ff" : "#c9d1d9",
              "text-align": "left",
              cursor: "pointer",
              "font-size": "14px",
              "border-left": props.currentPage === item.id ? "3px solid #58a6ff" : "3px solid transparent",
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div style={{
        padding: "12px 16px",
        "border-top": "1px solid #30363d",
        "font-size": "12px",
        color: "#848d97",
        display: "flex",
        "align-items": "center",
        gap: "8px",
      }}>
        <span style={{
          width: "8px",
          height: "8px",
          "border-radius": "50%",
          background: statusColor(),
          display: "inline-block",
        }} />
        Engine: {props.daemonStatus}
      </div>
    </aside>
  );
}
