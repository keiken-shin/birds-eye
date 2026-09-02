import { useEffect, useState } from "react";
import { AlertTriangle, Check, CloudOff, FileQuestion, Lock, ScanLine, ShieldOff, Waves } from "lucide-react";
import { formatCount } from "@bridge/domain";
import { scanCoverage, type NativeScanCoverage } from "@bridge/nativeClient";
import { readShareLabel } from "../lib/evidence";
import { Card, SectionLabel } from "./ui/Card";

/**
 * What the last scan actually read.
 *
 * "391,208 files scanned" counts directory entries. Reading a file's contents is
 * a separate pass, it only runs on files that could be copies of something, and
 * it fails in ways that mean different things. Without this panel the app
 * implies it saw everything, and the one number a person most needs — how much
 * of the disk the advice is based on — is the one it never showed.
 *
 * Every line here is a fact already recorded during the scan. Nothing is
 * estimated, and a share is only shown when there is a real denominator.
 */

type Skip = {
  key: keyof NativeScanCoverage;
  label: string;
  hint: string;
  icon: typeof Lock;
};

const SKIPS: Skip[] = [
  {
    key: "skipped_offline",
    label: "stored online only",
    hint: "The file is in the cloud, not on this disk. Make it available offline, then scan again.",
    icon: CloudOff,
  },
  {
    key: "skipped_locked",
    label: "in use by something else",
    hint: "Another program held the file open. Close it and scan again.",
    icon: Lock,
  },
  {
    key: "skipped_denied",
    label: "not allowed to read",
    hint: "Windows refused access. Running as administrator usually fixes it.",
    icon: ShieldOff,
  },
  {
    key: "skipped_changed",
    label: "changed while being read",
    hint: "Something was writing to the file. Bird's Eye threw the result away rather than record a value it could not trust.",
    icon: Waves,
  },
  {
    key: "skipped_failed",
    label: "could not be read",
    hint: "Something else went wrong. The details are in the list below.",
    icon: FileQuestion,
  },
];

function Row({ value, label, hint, icon: Icon, tone }: {
  value: number;
  label: string;
  hint: string;
  icon: typeof Lock;
  tone: "good" | "warn";
}) {
  return (
    <div className="flex items-start gap-2.5 px-4 py-2" title={hint}>
      <Icon
        size={13}
        strokeWidth={2}
        aria-hidden
        className={`mt-[3px] flex-none ${tone === "warn" ? "text-warn" : "text-primary-ink"}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="mono flex-none text-12 font-semibold text-ink">
            {formatCount(value)}
          </span>
          <span className="truncate text-12 text-muted">{label}</span>
        </span>
        <span className="block text-10 leading-snug text-faint">{hint}</span>
      </span>
    </div>
  );
}

export function ScanCoveragePanel({ indexPath }: { indexPath: string }) {
  const [coverage, setCoverage] = useState<NativeScanCoverage | null>(null);

  useEffect(() => {
    let live = true;
    setCoverage(null);
    scanCoverage(indexPath)
      .then((c) => {
        if (live) setCoverage(c);
      })
      .catch(() => {
        if (live) setCoverage(null);
      });
    return () => {
      live = false;
    };
  }, [indexPath]);

  if (!coverage) return null;

  const skipped = SKIPS.map((s) => ({ ...s, value: coverage[s.key] as number })).filter(
    (s) => s.value > 0
  );
  const skippedTotal = skipped.reduce((sum, s) => sum + s.value, 0);
  const attempted = coverage.read_fully + coverage.read_sampled + skippedTotal;
  // No denominator, no percentage. "100% read" over nothing read is the most
  // confident possible way of saying nothing.
  const shareLabel = readShareLabel(coverage.read_fully + coverage.read_sampled, skippedTotal);

  return (
    <Card className="overflow-hidden">
      <div className="px-4 pt-3 pb-2">
        <SectionLabel>What this scan actually read</SectionLabel>
        <p className="mt-1.5 text-12 leading-snug text-muted">
          {shareLabel === null ? (
            <>
              Nothing on this disk needed its contents read — no two files are the same size, so
              there was nothing to compare.
            </>
          ) : (
            <>
              Bird's Eye opened{" "}
              <span className="mono font-semibold text-ink">{shareLabel}</span> of the{" "}
              {formatCount(attempted)} files worth comparing.{" "}
              {formatCount(coverage.not_needed)} more were left alone because nothing else on the
              disk is their size.
            </>
          )}
        </p>
      </div>

      <div className="divide-y divide-line-soft border-t border-line-soft">
        {coverage.read_fully > 0 ? (
          <Row
            value={coverage.read_fully}
            label="read all the way through"
            hint="Every byte compared. This is the only evidence strong enough to call two files identical."
            icon={Check}
            tone="good"
          />
        ) : null}
        {coverage.read_sampled > 0 ? (
          <Row
            value={coverage.read_sampled}
            label="read in parts only"
            hint="Enough to spot likely copies, not enough to delete one. Bird's Eye reads these in full before it removes anything."
            icon={ScanLine}
            tone="good"
          />
        ) : null}
        {skipped.map((s) => (
          <Row key={s.key} value={s.value} label={s.label} hint={s.hint} icon={s.icon} tone="warn" />
        ))}
        {coverage.folders_unreadable > 0 ? (
          <Row
            value={coverage.folders_unreadable}
            label="folders that could not be opened"
            hint="Whatever is inside these is in none of the numbers above — not in the size totals, and not in anything Bird's Eye suggests."
            icon={AlertTriangle}
            tone="warn"
          />
        ) : null}
      </div>
    </Card>
  );
}
