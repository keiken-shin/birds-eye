import { useEffect, useState } from "react";
import { allowPreviewRoot, previewSrc } from "@bridge/nativeClient";
import { useWorkspace } from "../state/workspaceStore";

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|ico|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a)$/i;

/**
 * Inline media preview for the Inspector. The asset protocol serves nothing by default;
 * we ask the backend to allow this index's scan root (it validates the index and derives
 * the root itself), then load via convertFileSrc. Anything that fails just renders nothing —
 * preview is a bonus, never an error state.
 */
export function FilePreview({ path }: { path: string }) {
  const { indexPath } = useWorkspace();
  const kind = IMAGE_EXT.test(path)
    ? "image"
    : VIDEO_EXT.test(path)
      ? "video"
      : AUDIO_EXT.test(path)
        ? "audio"
        : null;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setReady(false);
    setFailed(false);
    if (!kind || !indexPath) return;
    let alive = true;
    allowPreviewRoot(indexPath)
      .then(() => alive && setReady(true))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [indexPath, path, kind]);

  if (!kind || failed || !ready) return null;
  const src = previewSrc(path);

  return (
    <div className="mb-4 overflow-hidden rounded-[9px] border border-line bg-inset">
      {kind === "image" && (
        <img
          src={src}
          alt=""
          onError={() => setFailed(true)}
          className="max-h-[220px] w-full object-contain"
        />
      )}
      {kind === "video" && (
        <video
          src={src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          className="max-h-[220px] w-full"
        />
      )}
      {kind === "audio" && (
        <audio src={src} controls onError={() => setFailed(true)} className="w-full" />
      )}
    </div>
  );
}
