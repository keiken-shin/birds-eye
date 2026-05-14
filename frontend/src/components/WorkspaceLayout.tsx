import React from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

interface WorkspaceLayoutProps {
  centerCanvas: React.ReactNode;
}

export const WorkspaceLayout: React.FC<WorkspaceLayoutProps> = ({ centerCanvas }) => {
  return (
    <div className="h-screen w-screen bg-[#0a0a0f] text-slate-300 overflow-hidden font-sans">
      <PanelGroup direction="horizontal">
        <Panel defaultSize={20} minSize={10}>
          <div className="h-full border-r border-white/10 p-4">
            <h2 className="text-xs font-mono text-indigo-400 mb-4 uppercase">Contexts</h2>
            <div className="space-y-2">
              <div className="p-2 bg-slate-800/50 rounded cursor-pointer hover:bg-slate-800 transition-colors">Media</div>
              <div className="p-2 bg-slate-800/50 rounded cursor-pointer hover:bg-slate-800 transition-colors">Documents</div>
              <div className="p-2 bg-slate-800/50 rounded cursor-pointer hover:bg-slate-800 transition-colors">Downloads</div>
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="w-1 bg-white/5 hover:bg-indigo-500/50 transition-colors" />

        <Panel defaultSize={60}>
          <PanelGroup direction="vertical">
            <Panel defaultSize={75}>
              <div className="h-full w-full relative">
                {centerCanvas}
              </div>
            </Panel>
            <PanelResizeHandle className="h-1 bg-white/5 hover:bg-indigo-500/50 transition-colors" />
            <Panel defaultSize={25} minSize={10}>
              <div className="h-full border-t border-white/10 p-4 bg-[#0d0d14]">
                <h2 className="text-xs font-mono text-slate-500 mb-2 uppercase">Timeline / Queue</h2>
                <div className="text-slate-400 italic text-sm mt-4 text-center">No pending actions</div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="w-1 bg-white/5 hover:bg-indigo-500/50 transition-colors" />
        <Panel defaultSize={20} minSize={10}>
          <div className="h-full border-l border-white/10 p-4 flex flex-col">
            <div className="flex-1 border-b border-white/10 pb-4 mb-4">
              <h2 className="text-xs font-mono text-indigo-400 mb-2 uppercase">Inspector</h2>
              <div className="text-sm text-slate-400 mt-4 text-center">Select an item</div>
            </div>
            <div className="flex-1">
              <h2 className="text-xs font-mono text-rose-400 mb-2 uppercase">Alerts</h2>
              <div className="text-sm text-slate-400 mt-4 text-center">No alerts</div>
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
};
