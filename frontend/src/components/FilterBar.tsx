import { categories } from "../domain";
import type { CategoryKey } from "../domain";

interface FilterBarProps {
  filter: CategoryKey | "all";
  setFilter: (filter: CategoryKey | "all") => void;
}

export function FilterBar({ filter, setFilter }: FilterBarProps) {
  return (
    <section className="filter-bar" aria-label="Category filters">
      <button className={filter === "all" ? "active" : ""} type="button" onClick={() => setFilter("all")}>
        All
      </button>
      {(Object.keys(categories) as CategoryKey[]).map((key) => (
        <button
          className={filter === key ? "active" : ""}
          key={key}
          type="button"
          onClick={() => setFilter(key)}
        >
          <span style={{ background: categories[key].color }} />
          {categories[key].label}
        </button>
      ))}
    </section>
  );
}
