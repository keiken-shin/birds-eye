import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useSearch } from "../hooks/useSearch";
import { formatBytes, type CategoryKey, type ScanState, type SearchFilters } from "../domain";
import { categories } from "../domain";

const mono = "font-mono text-[11px] uppercase";
const ALL_KINDS = Object.keys(categories) as CategoryKey[];

type SizeUnit = "KB" | "MB" | "GB";
function toBytes(value: string, unit: SizeUnit): number | undefined {
  const n = parseFloat(value);
  if (Number.isNaN(n) || n < 0) return undefined;
  const multipliers: Record<SizeUnit, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  return Math.round(n * multipliers[unit]);
}

export function CommandPalette({
  currentIndexPath,
  nativeRuntime,
  scan,
}: {
  currentIndexPath: string;
  nativeRuntime: boolean;
  scan: ScanState;
}) {
  const [open, setOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [selectedKinds, setSelectedKinds] = useState<CategoryKey[]>([]);
  const [extInput, setExtInput] = useState("");
  const [minSizeVal, setMinSizeVal] = useState("");
  const [minSizeUnit, setMinSizeUnit] = useState<SizeUnit>("MB");
  const [maxSizeVal, setMaxSizeVal] = useState("");
  const [maxSizeUnit, setMaxSizeUnit] = useState<SizeUnit>("GB");
  const [useRegex, setUseRegex] = useState(false);
  const [regexError, setRegexError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filters: SearchFilters = {
    kinds: selectedKinds.length > 0 ? selectedKinds : undefined,
    extensions: extInput.trim()
      ? extInput
          .trim()
          .split(/\s+/)
          .map((e) => e.replace(/^\./, ""))
      : undefined,
    minBytes: toBytes(minSizeVal, minSizeUnit),
    maxBytes: toBytes(maxSizeVal, maxSizeUnit),
    useRegex: useRegex || undefined,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { searchQuery, setSearchQuery, searchResults } = useSearch({
    currentIndexPath,
    nativeRuntime,
    largestFiles: scan.largestFiles,
    setRuntimeMessage: () => {},
    ...(filters as any),
    filters,
  } as any);

  const close = useCallback(() => {
    setOpen(false);
    setFiltersOpen(false);
    setSelectedKinds([]);
    setExtInput("");
    setMinSizeVal("");
    setMaxSizeVal("");
    setUseRegex(false);
    setRegexError(null);
    setSearchQuery("");
    setFocusedIndex(0);
  }, [setSearchQuery]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "k" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (!open) return;
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, searchResults.length - 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, close, searchResults.length]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setFocusedIndex(0);
  }, [searchResults.length]);

  useEffect(() => {
    if (!useRegex || !searchQuery) {
      setRegexError(null);
      return;
    }
    try {
      new RegExp(searchQuery);
      setRegexError(null);
    } catch {
      setRegexError("Invalid regex pattern");
    }
  }, [useRegex, searchQuery]);

  function toggleKind(kind: CategoryKey) {
    setSelectedKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]
    );
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      style={{ background: "rgba(5,6,7,0.75)", backdropFilter: "blur(4px)" }}
      onClick={(e) => e.target === e.currentTarget && close()}
      role="dialog"
      aria-label="File search"
    >
      <div className="w-full max-w-[600px] border border-white/15 bg-[#07090d] shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
        {/* Search input row */}
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Search size={14} className="shrink-0 text-white/30" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent font-mono text-[13px] text-[#f4f1ea] placeholder-white/20 outline-none"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            className={`${mono} border px-2 py-1 ${
              filtersOpen ? "border-[#00d0c4]/40 text-[#00d0c4]" : "border-white/10 text-white/30"
            }`}
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            Filters
          </button>
          <button
            className="grid h-6 w-6 place-items-center text-white/30 hover:text-white/60"
            type="button"
            onClick={close}
          >
            <X size={14} />
          </button>
        </div>

        {/* Filters row */}
        {filtersOpen && (
          <div className="border-b border-white/10 px-4 py-3 space-y-3">
            {/* Kind pills */}
            <div className="flex flex-wrap gap-1.5">
              {ALL_KINDS.map((kind) => (
                <button
                  key={kind}
                  className={`${mono} border px-2 py-0.5 ${
                    selectedKinds.includes(kind)
                      ? "border-[#00d0c4]/50 bg-[#00d0c4]/10 text-[#00d0c4]"
                      : "border-white/10 text-white/30 hover:border-white/25"
                  }`}
                  type="button"
                  onClick={() => toggleKind(kind)}
                >
                  {kind}
                </button>
              ))}
            </div>
            {/* Extension + size */}
            <div className="flex flex-wrap gap-3">
              <input
                className="w-40 border border-white/10 bg-transparent px-2 py-1 font-mono text-[10px] text-[#f4f1ea] placeholder-white/20 outline-none"
                placeholder=".tsx .rs .pdf"
                value={extInput}
                onChange={(e) => setExtInput(e.target.value)}
              />
              <div className="flex items-center gap-1">
                <input
                  className="w-16 border border-white/10 bg-transparent px-2 py-1 font-mono text-[10px] text-[#f4f1ea] placeholder-white/20 outline-none"
                  placeholder="min"
                  value={minSizeVal}
                  onChange={(e) => setMinSizeVal(e.target.value)}
                />
                <SizeUnitSelect value={minSizeUnit} onChange={setMinSizeUnit} />
                <span className={`${mono} text-white/20`}>→</span>
                <input
                  className="w-16 border border-white/10 bg-transparent px-2 py-1 font-mono text-[10px] text-[#f4f1ea] placeholder-white/20 outline-none"
                  placeholder="max"
                  value={maxSizeVal}
                  onChange={(e) => setMaxSizeVal(e.target.value)}
                />
                <SizeUnitSelect value={maxSizeUnit} onChange={setMaxSizeUnit} />
              </div>
              <button
                className={`${mono} border px-2 py-1 ${
                  useRegex
                    ? "border-[#b7ff5c]/40 bg-[#b7ff5c]/10 text-[#b7ff5c]"
                    : "border-white/10 text-white/30"
                }`}
                type="button"
                onClick={() => setUseRegex((v) => !v)}
              >
                [.*] Regex
              </button>
            </div>
            {regexError && (
              <p className={`${mono} text-[#ff6b6b]`}>{regexError}</p>
            )}
          </div>
        )}

        {/* Results */}
        <div className="max-h-[360px] overflow-y-auto">
          {searchQuery.length >= 2 && searchResults.length === 0 && !regexError && (
            <div className="px-4 py-5 text-center">
              <span className={`${mono} text-white/20`}>No results</span>
            </div>
          )}
          {searchResults.map((result, i) => (
            <div
              key={result.path}
              className={`flex items-center justify-between border-b border-white/5 px-4 py-2.5 ${
                i === focusedIndex ? "bg-white/[0.04]" : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-bold text-[#f4f1ea]">{result.path}</p>
                <p className={`${mono} text-[#9a9a94]`}>{formatBytes(result.size)}</p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <ResultAction label="Preview" path={result.path} action="preview" />
                <ResultAction label="Reveal" path={result.path} action="reveal" />
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-white/7 px-4 py-2">
          <span className={`${mono} text-white/15`}>
            ↑↓ navigate · Enter preview · Esc close
          </span>
        </div>
      </div>
    </div>
  );
}

function SizeUnitSelect({
  value,
  onChange,
}: {
  value: SizeUnit;
  onChange: (v: SizeUnit) => void;
}) {
  return (
    <select
      className="border border-white/10 bg-[#07090d] px-1 py-1 font-mono text-[10px] text-[#9a9a94] outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value as SizeUnit)}
    >
      <option>KB</option>
      <option>MB</option>
      <option>GB</option>
    </select>
  );
}

function ResultAction({
  label,
  path,
  action,
}: {
  label: string;
  path: string;
  action: "preview" | "reveal";
}) {
  async function handleClick() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (action === "preview") {
        await invoke("plugin:opener|open_path", { path });
      } else {
        const folder =
          path.substring(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1) || path;
        await invoke("plugin:opener|reveal_item_in_dir", { path: folder });
      }
    } catch {
      // Degrades silently in browser mode or before opener plugin is installed
    }
  }

  return (
    <button
      className="border border-white/10 px-2 py-0.5 font-mono text-[9px] font-black uppercase text-white/30 hover:border-white/25 hover:text-white/60"
      type="button"
      onClick={handleClick}
    >
      {label}
    </button>
  );
}
