import { useMemo, useState, type ReactNode } from "react";

interface VirtualRowsProps<T> {
  items: T[];
  estimateRowHeight?: number;
  maxHeight?: number;
  className?: string;
  overscan?: number;
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
}

export function VirtualRows<T>({
  items,
  estimateRowHeight = 58,
  maxHeight = 360,
  className,
  overscan = 4,
  getKey,
  renderItem,
}: VirtualRowsProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const totalHeight = items.length * estimateRowHeight;
  const visibleCount = Math.ceil(maxHeight / estimateRowHeight);
  const startIndex = Math.max(0, Math.floor(scrollTop / estimateRowHeight) - overscan);
  const endIndex = Math.min(items.length, startIndex + visibleCount + overscan * 2);

  const visibleItems = useMemo(
    () => items.slice(startIndex, endIndex),
    [endIndex, items, startIndex]
  );

  return (
    <div
      className={`max-h-[360px] overflow-auto pr-1.5 [scrollbar-color:rgba(244,241,234,0.32)_rgba(255,255,255,0.06)] [scrollbar-width:thin] ${className ?? ""}`}
      style={{ maxHeight }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="relative" style={{ height: totalHeight }}>
        <div
          className="absolute left-0 right-0 top-0"
          style={{ transform: `translateY(${startIndex * estimateRowHeight}px)` }}
        >
          {visibleItems.map((item, offset) => {
            const index = startIndex + offset;
            return (
              <div key={getKey(item, index)} style={{ minHeight: estimateRowHeight }}>
                {renderItem(item, index)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
