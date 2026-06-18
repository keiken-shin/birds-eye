import { formatBytes } from "@bridge/domain";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { nodeName } from "../lib/folderTree";

export function TitleBar() {
  const { scopePath } = useWorkspace();
  const { activeEntry, tree, overview } = useIndexData();

  const scopeTitle = scopePath.length
    ? nodeName(scopePath[scopePath.length - 1])
    : activeEntry?.root_path
      ? nodeName(activeEntry.root_path)
      : "No scope";

  const indexedBytes = overview?.folders.reduce((max, f) => Math.max(max, f.total_bytes), 0) ?? 0;
  const status = activeEntry
    ? `${formatBytes(indexedBytes)} indexed`
    : tree
      ? "ready"
      : "no scan yet";

  return (
    <div className="flex h-[34px] flex-none items-center gap-2 border-b border-line bg-bar px-3.5">
      <span className="flex items-center gap-2 text-12 text-muted">
        <span className="font-semibold text-primary">◗ Bird's Eye</span>
        <span className="text-[#3a3f48]">/</span>
        <span>{scopeTitle}</span>
      </span>
      <span className="mono ml-auto text-11 text-dim">{status}</span>
    </div>
  );
}
