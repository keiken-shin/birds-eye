import { categories } from "../domain";
import type { CategoryKey } from "../domain";

interface FilterBarProps {
  filter: CategoryKey | "all";
  setFilter: (filter: CategoryKey | "all") => void;
}

export function FilterBar({ filter, setFilter }: FilterBarProps) {
  return (
    <section className="mb-[18px] flex flex-wrap gap-2 border-y border-[#f4f1ea]/10 py-3" aria-label="Category filters">
      <button className={filterButtonClass(filter === "all")} type="button" onClick={() => setFilter("all")}>
        All
      </button>
      {(Object.keys(categories) as CategoryKey[]).map((key) => (
        <button
          className={filterButtonClass(filter === key)}
          key={key}
          type="button"
          onClick={() => setFilter(key)}
        >
          <span className="h-2.5 w-2.5" style={{ background: categories[key].color }} />
          {categories[key].label}
        </button>
      ))}
    </section>
  );
}

function filterButtonClass(active: boolean) {
  return [
    "inline-flex min-h-[42px] cursor-pointer items-center gap-2 border px-3 font-mono text-[11px] font-extrabold uppercase",
    active ? "border-[#f4f1ea] bg-[#f4f1ea] text-[#050607]" : "border-white/15 bg-black/20 text-[#9a9a94] hover:bg-white/10 hover:text-[#f4f1ea]",
  ].join(" ");
}
