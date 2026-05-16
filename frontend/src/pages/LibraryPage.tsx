import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderOpen, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useScanContext } from "../context/ScanContext";
import { deleteNativeIndex } from "../nativeClient";
import type { NativeIndexEntry } from "../nativeClient";
import { formatBytes, formatCount } from "../domain";

const mono = "font-mono text-[11px] uppercase";

export function LibraryPage() {
  const {
    savedIndexes,
    refreshSavedIndexes,
    openSavedIndex,
    rescanSavedIndex,
    workspaceIndexPath,
    clearScan,
  } = useScanContext();
  const [filterQuery, setFilterQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const navigate = useNavigate();

  const filtered = savedIndexes.filter((entry) => {
    if (!filterQuery.trim()) return true;
    const q = filterQuery.toLowerCase();
    return (
      entry.index_path.toLowerCase().includes(q) ||
      (entry.root_path ?? "").toLowerCase().includes(q)
    );
  });

  async function handleLoad(entry: NativeIndexEntry) {
    await openSavedIndex(entry);
    navigate("/workspace");
  }

  async function handleRescan(entry: NativeIndexEntry) {
    await rescanSavedIndex(entry);
    navigate("/scan");
  }

  async function handleDelete(entry: NativeIndexEntry) {
    await deleteNativeIndex(entry.index_path);
    if (workspaceIndexPath === entry.index_path) clearScan();
    await refreshSavedIndexes();
    setConfirmDelete(null);
  }

  return (
    <section className="relative z-[1] mx-auto max-w-[1440px] min-w-0 px-[42px] pb-[118px] pt-10 max-sm:px-4 max-sm:pb-28">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className={`${mono} mb-1 text-[#00d0c4]`}>Saved indexes</p>
          <h1 className="text-[clamp(28px,3vw,46px)] font-black uppercase leading-[0.95] text-[#f4f1ea]">
            Library
          </h1>
        </div>
        <div className="flex items-center gap-2 border border-white/15 bg-white/[0.025] px-3 py-2">
          <Search size={13} className="shrink-0 text-white/30" />
          <input
            className="bg-transparent font-mono text-[11px] uppercase tracking-[1px] text-[#f4f1ea] placeholder-white/20 outline-none"
            placeholder="Filter indexes..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
        </div>
      </div>

      {filtered.length === 0 && (
        <p className={`${mono} text-white/20`}>
          {filterQuery ? "No indexes match filter" : "No saved indexes"}
        </p>
      )}

      <div className="grid gap-px border border-white/10">
        {filtered.map((entry) => (
          <LibraryRow
            key={entry.index_path}
            entry={entry}
            isConfirmingDelete={confirmDelete === entry.index_path}
            onLoad={() => handleLoad(entry)}
            onRescan={() => handleRescan(entry)}
            onDeleteRequest={() => setConfirmDelete(entry.index_path)}
            onDeleteConfirm={() => handleDelete(entry)}
            onDeleteCancel={() => setConfirmDelete(null)}
          />
        ))}
      </div>
    </section>
  );
}

function LibraryRow({
  entry,
  isConfirmingDelete,
  onLoad,
  onRescan,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  entry: NativeIndexEntry;
  isConfirmingDelete: boolean;
  onLoad: () => void;
  onRescan: () => void;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  const label = entry.root_path ?? entry.index_path;
  const scannedAt = entry.last_scanned_at
    ? new Date(entry.last_scanned_at * 1000).toLocaleDateString()
    : "—";

  const iconBtn = "cursor-pointer grid h-8 w-8 place-items-center border border-white/15 text-[#9a9a94] transition-colors";

  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/7 bg-white/[0.02] px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-black text-[#f4f1ea]">{label}</p>
        <p className={`${mono} mt-0.5 text-[#9a9a94]`}>
          {formatBytes(entry.bytes_scanned)} · {formatCount(entry.files_scanned)} files · {scannedAt}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {isConfirmingDelete ? (
          <>
            <span className={`${mono} text-[#ff6b6b]`}>Delete?</span>
            <button
              className="cursor-pointer !text-xs border border-[#ff6b6b]/40 bg-[#ff6b6b]/10 px-3 py-1 font-mono text-[9px] font-black uppercase text-[#ff6b6b]"
              type="button"
              onClick={onDeleteConfirm}
            >
              Yes
            </button>
            <button
              className="cursor-pointer grid h-7 w-7 place-items-center border border-white/15 text-[#9a9a94] hover:text-white/60"
              type="button"
              onClick={onDeleteCancel}
              title="Cancel"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <>
            <button
              className={`${iconBtn} hover:border-[#00d0c4]/40 hover:text-[#00d0c4]`}
              type="button"
              onClick={onLoad}
              title="Load into workspace"
            >
              <FolderOpen size={13} />
            </button>
            {entry.root_path && (
              <button
                className={`${iconBtn} hover:border-white/30 hover:text-[#f4f1ea]`}
                type="button"
                onClick={onRescan}
                title="Rescan"
              >
                <RefreshCw size={13} />
              </button>
            )}
            <button
              className={`${iconBtn} hover:border-[#ff6b6b]/40 hover:text-[#ff6b6b]`}
              type="button"
              onClick={onDeleteRequest}
              title="Delete index"
            >
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
