import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

const mono = "font-mono text-[11px] uppercase";
const panelClass = "border border-white/12 bg-[#0d0f11] shadow-[0_-8px_32px_rgba(0,0,0,0.6)]";

export function ConfigDropdown({ children }: { children: React.ReactNode }) {
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
          <div className="border-b border-white/7 px-[14px] py-[10px]">
            <span className={`${mono} tracking-[2px] text-white/50`}>Configuration</span>
          </div>

          <div className="px-[14px] py-[12px] grid gap-[14px]">
            <ConfigSection label="Scan Source">
              <ConfigOption label="Local Filesystem" active />
              <ConfigOption label="S3 Bucket" disabled hint="coming soon" />
              <ConfigOption label="Network Share" disabled hint="coming soon" />
            </ConfigSection>

            <ConfigSection label="Scan Strategy">
              <ConfigOption label="Default (Partial FNV-1a)" active />
              <ConfigOption label="Full Hash" disabled hint="coming soon" />
            </ConfigSection>
          </div>

          <div className="border-t border-white/5 px-[14px] py-[8px]">
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
      <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-white/30 mb-[6px] block">{label}</span>
      <div className="grid gap-[4px]">{children}</div>
    </div>
  );
}

function ConfigOption({
  label,
  active = false,
  disabled = false,
  hint,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between px-[10px] py-[7px] border ${
        active
          ? "border-[#00d0c4]/30 bg-[#00d0c4]/8 text-[#00d0c4]"
          : "border-white/8 text-white/30"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <span className="font-mono text-[11px] uppercase">{label}</span>
      <div className="flex items-center gap-2">
        {active && <span className="h-[5px] w-[5px] rounded-full bg-[#00d0c4]" />}
        {hint && <span className="font-mono text-[9px] uppercase text-white/20">{hint}</span>}
      </div>
    </div>
  );
}
