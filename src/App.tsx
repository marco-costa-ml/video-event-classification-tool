import React, { useEffect } from "react";
import "./app.css";
import { ProjectProvider, useProject } from "@/context/ProjectContext";
import { InfoPanel } from "@/ui/InfoPanel";
import { Visualizer } from "@/ui/Visualizer";
import { WorkspaceTabs } from "@/ui/WorkspaceTabs";

function Shell() {
  const { dispatch, state } = useProject();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "m") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      dispatch({
        type: "add_manual_label",
        label: {
          id: `gt_${Date.now()}`,
          kind: "point",
          event_name: "manual_mark",
          start_frame: state.currentFrame,
          source: "manual",
        },
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, state.currentFrame]);

  return (
    <div className="app-root">
      <div className="top-pane">
        <InfoPanel />
        <Visualizer />
      </div>
      <WorkspaceTabs />
    </div>
  );
}

export default function App() {
  return (
    <ProjectProvider>
      <Shell />
    </ProjectProvider>
  );
}
