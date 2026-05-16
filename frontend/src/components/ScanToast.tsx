import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { useScanContext } from "../context/ScanContext";
import type { QueueItem } from "../domain";

interface ToastData {
  id: string;
  name: string;
}

export function ScanToast() {
  const { queueItems, loadQueueItem } = useScanContext();
  const navigate = useNavigate();
  const [toast, setToast] = useState<ToastData | null>(null);
  const [loading, setLoading] = useState(false);
  const prevItemsRef = useRef<QueueItem[]>([]);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevItemsRef.current;
    prevItemsRef.current = queueItems;

    for (const item of queueItems) {
      if (item.status === "done") {
        const prevItem = prev.find((p) => p.id === item.id);
        if (prevItem?.status === "scanning") {
          setToast({ id: item.id, name: item.rootName });
          if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
          dismissTimerRef.current = setTimeout(() => setToast(null), 10000);
          break;
        }
      }
    }
  }, [queueItems]);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  if (!toast) return null;

  async function handleLoad() {
    if (!toast || loading) return;
    setLoading(true);
    try {
      await loadQueueItem(toast.id);
      navigate("/workspace");
      setToast(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed bottom-28 right-5 z-30 flex max-w-[320px] items-start gap-3 border border-[#b7ff5c]/25 bg-[#0d0f11] px-4 py-3 shadow-[0_8px_32px_rgba(0,0,0,0.6)]">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] uppercase tracking-[1.5px] text-[#b7ff5c]">Scan complete</p>
        <p className="mt-0.5 truncate text-[12px] font-black text-[#f4f1ea]">{toast.name}</p>
        <button
          className="mt-2 border border-[#b7ff5c]/30 bg-[#b7ff5c]/10 px-3 py-1 font-mono text-[9px] font-black uppercase tracking-[1px] text-[#b7ff5c] disabled:opacity-40"
          type="button"
          onClick={handleLoad}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load into workspace →"}
        </button>
      </div>
      <button
        className="shrink-0 text-white/20 hover:text-white/50"
        type="button"
        onClick={() => setToast(null)}
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  );
}
