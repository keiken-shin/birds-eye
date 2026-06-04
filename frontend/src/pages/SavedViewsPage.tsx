import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useScanContext } from "../context/ScanContext";
import {
  listSavedViews,
  runSavedView,
  type NativeSavedView,
  type NativeSavedViewRow,
} from "../nativeClient";
import { formatBytes } from "../domain";

export function SavedViewsPage() {
  const { workspaceIndexPath, setRuntimeMessage } = useScanContext();
  const [views, setViews] = useState<NativeSavedView[]>([]);
  const [active, setActive] = useState<NativeSavedView | null>(null);
  const [rows, setRows] = useState<NativeSavedViewRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listSavedViews()
      .then(setViews)
      .catch((e) =>
        setRuntimeMessage(
          `Failed to load views: ${e instanceof Error ? e.message : String(e)}`
        )
      );
  }, [setRuntimeMessage]);

  const open = useCallback(
    async (view: NativeSavedView) => {
      if (!workspaceIndexPath) return;
      setActive(view);
      setBusy(true);
      try {
        setRows(await runSavedView(workspaceIndexPath, view.id, undefined));
      } catch (e) {
        setRuntimeMessage(
          `Failed to run view: ${e instanceof Error ? e.message : String(e)}`
        );
        setRows([]);
      } finally {
        setBusy(false);
      }
    },
    [workspaceIndexPath, setRuntimeMessage]
  );

  if (!workspaceIndexPath) {
    return (
      <section className="px-[42px] pb-[118px] pt-6">
        <p className="text-sm text-muted">
          No index loaded.{" "}
          <Link to="/library" className="text-primary underline">
            Open Library
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="relative z-[1] min-w-0 px-[42px] pb-[118px] pt-6 max-sm:px-4">
      <header className="mb-4 grid gap-2 border-t border-primary/20 pt-5">
        <p className="m-0 text-13 font-bold uppercase text-accent">Saved views / starter library</p>
        <h2 className="text-[clamp(24px,2.6vw,40px)] font-black uppercase leading-[0.95] text-primary">
          Curated lenses on your drive
        </h2>
      </header>

      <div className="grid gap-2 md:grid-cols-2">
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => void open(v)}
            className={`border px-4 py-3 text-left ${
              active?.id === v.id ? "border-accent" : "border-white/15"
            }`}
          >
            <span className="block text-13 font-bold text-white/90">{v.name}</span>
            <span className="block text-11 text-white/40">{v.description}</span>
            {v.protective && (
              <span className="mt-1 inline-block font-mono text-10 uppercase text-emerald-300">Protected</span>
            )}
          </button>
        ))}
      </div>

      {active && (
        <div className="mt-6">
          {active.protective && (
            <div className="mb-3 border border-emerald-400/40 bg-emerald-400/5 px-4 py-2 text-12 text-emerald-200">
              Protected — these are the only surviving copy and are never cleanup candidates.
            </div>
          )}
          <h3 className="mb-2 font-mono text-11 uppercase tracking-[1px] text-white/50">
            {active.name} · {busy ? "…" : rows.length}
          </h3>
          {!busy && rows.length === 0 ? (
            <p className="text-sm text-muted">No matching files.</p>
          ) : (
            <ul className="grid gap-1">
              {rows.map((r) => (
                <li
                  key={r.file_id}
                  className="flex items-center justify-between gap-3 border border-white/10 px-3 py-2"
                >
                  <span className="truncate text-12 text-white/80">{r.path}</span>
                  <span className="shrink-0 text-11 text-white/40">{formatBytes(r.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
