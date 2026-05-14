import React, { useEffect, useRef, useState } from "react";
import { Search, Settings, X } from "lucide-react";

interface TopNavigationProps {
  onSearch?: (query: string) => void;
}

export const TopNavigation: React.FC<TopNavigationProps> = ({ onSearch }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    onSearch?.(e.target.value);
  };

  return (
    <div className="absolute top-0 left-0 right-0 z-50 pointer-events-none">
      {/* Floating top bar */}
      <div className="flex items-center justify-between px-4 py-2 pointer-events-auto">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-indigo-400 tracking-widest uppercase select-none">
            Nexus
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/70 hover:bg-slate-700/80 border border-white/10 rounded-lg text-xs text-slate-400 transition-colors backdrop-blur-sm"
            aria-label="Open search (Ctrl+K)"
          >
            <Search size={12} />
            <span>Search files…</span>
            <kbd className="text-slate-600 font-mono">⌘K</kbd>
          </button>
          <button
            className="p-1.5 bg-slate-800/70 hover:bg-slate-700/80 border border-white/10 rounded-lg text-slate-400 transition-colors backdrop-blur-sm"
            aria-label="Settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Command palette overlay */}
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center pt-24 pointer-events-auto">
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="relative w-full max-w-xl mx-4 bg-slate-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-lg">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
              <Search size={16} className="text-indigo-400 flex-shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={handleChange}
                placeholder="Search files, folders, or fly to a path…"
                className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none"
              />
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded hover:bg-slate-700 text-slate-500 transition-colors"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            {query.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-slate-600 font-mono">
                TYPE TO SEARCH — ENTER TO FLY TO LOCATION
              </div>
            ) : (
              <div className="px-4 py-3 text-xs text-slate-500 font-mono">
                No results for <span className="text-indigo-400">"{query}"</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
