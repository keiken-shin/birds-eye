import { Bird } from "lucide-react";
import { formatBytes, formatCount } from "@bridge/domain";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { nodeName } from "../lib/folderTree";

export function TitleBar() {
  const { scopePath } = useWorkspace();
  const { activeEntry } = useIndexData();

  const scopeTitle = scopePath.length
    ? nodeName(scopePath[scopePath.length - 1])
    : activeEntry?.root_path
      ? nodeName(activeEntry.root_path)
      : "No scope";

  return (
    <div className="flex h-[34px] flex-none items-center gap-2 border-b border-line bg-bar px-3.5">
      <span className="flex min-w-0 items-center gap-2 text-12 text-muted">
        <span className="flex flex-none items-center gap-1.5 font-semibold text-primary">
          <Bird size={14} strokeWidth={2} aria-hidden />
          Bird's Eye
        </span>
        <span className="flex-none text-label">/</span>
        <span className="truncate">{scopeTitle}</span>
      </span>
      {activeEntry ? (
        <span className="mono ml-auto flex-none text-11 text-dim">
          {formatBytes(activeEntry.bytes_scanned)} indexed · {formatCount(activeEntry.files_scanned)}{" "}
          files
        </span>
      ) : null}
    </div>
  );
}
