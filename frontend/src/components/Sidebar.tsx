import { Activity, Database, FolderSearch, Radar, Settings } from "lucide-react";
import logoUrl from "../assets/birds-eye-logo.svg";

export function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand">
        <img src={logoUrl} alt="" />
        <span>Birds Eye</span>
      </div>
      <nav>
        <a className="active" href="#dashboard"><Activity size={18} />Dashboard</a>
        <a href="#scan"><Radar size={18} />Scan Manager</a>
        <a href="#treemap"><FolderSearch size={18} />Treemap</a>
        <a href="#data"><Database size={18} />Index</a>
        <a href="#settings"><Settings size={18} />Settings</a>
      </nav>
    </aside>
  );
}
