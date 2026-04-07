import { useState } from "react";
import type { EditorDocument } from "../types";

interface TabBarProps {
  tabs: EditorDocument[];
  activeTabPath: string;
  pinnedPaths?: Set<string>;
  onSwitchTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onTogglePinTab: (path: string) => void;
  onReorderTab: (fromPath: string, toPath: string) => void;
  onTabContextMenu?: (path: string, e: React.MouseEvent) => void;
  closeTabTitle?: string;
}

export function TabBar({
  tabs,
  activeTabPath,
  pinnedPaths,
  onSwitchTab,
  onCloseTab,
  onTogglePinTab,
  onReorderTab,
  onTabContextMenu,
  closeTabTitle = "Close tab",
}: TabBarProps) {
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const isActive = tab.path === activeTabPath;
        const isPinned = pinnedPaths?.has(tab.path) ?? false;
        const fileName = tab.path.split(/[\/\\]/).pop() || tab.path;
        return (
          <div
            key={tab.path}
            draggable
            onClick={() => onSwitchTab(tab.path)}
            onContextMenu={(e) => onTabContextMenu?.(tab.path, e)}
            onDragStart={() => {
              setDraggedPath(tab.path);
              setDropTargetPath(tab.path);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (draggedPath && draggedPath !== tab.path) {
                setDropTargetPath(tab.path);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (draggedPath && draggedPath !== tab.path) {
                onReorderTab(draggedPath, tab.path);
              }
              setDraggedPath(null);
              setDropTargetPath(null);
            }}
            onDragEnd={() => {
              setDraggedPath(null);
              setDropTargetPath(null);
            }}
            className={`tab-item ${isActive ? "active" : ""} ${isPinned ? "pinned" : ""} ${
              draggedPath === tab.path ? "dragging" : ""
            } ${dropTargetPath === tab.path && draggedPath !== tab.path ? "drag-over" : ""}`}
          >
            <button
              type="button"
              className={`tab-item-pin ${isPinned ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePinTab(tab.path);
              }}
              title={isPinned ? "Unpin tab" : "Pin tab"}
            >
              {isPinned ? "★" : "☆"}
            </button>
            <span className="tab-item-label">
              <span className="tab-item-name">{fileName}{tab.isDirty ? " ●" : ""}</span>
            </span>
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
