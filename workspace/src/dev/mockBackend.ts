/**
 * Browser dev-mode backend: implements the same Tauri command surface the app
 * invokes, over a deterministic in-memory fixture dataset — so the whole
 * workspace renders (and can be designed/tested) in plain `vite` without the
 * Rust shell. nativeClient routes here whenever `isTauri()` is false; Tauri
 * builds never touch this module at runtime.
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

const ROOT = "C:\\Users\\alex";
const MAIN_INDEX = "mock://indexes/alex.sqlite";
const MEDIA_INDEX = "mock://indexes/media.sqlite";

const j = (...segs: string[]) => [ROOT, ...segs].join("\\");

/* ------------------------------------------------------------------ */
/* Folders (recursive total_bytes, like the real writer rollups)       */
/* ------------------------------------------------------------------ */

type FolderFix = { path: string; total_files: number; total_bytes: number };

const F = (path: string, gb: number, files: number): FolderFix => ({
  path,
  total_files: files,
  total_bytes: Math.round(gb * GB),
});

const FOLDERS: FolderFix[] = [
  F(ROOT, 552.4, 391_208),
  F(j("Videos"), 142.6, 4_182),
  F(j("Videos", "Movies"), 44.8, 214),
  F(j("Videos", "Family"), 48.2, 1_260),
  F(j("Videos", "Screen Recordings"), 35.4, 2_301),
  F(j("Videos", "Exports"), 14.2, 407),
  F(j("Photos"), 96.3, 84_907),
  F(j("Photos", "2024"), 22.1, 18_204),
  F(j("Photos", "2023"), 19.8, 16_931),
  F(j("Photos", "2022"), 14.6, 12_270),
  F(j("Photos", "2021"), 11.2, 9_804),
  F(j("Photos", "Older"), 10.4, 15_610),
  F(j("Photos", "Lightroom"), 18.2, 12_088),
  F(j("Photos", "Lightroom", "Previews"), 9.4, 9_120),
  F(j("Projects"), 88.4, 148_612),
  F(j("Projects", "forge"), 28.3, 36_240),
  F(j("Projects", "forge", "target"), 16.4, 22_180),
  F(j("Projects", "forge", "src"), 0.8, 2_410),
  F(j("Projects", "webshop"), 20.6, 68_450),
  F(j("Projects", "webshop", "node_modules"), 12.3, 61_204),
  F(j("Projects", "ml-lab"), 34.2, 8_170),
  F(j("Projects", "ml-lab", "checkpoints"), 26.8, 84),
  F(j("Downloads"), 52.7, 3_904),
  F(j("Downloads", "Installers"), 18.4, 96),
  F(j("Backups"), 74.9, 96_208),
  F(j("Backups", "OldLaptop"), 44.6, 71_890),
  F(j("Backups", "PhoneSync"), 22.4, 21_650),
  F(j("Music"), 24.3, 6_412),
  F(j("Documents"), 12.1, 24_305),
  F(j("VMs"), 38.6, 22),
  F(j("AppData"), 26.4, 31_240),
  F(j("AppData", "Cache"), 14.2, 26_180),
  F(j("AppData", "Temp"), 5.8, 3_904),
];

/* ------------------------------------------------------------------ */
/* Files (largest-first, like query_index.files)                       */
/* ------------------------------------------------------------------ */

type FileFix = {
  path: string;
  size: number;
  extension: string | null;
  media_kind: string;
  modified_at: number | null;
};

const file = (
  path: string,
  sizeGb: number,
  ext: string | null,
  kind: string,
  ageDays: number
): FileFix => ({
  path,
  size: Math.round(sizeGb * GB),
  extension: ext,
  media_kind: kind,
  modified_at: NOW - Math.round(ageDays * DAY),
});

const FILES: FileFix[] = [
  file(j("VMs", "win11-dev.vdi"), 22.4, "vdi", "other", 148),
  file(j("VMs", "ubuntu-lab.qcow2"), 12.8, "qcow2", "other", 411),
  file(j("Projects", "ml-lab", "checkpoints", "sdxl-base.safetensors"), 6.9, "safetensors", "model", 96),
  file(j("Projects", "ml-lab", "checkpoints", "llama-13b.gguf"), 6.4, "gguf", "model", 61),
  file(j("Videos", "Movies", "family-wedding-master.mov"), 5.8, "mov", "video", 730),
  file(j("Projects", "ml-lab", "checkpoints", "finetune-v3.ckpt"), 5.2, "ckpt", "model", 44),
  file(j("Videos", "Movies", "holiday-2019-4k.mkv"), 4.6, "mkv", "video", 1130),
  file(j("Backups", "OldLaptop", "system-image.vhdx"), 4.4, "vhdx", "other", 660),
  file(j("Videos", "Family", "graduation-uncut.mp4"), 4.1, "mp4", "video", 388),
  file(j("Downloads", "Installers", "win11-setup.iso"), 3.9, "iso", "other", 512),
  file(j("Videos", "Screen Recordings", "workshop-recording-full.mkv"), 3.4, "mkv", "video", 204),
  file(j("Videos", "Movies", "concert-2022.mp4"), 3.1, "mp4", "video", 799),
  file(j("Backups", "phone-backup-2023.zip"), 2.9, "zip", "archive", 468),
  file(j("Videos", "Exports", "yt-final-v12.mp4"), 2.7, "mp4", "video", 96),
  file(j("Downloads", "dataset-imagenet-subset.tar"), 2.6, "tar", "archive", 388),
  file(j("Videos", "Family", "beach-day-2023.mp4"), 2.4, "mp4", "video", 340),
  file(j("Downloads", "Installers", "adobe-cc-installer.exe"), 2.2, "exe", "installer", 460),
  file(j("Backups", "OldLaptop", "docs-archive.7z"), 2.1, "7z", "archive", 660),
  file(j("Videos", "Exports", "yt-final-v11.mp4"), 2.0, "mp4", "video", 118),
  file(j("Videos", "Screen Recordings", "standup-recordings-q1.mkv"), 1.9, "mkv", "video", 246),
  file(j("Music", "flac-rips", "discography-lossless.zip"), 1.8, "zip", "archive", 590),
  file(j("Projects", "forge", "target", "release-build.tar.gz"), 1.6, "gz", "archive", 88),
  file(j("Downloads", "conference-talks-2024.zip"), 1.5, "zip", "archive", 214),
  file(j("Photos", "Lightroom", "catalog-backup-2024.lrcat"), 1.4, "lrcat", "other", 122),
  file(j("Downloads", "Installers", "visual-studio-bootstrap.exe"), 1.2, "exe", "installer", 380),
  file(j("Photos", "2024", "iceland-raw-batch.zip"), 1.1, "zip", "archive", 158),
  file(j("Videos", "Family", "kids-first-steps.mov"), 1.05, "mov", "video", 1460),
  file(j("Backups", "PhoneSync", "whatsapp-media-export.zip"), 0.98, "zip", "archive", 289),
  file(j("Downloads", "linux-distro-live.iso"), 0.92, "iso", "other", 610),
  file(j("Photos", "2023", "safari-trip-raw.7z"), 0.88, "7z", "archive", 410),
  file(j("Documents", "scans", "tax-archive-2019-2023.pdf"), 0.42, "pdf", "document", 220),
  file(j("Music", "live-sets", "festival-set-2023.flac"), 0.38, "flac", "music", 505),
  file(j("Projects", "webshop", "node_modules", ".cache", "webpack-bundle.pack"), 0.34, "pack", "other", 12),
  file(j("Photos", "2024", "drone-footage-stills.heic"), 0.31, "heic", "photo", 82),
  file(j("Documents", "presentations", "keynote-master.pptx"), 0.22, "pptx", "other", 46),
  file(j("Music", "albums", "road-trip-mix.mp3"), 0.18, "mp3", "music", 330),
];

/* ------------------------------------------------------------------ */
/* Extensions / media / folder_media                                   */
/* ------------------------------------------------------------------ */

const ext = (extension: string, count: number, gb: number) => ({
  extension,
  file_count: count,
  total_bytes: Math.round(gb * GB),
});

const EXTENSIONS = [
  ext("mp4", 2_841, 68.4),
  ext("mkv", 402, 38.2),
  ext("jpg", 61_240, 41.6),
  ext("mov", 188, 24.8),
  ext("zip", 1_204, 22.4),
  ext("vdi", 2, 22.4),
  ext("raw", 8_420, 19.8),
  ext("safetensors", 14, 15.2),
  ext("qcow2", 3, 14.1),
  ext("7z", 96, 11.8),
  ext("gguf", 6, 10.4),
  ext("png", 24_180, 9.6),
  ext("iso", 7, 8.9),
  ext("ckpt", 11, 8.2),
  ext("exe", 84, 7.4),
  ext("heic", 9_301, 6.8),
  ext("tar", 41, 5.9),
  ext("flac", 1_420, 5.4),
  ext("mp3", 4_806, 4.8),
  ext("gz", 388, 4.2),
  ext("pdf", 6_204, 3.1),
  ext("docx", 4_180, 1.2),
  ext("js", 48_204, 1.1),
  ext("ts", 22_180, 0.6),
];

const media = (kind: string, count: number, gb: number) => ({
  media_kind: kind,
  file_count: count,
  total_bytes: Math.round(gb * GB),
});

const MEDIA = [
  media("video", 3_612, 138.2),
  media("photo", 96_204, 88.4),
  media("archive", 2_180, 62.8),
  media("other", 12_400, 96.2),
  media("model", 31, 33.8),
  media("code", 182_408, 48.6),
  media("music", 6_412, 22.4),
  media("document", 18_204, 10.8),
  media("installer", 96, 18.6),
];

const FOLDER_MEDIA = FOLDERS.filter((f) => f.path !== ROOT).flatMap((f) => {
  const name = f.path.split("\\").pop()!.toLowerCase();
  const kinds: Array<[string, number]> = name.includes("video") || name.includes("movies") || name.includes("recordings") || name.includes("exports") || name.includes("family")
    ? [["video", 0.86], ["other", 0.14]]
    : name.includes("photo") || /^\d{4}$/.test(name) || name.includes("older") || name.includes("lightroom") || name.includes("previews")
      ? [["photo", 0.9], ["other", 0.1]]
      : name.includes("music")
        ? [["music", 0.84], ["archive", 0.16]]
        : name.includes("backup") || name.includes("oldlaptop") || name.includes("phonesync")
          ? [["archive", 0.5], ["photo", 0.3], ["other", 0.2]]
          : name.includes("node_modules") || name.includes("src") || name.includes("webshop") || name.includes("forge")
            ? [["code", 0.7], ["other", 0.3]]
            : name.includes("ml-lab") || name.includes("checkpoints")
              ? [["model", 0.78], ["code", 0.22]]
              : name.includes("documents")
                ? [["document", 0.82], ["other", 0.18]]
                : name.includes("installers")
                  ? [["installer", 0.76], ["other", 0.24]]
                  : name.includes("downloads")
                    ? [["archive", 0.4], ["installer", 0.3], ["other", 0.3]]
                    : [["other", 1]];
  return kinds.map(([kind, frac]) => ({
    folder_path: f.path,
    media_kind: kind,
    total_bytes: Math.round(f.total_bytes * (frac as number)),
  }));
});

/* ------------------------------------------------------------------ */
/* Timeline + age buckets                                              */
/* ------------------------------------------------------------------ */

// Deterministic monthly series, oldest → newest (24 months).
const TIMELINE_SHAPE = [
  4.2, 3.1, 5.8, 2.4, 3.9, 6.2, 8.4, 4.1, 2.8, 5.2, 7.1, 3.4,
  4.8, 9.2, 6.4, 3.1, 2.2, 4.4, 11.8, 7.2, 5.1, 8.8, 6.1, 4.4,
];

function monthLabel(offsetFromNow: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - offsetFromNow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const TIMELINE = TIMELINE_SHAPE.map((gb, i) => ({
  bucket: monthLabel(TIMELINE_SHAPE.length - 1 - i),
  file_count: Math.round(gb * 1_840),
  total_bytes: Math.round(gb * GB),
}));

const AGE_BUCKETS = [
  { bucket: "lt1mo", file_count: 9_408, total_bytes: Math.round(31.2 * GB) },
  { bucket: "1to3mo", file_count: 22_610, total_bytes: Math.round(58.4 * GB) },
  { bucket: "3to6mo", file_count: 36_204, total_bytes: Math.round(84.2 * GB) },
  { bucket: "6to12mo", file_count: 58_419, total_bytes: Math.round(129.8 * GB) },
  { bucket: "1to2yr", file_count: 48_206, total_bytes: Math.round(118.4 * GB) },
  { bucket: "gt2yr", file_count: 61_208, total_bytes: Math.round(130.4 * GB) },
];

/* ------------------------------------------------------------------ */
/* Duplicates                                                          */
/* ------------------------------------------------------------------ */

type DupFileFix = { path: string; size: number; modified_at: number; hash_state: 0 | 2 | 4 };

const DUP_GROUPS: Array<{
  id: number;
  size: number;
  file_count: number;
  reclaimable_bytes: number;
  confidence: number;
  files: DupFileFix[];
}> = [
  {
    id: 1,
    size: Math.round(4.1 * GB),
    file_count: 2,
    reclaimable_bytes: Math.round(4.1 * GB),
    confidence: 1,
    files: [
      { path: j("Videos", "Family", "graduation-uncut.mp4"), size: Math.round(4.1 * GB), modified_at: NOW - 388 * DAY, hash_state: 4 },
      { path: j("Backups", "OldLaptop", "Videos", "graduation-uncut.mp4"), size: Math.round(4.1 * GB), modified_at: NOW - 660 * DAY, hash_state: 4 },
    ],
  },
  {
    id: 2,
    size: Math.round(2.7 * GB),
    file_count: 3,
    reclaimable_bytes: Math.round(5.4 * GB),
    confidence: 1,
    files: [
      { path: j("Videos", "Exports", "yt-final-v12.mp4"), size: Math.round(2.7 * GB), modified_at: NOW - 96 * DAY, hash_state: 4 },
      { path: j("Downloads", "yt-final-v12.mp4"), size: Math.round(2.7 * GB), modified_at: NOW - 94 * DAY, hash_state: 4 },
      { path: j("Downloads", "yt-final-v12 (1).mp4"), size: Math.round(2.7 * GB), modified_at: NOW - 91 * DAY, hash_state: 4 },
    ],
  },
  {
    id: 3,
    size: Math.round(1.4 * GB),
    file_count: 2,
    reclaimable_bytes: Math.round(1.4 * GB),
    confidence: 0.92,
    files: [
      { path: j("Photos", "2023", "safari-trip-raw.7z"), size: Math.round(1.4 * GB), modified_at: NOW - 410 * DAY, hash_state: 2 },
      { path: j("Backups", "PhoneSync", "safari-trip-raw.7z"), size: Math.round(1.4 * GB), modified_at: NOW - 289 * DAY, hash_state: 2 },
    ],
  },
  {
    id: 4,
    size: Math.round(0.96 * GB),
    file_count: 2,
    reclaimable_bytes: Math.round(0.96 * GB),
    confidence: 1,
    files: [
      { path: j("Downloads", "linux-distro-live.iso"), size: Math.round(0.92 * GB), modified_at: NOW - 610 * DAY, hash_state: 4 },
      { path: j("Downloads", "Installers", "linux-distro-live (1).iso"), size: Math.round(0.92 * GB), modified_at: NOW - 604 * DAY, hash_state: 4 },
    ],
  },
  {
    id: 5,
    size: Math.round(0.64 * GB),
    file_count: 4,
    reclaimable_bytes: Math.round(1.92 * GB),
    confidence: 0.86,
    files: [
      { path: j("Photos", "2024", "iceland-pano-08421.raw"), size: Math.round(0.64 * GB), modified_at: NOW - 158 * DAY, hash_state: 2 },
      { path: j("Photos", "2024", "iceland-pano-08421 - Copy.raw"), size: Math.round(0.64 * GB), modified_at: NOW - 158 * DAY, hash_state: 2 },
      { path: j("Photos", "Lightroom", "imports", "iceland-pano-08421.raw"), size: Math.round(0.64 * GB), modified_at: NOW - 151 * DAY, hash_state: 2 },
      { path: j("Backups", "OldLaptop", "Photos", "iceland-pano-08421.raw"), size: Math.round(0.64 * GB), modified_at: NOW - 660 * DAY, hash_state: 0 },
    ],
  },
  {
    id: 6,
    size: Math.round(0.44 * GB),
    file_count: 2,
    reclaimable_bytes: Math.round(0.44 * GB),
    confidence: 1,
    files: [
      { path: j("Music", "flac-rips", "album-2019-remaster.flac"), size: Math.round(0.44 * GB), modified_at: NOW - 590 * DAY, hash_state: 4 },
      { path: j("Backups", "OldLaptop", "Music", "album-2019-remaster.flac"), size: Math.round(0.44 * GB), modified_at: NOW - 660 * DAY, hash_state: 4 },
    ],
  },
  {
    id: 7,
    size: 320 * MB,
    file_count: 3,
    reclaimable_bytes: 640 * MB,
    confidence: 0.78,
    files: [
      { path: j("Documents", "scans", "passport-scan-hires.pdf"), size: 320 * MB, modified_at: NOW - 220 * DAY, hash_state: 2 },
      { path: j("Documents", "passport-scan-hires (1).pdf"), size: 320 * MB, modified_at: NOW - 218 * DAY, hash_state: 2 },
      { path: j("Downloads", "passport-scan-hires.pdf"), size: 320 * MB, modified_at: NOW - 224 * DAY, hash_state: 0 },
    ],
  },
  {
    id: 8,
    size: 180 * MB,
    file_count: 2,
    reclaimable_bytes: 180 * MB,
    confidence: 1,
    files: [
      { path: j("Projects", "webshop", "node_modules", "lodash", "lodash.min.js"), size: 180 * MB, modified_at: NOW - 12 * DAY, hash_state: 4 },
      { path: j("Projects", "forge", "vendor", "lodash.min.js"), size: 180 * MB, modified_at: NOW - 88 * DAY, hash_state: 4 },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Treemap lens rows (verdict source)                                  */
/* ------------------------------------------------------------------ */

type LensFix = {
  folder_path: string;
  role: string | null;
  replaceability: string | null;
  lifecycle: string | null;
  cleanup_reason: string | null;
  reclaimable_bytes: number;
};

const lens = (
  path: string,
  role: string | null,
  replaceability: string | null,
  lifecycle: string | null,
  reason: string | null,
  reclaimGb: number
): LensFix => ({
  folder_path: path,
  role,
  replaceability,
  lifecycle,
  cleanup_reason: reason,
  reclaimable_bytes: Math.round(reclaimGb * GB),
});

const LENS: LensFix[] = [
  lens(ROOT, null, null, null, null, 148.9),
  lens(j("Videos"), null, null, null, null, 26.9),
  lens(j("Videos", "Movies"), null, null, null, null, 12.7),
  lens(j("Videos", "Exports"), "derivative", "regenerable", null, null, 14.2),
  lens(j("Videos", "Family"), "asset", "irreplaceable", null, null, 0),
  lens(j("Videos", "Screen Recordings"), null, null, null, null, 0),
  lens(j("Photos"), null, null, null, null, 9.4),
  lens(j("Photos", "2024"), "asset", "irreplaceable", null, null, 0),
  lens(j("Photos", "2023"), "asset", "irreplaceable", null, null, 0),
  lens(j("Photos", "2022"), "asset", "irreplaceable", null, null, 0),
  lens(j("Photos", "2021"), "asset", "irreplaceable", null, null, 0),
  lens(j("Photos", "Older"), null, null, null, null, 0),
  lens(j("Photos", "Lightroom"), null, null, null, null, 9.4),
  lens(j("Photos", "Lightroom", "Previews"), "derivative", "regenerable", null, "safe-derivative", 9.4),
  lens(j("Projects"), null, null, null, null, 28.7),
  lens(j("Projects", "forge"), null, null, "active", null, 16.4),
  lens(j("Projects", "forge", "src"), "source", "irreplaceable", "active", null, 0),
  lens(j("Projects", "forge", "target"), "derivative", "regenerable", null, "safe-derivative", 16.4),
  lens(j("Projects", "webshop"), null, null, "finished", "finished-project-cruft", 12.3),
  lens(j("Projects", "webshop", "node_modules"), "scratch", "regenerable", null, "scratch", 12.3),
  lens(j("Projects", "ml-lab"), null, null, null, null, 0),
  lens(j("Projects", "ml-lab", "checkpoints"), null, "regenerable", null, null, 0),
  lens(j("Downloads"), null, null, null, null, 15.6),
  lens(j("Downloads", "Installers"), null, "regenerable", null, "scratch", 15.6),
  lens(j("Backups"), null, null, null, null, 48.2),
  lens(j("Backups", "OldLaptop"), "backup", "regenerable", null, "redundant-backup", 41.2),
  lens(j("Backups", "PhoneSync"), "backup", null, null, null, 7.0),
  lens(j("Music"), "asset", null, null, null, 0),
  lens(j("Documents"), "source", "irreplaceable", null, null, 0),
  lens(j("VMs"), null, null, null, null, 12.8),
  lens(j("AppData"), null, null, null, null, 20.0),
  lens(j("AppData", "Cache"), "scratch", "regenerable", null, "scratch", 14.2),
  lens(j("AppData", "Temp"), "scratch", "regenerable", null, "scratch", 5.8),
];

/* ------------------------------------------------------------------ */
/* Discoveries / ontology                                              */
/* ------------------------------------------------------------------ */

type DiscoveryFix = {
  id: number;
  kind: string;
  payload: string;
  status: "Pending" | "Confirmed" | "Rejected" | "Expired";
  confidence: number;
  potential_bytes_unlocked: number;
  created_at: number;
  resolved_at: number | null;
};

let DISCOVERIES: DiscoveryFix[] = [
  {
    id: 1,
    kind: "backupOf-pair",
    payload: JSON.stringify({ backup_path: j("Backups", "OldLaptop", "Photos"), origin_path: j("Photos") }),
    status: "Pending",
    confidence: 0.84,
    potential_bytes_unlocked: Math.round(18.2 * GB),
    created_at: NOW - 2 * DAY,
    resolved_at: null,
  },
  {
    id: 2,
    kind: "backupOf-pair",
    payload: JSON.stringify({ backup_path: j("Backups", "PhoneSync", "Camera"), origin_path: j("Photos", "2023") }),
    status: "Pending",
    confidence: 0.77,
    potential_bytes_unlocked: Math.round(8.8 * GB),
    created_at: NOW - 2 * DAY,
    resolved_at: null,
  },
  {
    id: 3,
    kind: "derivedFrom-pattern",
    payload: JSON.stringify({ derivative_path: j("Photos", "Lightroom", "Previews"), source_path: j("Photos") }),
    status: "Pending",
    confidence: 0.92,
    potential_bytes_unlocked: Math.round(9.4 * GB),
    created_at: NOW - 2 * DAY,
    resolved_at: null,
  },
  {
    id: 4,
    kind: "derivedFrom-pattern",
    payload: JSON.stringify({ derivative_path: j("Videos", "Exports"), source_path: j("Videos", "Family") }),
    status: "Pending",
    confidence: 0.81,
    potential_bytes_unlocked: Math.round(10.1 * GB),
    created_at: NOW - DAY,
    resolved_at: null,
  },
  {
    id: 5,
    kind: "derivedFrom-pattern",
    payload: JSON.stringify({ derivative_path: j("Projects", "forge", "target"), source_path: j("Projects", "forge", "src") }),
    status: "Pending",
    confidence: 0.95,
    potential_bytes_unlocked: Math.round(16.4 * GB),
    created_at: NOW - DAY,
    resolved_at: null,
  },
  {
    id: 6,
    kind: "backupOf-pair",
    payload: JSON.stringify({ backup_path: j("Backups", "phone-backup-2023.zip"), origin_path: j("Backups", "PhoneSync") }),
    status: "Pending",
    confidence: 0.66,
    potential_bytes_unlocked: Math.round(2.9 * GB),
    created_at: NOW - DAY,
    resolved_at: null,
  },
];

let ontologyEnabled = true;

/* ------------------------------------------------------------------ */
/* Cleanup log                                                         */
/* ------------------------------------------------------------------ */

type CleanupLogFix = {
  id: number;
  cleanup_plan_id: number;
  file_id: number;
  original_path: string;
  size: number;
  cleaned_at: number;
  reason: string;
  restore_status: "pending" | "in_recycle_bin" | "restored" | "expired";
  expires_at: number | null;
};

let CLEANUP_LOG: CleanupLogFix[] = [
  {
    id: 1,
    cleanup_plan_id: 1,
    file_id: 9001,
    original_path: j("AppData", "Temp", "installer-scratch-2024.tmp"),
    size: Math.round(1.8 * GB),
    cleaned_at: NOW - 6 * DAY,
    reason: "scratch",
    restore_status: "in_recycle_bin",
    expires_at: NOW + 24 * DAY,
  },
  {
    id: 2,
    cleanup_plan_id: 1,
    file_id: 9002,
    original_path: j("Projects", "webshop", "node_modules", ".cache"),
    size: Math.round(2.3 * GB),
    cleaned_at: NOW - 6 * DAY,
    reason: "safe-derivative",
    restore_status: "in_recycle_bin",
    expires_at: NOW + 24 * DAY,
  },
];

let nextLogId = 3;
let nextPlanId = 2;
const PLANS = new Map<number, { total_bytes: number; candidates: Array<{ file_id: number; entity_id: number; path: string; size: number; reason: string }> }>();

/* ------------------------------------------------------------------ */
/* Index entries                                                       */
/* ------------------------------------------------------------------ */

type IndexFix = {
  index_path: string;
  root_path: string;
  last_status: string;
  last_scanned_at: number;
  files_scanned: number;
  folders_scanned: number;
  bytes_scanned: number;
  scan_strategy: string;
  walk_issues: number;
  hash_issues: number;
  intelligence: boolean;
};

let INDEXES: IndexFix[] = [
  {
    index_path: MAIN_INDEX,
    root_path: ROOT,
    last_status: "completed",
    last_scanned_at: NOW - 2 * 3600,
    files_scanned: 391_208,
    folders_scanned: 24_618,
    bytes_scanned: FOLDERS[0].total_bytes,
    scan_strategy: "smart",
    walk_issues: 3,
    hash_issues: 2,
    intelligence: true,
  },
  {
    index_path: MEDIA_INDEX,
    root_path: "D:\\Media",
    last_status: "completed",
    last_scanned_at: NOW - 9 * DAY,
    files_scanned: 48_204,
    folders_scanned: 1_240,
    bytes_scanned: Math.round(682.4 * GB),
    scan_strategy: "metadata",
    walk_issues: 0,
    hash_issues: 0,
    intelligence: false,
  },
];

const SCAN_ISSUES: Record<string, Array<{ phase: string; path: string; message: string }>> = {
  [MAIN_INDEX]: [
    { phase: "walk", path: `${ROOT}\\AppData\\Local\\Temp\\locked`, message: "Access is denied. (os error 5)" },
    { phase: "walk", path: `${ROOT}\\Documents\\Outlook Files`, message: "The process cannot access the file because it is being used by another process. (os error 32)" },
    { phase: "walk", path: `${ROOT}\\Videos\\.sync`, message: "Access is denied. (os error 5)" },
    { phase: "hash", path: `${ROOT}\\Documents\\ledger-2024.xlsx`, message: "The process cannot access the file because it is being used by another process. (os error 32)" },
    { phase: "hash", path: `${ROOT}\\Photos\\OneDrive\\IMG_8841.heic`, message: "online-only cloud file — make it available offline (e.g. OneDrive → 'Always keep on this device'), then retry verification" },
  ],
};

/* ------------------------------------------------------------------ */
/* Scan-job simulation (dev scan theater)                              */
/* ------------------------------------------------------------------ */

type JobEvent = Record<string, unknown>;

const jobBuffers = new Map<number, JobEvent[]>();
const jobTimers = new Map<number, ReturnType<typeof setInterval>>();
const listeners = new Set<(event: JobEvent) => void>();
let nextJobId = 1;

const SCAN_LOG_LINES: Array<[string, string]> = [
  ["walk", "Videos\\Screen Recordings — 2,301 entries"],
  ["stat", "Photos\\2024 — 18,204 entries · 22.1 GB"],
  ["hash", "graduation-uncut.mp4 — 4.1 GB xxh3:9f3a1c88"],
  ["walk", "Projects\\webshop\\node_modules — 61,204 entries"],
  ["skip", "symlink → ..\\shared (follow off)"],
  ["index", "Backups\\OldLaptop — +44.6 GB"],
  ["hash", "win11-dev.vdi — 22.4 GB xxh3:c41b02aa"],
  ["dup", "iceland-pano-08421.raw ≡ Backups\\OldLaptop\\Photos"],
  ["warn", "EACCES AppData\\Local\\LowPrivilege — permission denied"],
  ["index", "Videos — +142.6 GB"],
];

function emitJob(jobId: number, event: JobEvent) {
  const buf = jobBuffers.get(jobId) ?? [];
  buf.push(event);
  jobBuffers.set(jobId, buf);
  listeners.forEach((cb) => cb(event));
}

function startMockScan(root: string): { job_id: number; index_path: string } {
  const jobId = nextJobId++;
  const indexPath = `mock://indexes/scan-${jobId}.sqlite`;
  jobBuffers.set(jobId, []);
  const totalFiles = 391_208;
  const totalBytes = FOLDERS[0].total_bytes;
  let tick = 0;
  const TICKS = 46;

  const timer = setInterval(() => {
    tick += 1;
    const frac = Math.min(1, tick / TICKS);
    const line = SCAN_LOG_LINES[tick % SCAN_LOG_LINES.length];
    if (tick >= TICKS) {
      clearInterval(timer);
      jobTimers.delete(jobId);
      INDEXES = [
        {
          index_path: indexPath,
          root_path: root,
          last_status: "completed",
          last_scanned_at: Math.floor(Date.now() / 1000),
          files_scanned: totalFiles,
          folders_scanned: 24_618,
          bytes_scanned: totalBytes,
          scan_strategy: "smart",
          walk_issues: 3,
          hash_issues: 2,
          intelligence: ontologyEnabled,
        },
        ...INDEXES.filter((e) => e.index_path !== indexPath),
      ];
      emitJob(jobId, {
        job_id: jobId,
        status: "Completed",
        message: "Scan complete",
        files_scanned: totalFiles,
        folders_scanned: 24_618,
        bytes_scanned: totalBytes,
        queue_depth: 0,
        active_workers: 0,
        current_path: null,
        progress_current: totalFiles,
        progress_total: totalFiles,
        phase_timings: [
          { phase: "walk", duration_ms: 1840 },
          { phase: "stat", duration_ms: 1210 },
          { phase: "hash", duration_ms: 2380 },
          { phase: "index", duration_ms: 640 },
        ],
      });
      return;
    }
    // Counter and log events are DISTINCT, matching the real emitter — the
    // frontend treats any event carrying log_line as log-only and skips its
    // counters (useScanJob.apply).
    const progress = {
      job_id: jobId,
      status: "Running",
      message: frac < 0.55 ? "Walking file tree" : frac < 0.85 ? "Hashing duplicate candidates" : "Writing index",
      files_scanned: Math.round(totalFiles * frac),
      folders_scanned: Math.round(24_618 * frac),
      bytes_scanned: Math.round(totalBytes * frac),
      queue_depth: Math.max(0, Math.round((1 - frac) * 34)),
      active_workers: 8,
      current_path: `${root}\\${line[1].split(" — ")[0]}`,
      progress_current: Math.round(totalFiles * frac),
      progress_total: totalFiles,
    };
    emitJob(jobId, progress);
    emitJob(jobId, { ...progress, log_line: { phase: line[0], message: line[1], elapsed_ms: tick * 130 } });
  }, 130);
  jobTimers.set(jobId, timer);

  return { job_id: jobId, index_path: indexPath };
}

/* ------------------------------------------------------------------ */
/* Command router                                                      */
/* ------------------------------------------------------------------ */

/** Mirror of the real backend's deleted_at flag: a trashed/moved file leaves
 *  its duplicate group (and dissolves groups that drop below two copies). */
function dropFromDupGroups(path: string) {
  for (let gi = DUP_GROUPS.length - 1; gi >= 0; gi--) {
    const group = DUP_GROUPS[gi];
    const i = group.files.findIndex((f) => f.path === path);
    if (i < 0) continue;
    group.files.splice(i, 1);
    group.file_count = group.files.length;
    group.reclaimable_bytes = Math.max(0, (group.files.length - 1) * group.size);
    if (group.files.length < 2) DUP_GROUPS.splice(gi, 1);
  }
}

function searchFiles(args: {
  query: string;
  limit: number;
  kinds?: string[] | null;
  min_bytes?: number | null;
  max_bytes?: number | null;
}) {
  const q = (args.query ?? "").trim().toLowerCase();
  return FILES.filter((f) => {
    if (q && !f.path.toLowerCase().includes(q)) return false;
    if (args.kinds?.length && !args.kinds.includes(f.media_kind)) return false;
    if (args.min_bytes != null && f.size < args.min_bytes) return false;
    if (args.max_bytes != null && f.size > args.max_bytes) return false;
    return true;
  })
    .slice(0, args.limit ?? 200)
    .map((f) => ({
      path: f.path,
      name: f.path.split("\\").pop()!,
      size: f.size,
      extension: f.extension,
      media_kind: f.media_kind,
      modified_at: f.modified_at,
    }));
}

const SAVED_VIEWS = [
  { id: "finished-untouched", name: "Finished & untouched", description: "Files in finished projects untouched for a year", protective: false },
  { id: "regenerable-large", name: "Large & regenerable", description: "Caches, build outputs and other regenerable data over 100 MB", protective: false },
  { id: "unprojected-files", name: "Loose files", description: "Large files that belong to no project", protective: false },
  { id: "unclassified", name: "Unclassified", description: "Files the intelligence layer has not classified yet", protective: false },
  { id: "orphan-sources", name: "Orphan sources", description: "Source files whose derivatives disappeared", protective: true },
  { id: "orphan-backups", name: "Orphan backups", description: "Backups whose originals are gone", protective: true },
];

function runSavedView(viewId: string): Array<{ file_id: number; path: string; size: number }> {
  const pick = (paths: string[]) =>
    FILES.filter((f) => paths.some((p) => f.path.startsWith(p))).map((f, i) => ({
      file_id: 100 + i,
      path: f.path,
      size: f.size,
    }));
  switch (viewId) {
    case "finished-untouched":
      return pick([j("Projects", "webshop"), j("Videos", "Movies")]);
    case "regenerable-large":
      return pick([j("Projects", "forge", "target"), j("Projects", "webshop", "node_modules"), j("AppData"), j("Photos", "Lightroom")]);
    case "unprojected-files":
      return pick([j("Downloads"), j("VMs")]);
    case "unclassified":
      return pick([j("Music"), j("Documents")]).slice(0, 4);
    case "orphan-sources":
      return [];
    case "orphan-backups":
      return pick([j("Backups", "phone-backup-2023.zip")]);
    default:
      return [];
  }
}

export function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const request = (args?.request ?? args ?? {}) as Record<string, unknown>;
  const done = (value: unknown) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value as T), 40 + Math.random() * 80));

  switch (cmd) {
    case "list_indexes":
      // The main index mirrors the live ontology flag so enable/disable shows up.
      return done(
        INDEXES.map((e) => (e.index_path === MAIN_INDEX ? { ...e, intelligence: ontologyEnabled } : e))
      );
    case "delete_index": {
      const path = (args as { indexPath: string }).indexPath;
      INDEXES = INDEXES.filter((e) => e.index_path !== path);
      return done(null);
    }
    case "query_index":
      return done({
        folders: FOLDERS,
        files: FILES,
        extensions: EXTENSIONS,
        duplicate_groups: DUP_GROUPS.map(({ files, ...group }) => ({
          ...group,
          // Mirror the real backend: up to 8 member paths, largest first.
          sample_paths: files
            .slice()
            .sort((a, b) => b.size - a.size)
            .slice(0, 8)
            .map((f) => f.path),
        })),
        media: MEDIA,
        folder_media: FOLDER_MEDIA,
        timeline: TIMELINE,
        age_buckets: AGE_BUCKETS,
      });
    case "scan_issues":
      return done(SCAN_ISSUES[String(request.index_path)] ?? []);
    case "retry_scan_issues": {
      // Simulate a retry where everything heals except the cloud placeholder
      // (it stays online-only until the user hydrates it).
      const key = String(request.index_path);
      const remaining = (SCAN_ISSUES[key] ?? []).filter((i) => i.message.includes("cloud"));
      SCAN_ISSUES[key] = remaining;
      const walk = remaining.filter((i) => i.phase === "walk").length;
      const hash = remaining.filter((i) => i.phase === "hash").length;
      INDEXES = INDEXES.map((e) =>
        e.index_path === key ? { ...e, walk_issues: walk, hash_issues: hash } : e
      );
      return done({ walk_issues: walk, hash_issues: hash });
    }
    case "file_lock_holders": {
      const p = String(request.path).toLowerCase();
      if (p.includes("outlook")) return done(["Microsoft Outlook"]);
      if (p.includes("ledger")) return done(["Microsoft Excel"]);
      return done([]);
    }
    case "folder_children": {
      const parent = String(request.parent_path ?? "").replace(/[\\/]+$/, "");
      const children = FOLDERS.filter((f) => {
        if (!f.path.startsWith(parent)) return false;
        const rest = f.path.slice(parent.length);
        return /^[\\/][^\\/]+$/.test(rest);
      })
        .slice()
        .sort((a, b) => b.total_bytes - a.total_bytes)
        .slice(0, Number(request.limit) || 500);
      return done(children);
    }
    case "search_files":
      return done(searchFiles(request as Parameters<typeof searchFiles>[0]));
    case "duplicate_group_files": {
      const group = DUP_GROUPS.find((g) => g.id === (request.group_id as number));
      return done(group?.files ?? []);
    }
    case "treemap_lens_data":
      return done(ontologyEnabled ? LENS : []);
    case "ontology_status":
      return done({
        enabled: ontologyEnabled,
        pending_discoveries: DISCOVERIES.filter((d) => d.status === "Pending").length,
        total_files: 391_208,
        populators: [
          { name: "heuristics", status: "completed", files_visited: 391_208, discoveries_emitted: 4, last_error: null },
          { name: "metadata", status: "completed", files_visited: 214_180, discoveries_emitted: 0, last_error: null },
          { name: "perceptual-hash", status: "completed", files_visited: 96_204, discoveries_emitted: 2, last_error: null },
        ],
      });
    case "set_ontology_enabled":
      ontologyEnabled = Boolean(request.enabled);
      return done(null);
    case "run_ontology_enrichment":
      return done({ ran: true });
    case "discoveries":
      return done(
        DISCOVERIES.filter((d) => d.status === "Pending" && d.kind === request.kind).sort(
          (a, b) => b.potential_bytes_unlocked - a.potential_bytes_unlocked
        )
      );
    case "confirm_discovery":
    case "reject_discovery": {
      const id = request.id as number;
      DISCOVERIES = DISCOVERIES.map((d) =>
        d.id === id
          ? { ...d, status: cmd === "confirm_discovery" ? "Confirmed" : "Rejected", resolved_at: NOW }
          : d
      );
      return done(null);
    }
    case "confirm_discovery_pattern":
    case "reject_discovery_pattern": {
      const kind = request.kind as string;
      const hit = DISCOVERIES.filter((d) => d.kind === kind && d.status === "Pending").length;
      DISCOVERIES = DISCOVERIES.map((d) =>
        d.kind === kind && d.status === "Pending"
          ? { ...d, status: cmd === "confirm_discovery_pattern" ? "Confirmed" : "Rejected", resolved_at: NOW }
          : d
      );
      return done(hit);
    }
    case "saved_views":
      return done(SAVED_VIEWS);
    case "run_saved_view":
      return done(runSavedView(request.view_id as string));
    case "cleanup_plan": {
      const reasons = (request.reasons as string[]) ?? [];
      const prefix = (request.path_prefix as string | null) ?? null;
      const reasonByPrefix: Array<[string, string]> = [
        [j("Projects", "forge", "target"), "safe-derivative"],
        [j("Projects", "webshop", "node_modules"), "scratch"],
        [j("Photos", "Lightroom", "Previews"), "safe-derivative"],
        [j("AppData", "Cache"), "scratch"],
        [j("AppData", "Temp"), "scratch"],
        [j("Backups", "OldLaptop"), "redundant-backup"],
        [j("Downloads", "Installers"), "scratch"],
        [j("Projects", "webshop"), "finished-project-cruft"],
      ];
      const candidates = reasonByPrefix
        .filter(([p, r]) => (!prefix || p.startsWith(prefix) || prefix.startsWith(p)) && (!reasons.length || reasons.includes(r)))
        .map(([p, r], i) => {
          const folder = FOLDERS.find((f) => f.path === p);
          const lensRow = LENS.find((l) => l.folder_path === p);
          return {
            file_id: 500 + i,
            entity_id: 500 + i,
            path: p,
            size: lensRow?.reclaimable_bytes ?? folder?.total_bytes ?? 0,
            reason: r,
          };
        })
        .filter((c) => c.size > 0);
      const plan = {
        plan_id: nextPlanId++,
        total_files: candidates.length,
        total_bytes: candidates.reduce((s, c) => s + c.size, 0),
        candidates,
      };
      PLANS.set(plan.plan_id, plan);
      return done(plan);
    }
    case "execute_cleanup_plan": {
      const plan = PLANS.get(request.plan_id as number);
      const cleanedAt = Math.floor(Date.now() / 1000);
      if (plan) {
        for (const c of plan.candidates) {
          CLEANUP_LOG = [
            {
              id: nextLogId++,
              cleanup_plan_id: request.plan_id as number,
              file_id: c.file_id,
              original_path: c.path,
              size: c.size,
              cleaned_at: cleanedAt,
              reason: c.reason,
              restore_status: "in_recycle_bin",
              expires_at: cleanedAt + 30 * DAY,
            },
            ...CLEANUP_LOG,
          ];
        }
      }
      return done({
        plan_id: request.plan_id,
        cleaned: plan?.candidates.length ?? 0,
        bytes_cleaned: plan?.total_bytes ?? 0,
        failed: [],
      });
    }
    case "recently_cleaned":
      return done(CLEANUP_LOG.slice(0, (request.limit as number) ?? 50));
    case "restore_from_cleanup_log": {
      const id = request.entry_id as number;
      CLEANUP_LOG = CLEANUP_LOG.map((e) => (e.id === id ? { ...e, restore_status: "restored" } : e));
      return done(null);
    }
    case "pin_file":
    case "unpin_file":
    case "override_classification":
    case "reveal_in_explorer":
      return done(null);
    case "trash_files": {
      const paths = (request.paths as string[]) ?? [];
      for (const p of paths) {
        const i = FILES.findIndex((f) => f.path === p);
        if (i >= 0) FILES.splice(i, 1);
        dropFromDupGroups(p);
      }
      return done({ failed: [] });
    }
    case "move_files": {
      const moves = (request.moves as Array<{ from: string; to: string }>) ?? [];
      let moved = 0;
      for (const m of moves) {
        const f = FILES.find((x) => x.path === m.from);
        if (f) f.path = m.to;
        // The real backend flags the source row deleted; the destination only
        // reappears after a rescan — so it leaves its duplicate group for now.
        dropFromDupGroups(m.from);
        moved++;
      }
      return done({ moved, failed: [] });
    }
    case "file_provenance":
      return done({
        file_id: request.file_id,
        path: "",
        is_pinned: false,
        attrs: [],
        relations: [],
      });
    case "allow_preview_root":
      return done(ROOT);
    case "start_scan_job_for_root": {
      const a = args as { root: string; enableIntelligence?: boolean | null };
      // Mirror the real backend: the opt-in is applied with the scan itself.
      if (typeof a.enableIntelligence === "boolean") ontologyEnabled = a.enableIntelligence;
      return done(startMockScan(a.root));
    }
    case "cancel_scan_job": {
      const jobId = (args as { jobId: number }).jobId;
      const timer = jobTimers.get(jobId);
      if (timer) clearInterval(timer);
      jobTimers.delete(jobId);
      emitJob(jobId, {
        job_id: jobId,
        status: "Cancelled",
        message: "Scan cancelled",
        files_scanned: 0,
        folders_scanned: 0,
        bytes_scanned: 0,
        queue_depth: 0,
        active_workers: 0,
        current_path: null,
        progress_current: 0,
        progress_total: 0,
      });
      return done(null);
    }
    case "scan_job_events": {
      const jobId = (args as { jobId: number }).jobId;
      const offset = (args as { offset: number }).offset ?? 0;
      return done((jobBuffers.get(jobId) ?? []).slice(offset));
    }
    case "scan_job_status": {
      const jobId = (args as { jobId: number }).jobId;
      const buf = jobBuffers.get(jobId) ?? [];
      const last = buf[buf.length - 1] as { status?: string } | undefined;
      return done(last?.status ?? "Running");
    }
    default:
      return Promise.reject(new Error(`mock backend: unhandled command "${cmd}"`));
  }
}

export function mockListen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  if (event !== "scan-job-event") return Promise.resolve(() => {});
  const cb = (payload: JobEvent) => handler({ payload: payload as T });
  listeners.add(cb);
  return Promise.resolve(() => listeners.delete(cb));
}

/** Deterministic SVG placeholder so image previews render in dev. */
export function mockPreviewSrc(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  const name = path.split("\\").pop() ?? "";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${hue},42%,28%)'/>` +
    `<stop offset='1' stop-color='hsl(${(hue + 40) % 360},48%,16%)'/>` +
    `</linearGradient></defs>` +
    `<rect width='320' height='200' fill='url(#g)'/>` +
    `<text x='16' y='180' font-family='monospace' font-size='13' fill='rgba(255,255,255,0.75)'>${name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
