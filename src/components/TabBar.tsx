import type { EditorDocument } from "../types";

interface TabBarProps {
  tabs: EditorDocument[];
  activeTabPath: string;
  onSwitchTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  closeTabTitle?: string;
}

export function TabBar({ tabs, activeTabPath, onSwitchTab, onCloseTab, closeTabTitle = "Close tab" }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const isActive = tab.path === activeTabPath;
        const fileName = tab.path.split(/[\/\\]/).pop() || tab.path;
        return (
          <div
            key={tab.path}
            onClick={() => onSwitchTab(tab.path)}
            className={`tab-item ${isActive ? "active" : ""}`}
          >
            <span className="tab-item-label">{fileName}{tab.isDirty ? " ●" : ""}</span>
            <span
              className="tab-item-close"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.path);
              }}
              title={closeTabTitle}
            >
              ×
            </span>
          </div>
        );
      })}
    </div>
  );
}
