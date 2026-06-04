import { useCallback, useEffect, useState } from "react";
import {
  fileProvenance,
  pinFile,
  unpinFile,
  overrideClassification,
  type NativeFileProvenance,
} from "../nativeClient";

const ROLE_OPTIONS = ["source", "derivative", "reference", "asset", "tool", "backup", "scratch", "system"];

export function FileProvenance({
  indexPath,
  fileId,
  onChanged,
}: {
  indexPath: string;
  fileId: number;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<NativeFileProvenance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      setData(await fileProvenance(indexPath, fileId));
    } catch (e) {
      setError(String(e));
    }
  }, [indexPath, fileId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const togglePin = useCallback(async () => {
    if (!data) return;
    setBusy(true);
    try {
      if (data.is_pinned) await unpinFile(indexPath, fileId);
      else await pinFile(indexPath, fileId);
      await reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [data, indexPath, fileId, reload, onChanged]);

  const setRole = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        await overrideClassification(indexPath, fileId, "role", value);
        await reload();
        onChanged?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [indexPath, fileId, reload, onChanged]
  );

  if (error) return <p className="text-11 text-red-400">Provenance error: {error}</p>;
  if (!data) return <p className="text-11 text-white/40">Loading provenance…</p>;

  return (
    <div className="grid gap-2 border-t border-white/10 pt-2 text-11">
      <div className="flex items-center justify-between">
        <span className="font-mono uppercase tracking-[1px] text-white/40">Why eligible</span>
        <button
          type="button"
          onClick={() => void togglePin()}
          disabled={busy}
          className="border border-white/20 px-2 py-0.5 font-mono uppercase text-white/70 disabled:opacity-40"
        >
          {data.is_pinned ? "Unpin" : "Pin to keep"}
        </button>
      </div>

      <div className="grid gap-1">
        {data.attrs.length === 0 && <span className="text-white/30">No classifications.</span>}
        {data.attrs.map((a, i) => (
          <div key={`${a.key}-${i}`} className="flex items-center gap-2">
            <span className="min-w-[110px] font-mono text-white/40">{a.key}</span>
            <span className="text-accent">{a.value}</span>
            <span className="text-white/30">
              · {a.source} · {(a.confidence * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>

      {data.relations.length > 0 && (
        <div className="grid gap-1">
          {data.relations.map((r, i) => (
            <div key={`${r.predicate}-${i}`} className="flex items-center gap-2">
              <span className="min-w-[110px] font-mono text-white/40">{r.predicate}</span>
              <span className="truncate text-white/70">{r.object_path ?? "(unknown)"}</span>
              <span className="text-white/30">· {r.source}</span>
            </div>
          ))}
        </div>
      )}

      <label className="flex items-center gap-2">
        <span className="font-mono text-white/40">Override role</span>
        <select
          className="border border-white/20 bg-transparent px-1 py-0.5 text-white/80"
          disabled={busy}
          value={data.attrs.find((a) => a.key === "role")?.value ?? ""}
          onChange={(e) => void setRole(e.target.value)}
        >
          <option value="" disabled>
            choose…
          </option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
