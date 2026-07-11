import {
  Archive,
  Box,
  Code2,
  FileText,
  File,
  Film,
  Image,
  Music,
  Package,
  type LucideIcon,
} from "lucide-react";

/**
 * The backend's media-kind taxonomy (src/index/writer.rs) with its display
 * identity: label, fixed category color (see index.css @theme — the palette is
 * CVD-validated as a set), and icon. Color follows the kind, never its rank.
 */
export type MediaKind =
  | "photo"
  | "video"
  | "music"
  | "archive"
  | "document"
  | "code"
  | "installer"
  | "model"
  | "other";

export type CategoryInfo = {
  kind: MediaKind;
  label: string;
  /** CSS var reference — usable in inline styles and SVG fills alike. */
  color: string;
  icon: LucideIcon;
};

export const CATEGORIES: Record<MediaKind, CategoryInfo> = {
  video: { kind: "video", label: "Videos", color: "var(--color-cat-video)", icon: Film },
  photo: { kind: "photo", label: "Photos", color: "var(--color-cat-photo)", icon: Image },
  music: { kind: "music", label: "Music", color: "var(--color-cat-music)", icon: Music },
  document: { kind: "document", label: "Documents", color: "var(--color-cat-document)", icon: FileText },
  code: { kind: "code", label: "Code", color: "var(--color-cat-code)", icon: Code2 },
  archive: { kind: "archive", label: "Archives", color: "var(--color-cat-archive)", icon: Archive },
  installer: { kind: "installer", label: "Installers", color: "var(--color-cat-installer)", icon: Package },
  model: { kind: "model", label: "Models", color: "var(--color-cat-model)", icon: Box },
  other: { kind: "other", label: "Other", color: "var(--color-cat-other)", icon: File },
};

/** Display order for legends and chips (by typical prominence; Other always last). */
export const CATEGORY_ORDER: MediaKind[] = [
  "video",
  "photo",
  "music",
  "document",
  "code",
  "archive",
  "installer",
  "model",
  "other",
];

export function categoryOf(kind: string | null | undefined): CategoryInfo {
  return CATEGORIES[(kind ?? "other") as MediaKind] ?? CATEGORIES.other;
}
