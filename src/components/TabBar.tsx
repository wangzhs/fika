import type { EditorDocument } from "../types";

interface TabBarProps {
  tabs: EditorDocument[];
  activeTabPath: string;
  onSwitchTab: (path: string) => void;
  onCloseTab: (path: string) => void;
}

export function TabBar({ tabs, activeTabPath, onSwitchTab, onCloseTab }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar" style={{ display: "flex", background: "#1e1e1e", borderBottom: "1px solid #333", overflowX: "auto" }}>
      {tabs.map((tab) => {
        const isActive = tab.path === activeTabPath;
        const fileName = tab.path.split(/[\/\\]/).pop() || tab.path;
        return (
          <div
            key={tab.path}
            onClick={() => onSwitchTab(tab.path)}
            style={{
              padding: "6px 12px",
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              borderRight: "1px solid #333",
              background: isActive ? "#2d2d2d" : "transparent",
              color: isActive ? "#fff" : "#aaa",
              whiteSpace: "nowrap",
            }}
          >
            <span>{fileName}{tab.isDirty ? " ●" : ""}</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.path);
              }}
              style={{
                width: 16,
                height: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 4,
                fontSize: 12,
              }}
              title="Close tab"
            >
              ×
            </span>
          </div>
        );
      })}
    </div>
  );
}
