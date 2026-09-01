/* Bird's Eye docs — the only client-side code on the site.
   Search over a generated index, the mobile nav drawer, ToC scroll-spy, and
   copy buttons on code blocks. No dependencies, no network beyond /search.json. */
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ---------------------------------------------- analysis walkthrough */
  // The guide is deliberately static-first: these controls only reveal the
  // explanation that is already in the document. No file is read by the site.
  const walkthrough = $("[data-analysis-walkthrough]");
  if (walkthrough) {
    const scenarios = {
      image: {
        title: "JPEG + PNG",
        verdict: "Possible near-duplicate — review it",
        note: "The current perceptual pass reads bytes, not decoded pixels. It can surface similar-looking exports only as a coarse discovery; it does not prove that the pictures are the same.",
        steps: ["Records extension and file facts", "Groups exact duplicates by size", "Samples bytes and compares aHash + dHash", "Leaves a near-duplicate discovery for you to confirm"]
      },
      source: {
        title: "design.psd → design.png",
        verdict: "Possible derivative — review it",
        note: "A same-folder filename stem, different extension, later modified time, and plausible size ratio match the structural heuristic. The app does not open Photoshop or reconstruct the export graph.",
        steps: ["Records both files and timestamps", "Rules label PSD as a likely source", "Sibling heuristic compares names, formats, time, and size", "Shows a proposed derivedFrom relationship; you decide"]
      },
      binary: {
        title: "model.blend + model.glb",
        verdict: "Exact duplicate only if bytes match",
        note: "Unknown binaries are still scanned and can be exact duplicates. There is no Blender/CAD parser in this pipeline, so a GLB exported from a .blend is not identified as a derivative by content.",
        steps: ["Records path, extension, size, and times", "Groups only files with equal size", "Hashes candidate bytes with xxHash", "Reports exact matches; does not infer an application provenance"]
      },
      normal: {
        title: "report.pdf + report.docx",
        verdict: "Classified as documents; content comparison is limited",
        note: "The extension supplies a coarse media kind. A bounded PDF header reader may extract a title, but Bird's Eye does not compare the meaning of two documents or convert one format into the other.",
        steps: ["Records both files and timestamps", "Classifies both as documents", "Uses size + hashes for exact byte identity", "Uses path/name/age rules for separate recommendations"]
      },
      cache: {
        title: "node_modules/",
        verdict: "Safe to delete — rebuildable",
        note: "This is a path rule, not duplicate detection. The recommendation comes from a known scratch location that can be recreated from project manifests.",
        steps: ["Scans folder without following links", "Stores its size and hierarchy", "Path rule labels it scratch", "Cleanup still requires review and uses the Recycle Bin"]
      }
    };
    const buttons = $$('[data-analysis-choice]', walkthrough);
    const title = $("[data-analysis-title]", walkthrough);
    const verdict = $("[data-analysis-verdict]", walkthrough);
    const note = $("[data-analysis-note]", walkthrough);
    const list = $("[data-analysis-steps]", walkthrough);
    const render = (key) => {
      const item = scenarios[key] || scenarios.image;
      title.textContent = item.title;
      verdict.textContent = item.verdict;
      note.textContent = item.note;
      list.innerHTML = item.steps.map((step, i) => `<li><span>${i + 1}</span>${step}</li>`).join("");
      buttons.forEach((button) => button.classList.toggle("is-selected", button.dataset.analysisChoice === key));
    };
    buttons.forEach((button) => button.addEventListener("click", () => render(button.dataset.analysisChoice)));
    render("image");
  }

  /* ------------------------------------------------------- mobile nav */
  const toggle = $(".navtoggle");
  const sidebar = $("#sidebar");
  if (toggle && sidebar) {
    const setOpen = (open) => {
      sidebar.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    };
    toggle.addEventListener("click", () => setOpen(!sidebar.classList.contains("open")));
    sidebar.addEventListener("click", (e) => { if (e.target.tagName === "A") setOpen(false); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sidebar.classList.contains("open")) { setOpen(false); toggle.focus(); }
    });
    document.addEventListener("click", (e) => {
      if (!sidebar.classList.contains("open")) return;
      if (!sidebar.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
  }

  /* ---------------------------------------------------- copy buttons */
  for (const block of $$(".codeblock")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code to clipboard");
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("code", block).textContent.replace(/\n$/, ""));
        btn.textContent = "Copied";
      } catch {
        btn.textContent = "Failed";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1600);
    });
    block.appendChild(btn);
  }

  /* ------------------------------------------------------ scroll-spy */
  const tocLinks = $$(".tocbox a");
  if (tocLinks.length) {
    const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const targets = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    let active = null;
    const mark = (a) => {
      if (active === a) return;
      if (active) active.classList.remove("active");
      active = a;
      if (a) a.classList.add("active");
    };
    const observer = new IntersectionObserver(
      () => {
        // The heading closest above the top of the viewport wins.
        const top = window.scrollY + parseInt(getComputedStyle(document.documentElement).scrollPaddingTop || "0", 10) + 4;
        let current = targets[0];
        for (const t of targets) if (t.getBoundingClientRect().top + window.scrollY <= top) current = t;
        mark(current ? byId.get(current.id) : null);
      },
      { rootMargin: "0px 0px -70% 0px", threshold: [0, 1] }
    );
    for (const t of targets) observer.observe(t);
  }

  /* ---------------------------------------------------------- search */
  const input = $("#q");
  const results = $("#results");
  if (!input || !results) return;

  let index = null, loading = null, items = [], cursor = -1;

  const load = () =>
    (loading ||= fetch("/search.json")
      .then((r) => r.json())
      .then((d) => (index = d))
      .catch(() => (index = [])));

  const norm = (s) => s.toLowerCase();

  function score(record, terms) {
    const title = norm(record.t), section = norm(record.s || ""), text = norm(record.x || "");
    let total = 0;
    for (const term of terms) {
      let best = 0;
      if (title.startsWith(term)) best = 10;
      else if (title.includes(term)) best = 6;
      else if (section.includes(term)) best = 3;
      const hits = text.split(term).length - 1;
      if (hits) best = Math.max(best, 1) + Math.min(hits, 4) * 0.5;
      if (!best) return 0;
      total += best;
    }
    return total;
  }

  function snippet(text, term) {
    const at = norm(text).indexOf(term);
    if (at < 0) return text.slice(0, 130);
    const from = Math.max(0, at - 40);
    return (from ? "…" : "") + text.slice(from, from + 150);
  }

  function render(query) {
    const terms = norm(query).split(/\s+/).filter(Boolean);
    items = [];
    cursor = -1;
    if (!terms.length) { close(); return; }

    const ranked = (index || [])
      .map((r) => [score(r, terms), r])
      .filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 8)
      .map(([, r]) => r);

    results.innerHTML = ranked.length
      ? ranked
          .map(
            (r, i) =>
              `<a role="option" id="r${i}" aria-selected="false" href="${r.u}">` +
              `<span class="rs">${escapeHtml(r.s || "")}</span>` +
              `<span class="rt">${escapeHtml(r.t)}</span>` +
              `<span class="rx">${escapeHtml(snippet(r.x || "", terms[0]))}</span></a>`
          )
          .join("")
      : `<p class="empty">No matches for “${escapeHtml(query)}”.</p>`;

    items = $$("a", results);
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function close() {
    results.hidden = true;
    results.innerHTML = "";
    items = [];
    cursor = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function move(step) {
    if (!items.length) return;
    if (cursor >= 0) items[cursor].setAttribute("aria-selected", "false"), items[cursor].classList.remove("sel");
    cursor = (cursor + step + items.length) % items.length;
    items[cursor].classList.add("sel");
    items[cursor].setAttribute("aria-selected", "true");
    items[cursor].scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", items[cursor].id);
  }

  input.addEventListener("focus", load, { once: true });
  input.addEventListener("input", async () => {
    await load();
    render(input.value.trim());
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && cursor >= 0) { e.preventDefault(); items[cursor].click(); }
    else if (e.key === "Escape") { close(); input.blur(); }
  });
  document.addEventListener("click", (e) => {
    if (!results.hidden && !results.contains(e.target) && e.target !== input) close();
  });
  document.addEventListener("keydown", (e) => {
    const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); input.focus(); }
  });
})();
