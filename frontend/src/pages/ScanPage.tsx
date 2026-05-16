import { useParams, useNavigate } from "react-router-dom";
import { useScanContext } from "../context/ScanContext";
import { ScanList } from "../components/ScanList";
import { ScanDetail } from "../components/ScanDetail";

export function ScanPage() {
  const { id } = useParams<{ id?: string }>();
  const { queueItems } = useScanContext();
  const navigate = useNavigate();

  // If URL has an id but the item doesn't exist, redirect to /scan
  const itemExists = id ? queueItems.some((q) => q.id === id) : false;
  if (id && !itemExists && queueItems.length > 0) {
    navigate("/scan", { replace: true });
    return null;
  }

  return (
    <div className="flex min-h-screen pb-32">
      <ScanList selectedId={id} />

      {id && itemExists ? (
        <ScanDetail id={id} />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          {queueItems.length > 0 ? (
            <span className="font-mono text-[11px] uppercase text-white/20">
              Select a scan from the list to view details.
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
