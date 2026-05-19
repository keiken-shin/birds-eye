import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import type { ScanStrategy } from "../domain";

const mono = "font-mono text-11 uppercase";
const panelClass = "border border-white/12 bg-surface shadow-inner";

export function ConfigDropdown({
  children,
  scanStrategy,
  onScanStrategyChange,
}: {
  children: React.ReactNode;
  scanStrategy: ScanStrategy;
  onScanStrategyChange: (strategy: ScanStrategy) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="relative" ref={triggerRef}>
      <div onClick={toggle}>{children}</div>
      {open && (
        <div
          ref={panelRef}
          className={`absolute bottom-[calc(100%+10px)] left-0 w-[300px] ${panelClass}`}
          role="dialog"
          aria-label="Scan configuration"
        >
          <div className="border-b border-white/7 px-3.5 py-2.5">
            <span className={`${mono} tracking-[2px] text-white/50`}>Configuration</span>
          </div>

          <div className="px-3.5 py-[12px] grid gap-3.5">
            <ConfigSection label="Scan Source">
              <ConfigOption label="Local Filesystem" active />
              <ConfigOption label="S3 Bucket" disabled hint="coming soon" />
              <ConfigOption label="Network Share" disabled hint="coming soon" />
            </ConfigSection>

            <ConfigSection label="Scan Strategy">
              <ConfigOption
                label="XXH3 Progressive"
                description="Fast default with stronger sampling for modern scans."
                active={scanStrategy === "xxh3-progressive"}
                hint="recommended"
                onClick={() => onScanStrategyChange("xxh3-progressive")}
              />
              <ConfigOption
                label="Legacy FNV-1a"
                description="Compatibility mode for repeatable legacy index comparisons."
                active={scanStrategy === "fnv1a-legacy"}
                onClick={() => onScanStrategyChange("fnv1a-legacy")}
              />
            </ConfigSection>
          </div>

          <div className="border-t border-white/5 px-3.5 py-[8px]">
            <span className={`${mono} text-white/15`}>More sources and strategies coming soon</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigSection({ label, children }: { children: React.ReactNode; label: string }) {
  return (
    <div>
      <span className="font-mono text-10 uppercase tracking-[1.5px] text-white/30 mb-[6px] block">{label}</span>
      <div className="grid gap-[4px]">{children}</div>
    </div>
  );
}

function ConfigOption({
  label,
  description,
  active = false,
  disabled = false,
  hint,
  onClick,
}: {
  label: string;
  description?: string;
  active?: boolean;
  disabled?: boolean;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex justify-between px-2.5 py-[7px] border ${
        active
          ? "border-accent/30 bg-accent/8 text-accent"
          : "border-white/8 text-white/30"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span className="grid gap-1 pr-3">
        <span className="font-mono text-11 uppercase">{label}</span>
        {description && <span className="font-mono text-10 uppercase leading-snug text-white/30">{description}</span>}
      </span>
      <div className="flex items-center gap-2">
        {active && <span className="h-[5px] w-[5px] rounded-full bg-accent" />}
        {hint && <span className="font-mono text-9 uppercase text-white/20">{hint}</span>}
      </div>
    </button>
  );
}




