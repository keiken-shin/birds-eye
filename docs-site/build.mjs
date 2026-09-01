#!/usr/bin/env node
/**
 * Bird's Eye docs — static site generator.
 *
 * Reads docs/ ** /*.md, renders it in the research document's theme, and writes
 * one static HTML file per page into site/. No framework, no bundler, no runtime
 * markdown fetching: real URLs, real SEO, instant loads.
 *
 *   node build.mjs            build site/
 *   node build.mjs --serve    build, then serve site/ on http://localhost:8000
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, Renderer } from "marked";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DOCS = path.join(ROOT, "docs");
const OUT = path.join(ROOT, "site");

const SITE = {
  name: "Bird's Eye",
  url: "https://birds-eye.keiken.dev",
  repo: "https://github.com/keiken-shin/birds-eye",
  description:
    "Free, offline disk cleanup for Windows that explains what is safe to remove — " +
    "with a size, last-touched date, and reason for every recommendation.",
};

/**
 * The information architecture. This is the former `mkdocs.yml` `nav:` block —
 * the one thing the generator needs that markdown files don't carry. Pages not
 * listed here still build; the build warns so nothing is silently orphaned.
 */
const NAV = [
  { title: "Home", page: "index.md" },
  {
    title: "Guides",
    children: [
      { title: "Getting started", page: "guide/getting-started.md" },
      { title: "The workspace", page: "guide/the-workspace.md" },
      { title: "How the analysis works", page: "guide/how-analysis-works.md" },
      { title: "Stage, group, and review", page: "guide/stage-and-review.md" },
      { title: "Working safely", page: "guide/working-safely.md" },
    ],
  },
  {
    title: "Develop",
    children: [
      { title: "Architecture", page: "develop/architecture.md" },
      { title: "Building from source", page: "develop/building.md" },
      { title: "Contributing", page: "develop/contributing.md" },
      { title: "Releasing", page: "develop/releasing.md" },
      { title: "Store & listing copy", page: "develop/store-listing.md" },
    ],
  },
  { title: "Brand", page: "brand.md" },
];

/** The single-stroke bird mark, verbatim from the research document. */
const BIRD_MARK =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M16 7h.01M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>' +
  '<path d="m20 7 2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/>' +
  '<path d="M7 18a6 6 0 0 0 3.84-10.61"/></svg>';

/** MkDocs / Material admonition types → the research document's callout variants. */
const CALLOUT = {
  note: "", info: "", tip: "", hint: "", abstract: "", summary: "", tldr: "", example: "", quote: "",
  success: "good", check: "good", done: "good",
  warning: "warn", caution: "warn", attention: "warn", important: "warn",
  danger: "crit", error: "crit", failure: "crit", fail: "crit", missing: "crit", bug: "crit",
};

/**
 * Icon shortcodes (`:material-radar:{ .lg .middle }`) — Material's icon set, which this theme
 * does not ship. Trailing spaces go too, so stripping one out of `-   :icon:{…} **Scan**`
 * leaves the list item's content column exactly where the author put it.
 */
const ICON_SHORTCODE = /:(?:material|fontawesome|octicons|simple|lucide)-[a-z0-9-]+:(?:\s*\{[^}\n]*\})?[ \t]*/g;

const warnings = [];
const stats = { icons: 0, admonitions: 0, tabsets: 0, defLists: 0, mdBlocks: 0, attrLists: 0 };
const warn = (m) => warnings.push(m);

/* ------------------------------------------------------------------ helpers */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A single pass is not enough: `<scr<script>ipt>` has its inner tag removed and the halves
 * close back up into a live `<script`. Strip until the string stops changing — each pass
 * removes at least one bracketed run, so it always terminates.
 */
const stripTags = (s) => {
  let out = String(s);
  for (let prev = null; out !== prev; ) {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  }
  return out;
};

/** Rendered HTML → plain text. Entities must be decoded or `esc()` double-escapes them. */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };
const unesc = (s) =>
  String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, k) => {
    const key = k.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(Number(key.slice(1)));
    return m;
  });
const plain = (s) => unesc(stripTags(s));

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function slug(text) {
  return plain(text)
    .toLowerCase()
    .replace(/[’'"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function dedent(block) {
  const lines = block.split(/\r?\n/);
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n");
}

function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, ext, out);
    else if (!ext || entry.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function write(rel, contents) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

/* ------------------------------------------------------------- frontmatter */

function frontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(src);
  if (!m) return [{}, src];
  const meta = {};
  let key = null;
  const unquote = (v) => v.replace(/^["'](.*)["']$/s, "$1").trim();
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key) {
      if (!Array.isArray(meta[key])) meta[key] = [];
      meta[key].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      meta[key] = kv[2].trim() === "" ? [] : unquote(kv[2]);
    }
  }
  return [meta, src.slice(m[0].length)];
}

/* --------------------------------------------------- markdown preprocessing */

/** `!!! warning "Title"` + indented body → a `.callout` div whose body is markdown. */
function admonitions(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)!!!\s+([\w+-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*$/.exec(lines[i]);
    if (!m) { out.push(lines[i]); continue; }
    const [, indent, rawKind, title] = m;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) { body.push(""); continue; }
      if (!line.startsWith(indent + "    ")) break;
      body.push(line.slice(indent.length + 4));
    }
    while (body.length && !body.at(-1).trim()) body.pop();
    i = j - 1;

    const kind = rawKind.toLowerCase();
    if (!(kind in CALLOUT)) warn(`unknown admonition type "!!! ${rawKind}" — rendered as a plain callout`);
    const variant = CALLOUT[kind] || "";
    stats.admonitions++;
    out.push(
      `<div class="callout${variant ? " " + variant : ""}" markdown>`, "",
      `<span class="tag">${esc(title ?? cap(kind))}</span>`, "",
      ...body, "",
      "</div>", ""
    );
  }
  return out.join("\n");
}

/**
 * `=== "Tab"` content tabs → a grid of cards, one per tab.
 * Tabs hide content from Ctrl+F, from the search index, and from crawlers; cards
 * keep every word on the page, which is the whole point of static HTML.
 */
function contentTabs(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const head = /^(\s*)===[+!]?\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(lines[i]);
    if (!head) { out.push(lines[i++]); continue; }
    const indent = head[1];
    const items = [];
    while (i < lines.length) {
      const t = /^(\s*)===[+!]?\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(lines[i]);
      if (!t || t[1] !== indent) break;
      i++;
      const body = [];
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) { body.push(""); continue; }
        if (!line.startsWith(indent + "    ")) break;
        body.push(line.slice(indent.length + 4));
      }
      while (body.length && !body.at(-1).trim()) body.pop();
      items.push([t[2], body]);
    }
    stats.tabsets++;
    out.push(`<div class="tabset" markdown>`, "");
    for (const [title, body] of items) {
      out.push(`<div class="card" markdown>`, "", `#### ${title}`, "", ...body, "", `</div>`, "");
    }
    out.push(`</div>`, "");
  }
  return out.join("\n");
}

/** `Term` + `: Definition` lines → the research document's `.kv` definition list. */
function defLists(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim() || /^[\s>#|:\-*+\d]/.test(lines[i]) || !/^:\s+\S/.test(lines[i + 1] ?? "")) {
      out.push(lines[i]);
      continue;
    }
    const items = [];
    while (i < lines.length && lines[i].trim() && !/^:\s/.test(lines[i]) && /^:\s+\S/.test(lines[i + 1] ?? "")) {
      const term = lines[i++];
      const defs = [];
      while (i < lines.length && /^:\s+/.test(lines[i])) defs.push(lines[i++].replace(/^:\s+/, ""));
      items.push([term, defs]);
    }
    i--;
    stats.defLists++;
    out.push(`<dl class="kv" markdown>`, "");
    for (const [term, defs] of items) {
      out.push(`<dt markdown="span">${term}</dt>`, "");
      for (const def of defs) out.push(`<dd markdown="span">${def}</dd>`, "");
    }
    out.push(`</dl>`, "");
  }
  return out.join("\n");
}

/** Find the index of the tag that closes `<tag>` opened before `from`. */
function findClose(src, tag, from) {
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "gi");
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(src))) {
    if (m[0][1] === "/") { if (--depth === 0) return [m.index, re.lastIndex]; }
    else if (!m[0].endsWith("/>")) depth++;
  }
  return null;
}

/**
 * `md_in_html`: `<div class="card" markdown>` renders its body as markdown,
 * `markdown="span"` renders it as inline markdown (that's `<figure markdown="span">`).
 * The body goes back through the whole pipeline, so nesting works.
 */
function protectMdBlocks(src, ctx) {
  const re = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let out = "", cursor = 0, m;
  while ((m = re.exec(src))) {
    const [full, tag, attrs] = m;
    const attr = /(?:^|\s)markdown(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+)))?(?=\s|\/|$)/.exec(attrs);
    if (!attr) continue;
    const close = findClose(src, tag, re.lastIndex);
    if (!close) { warn(`unclosed <${tag} markdown> block — left as raw HTML`); continue; }

    const mode = (attr[1] ?? attr[2] ?? attr[3] ?? "block").toLowerCase();
    const inner = dedent(src.slice(re.lastIndex, close[0]));
    const kept = attrs.replace(attr[0], " ").replace(/\s+/g, " ").trim();
    const body = mode === "span" ? renderInline(inner, ctx) : renderBlock(inner, ctx);
    const html = `<${tag}${kept ? " " + kept : ""}>${body}</${tag}>`;

    stats.mdBlocks++;
    out += src.slice(cursor, m.index) + `\n\n<!--MDB:${ctx.blocks.push(html) - 1}-->\n\n`;
    cursor = close[1];
    re.lastIndex = close[1];
  }
  return out + src.slice(cursor);
}

/* -------------------------------------------------------- attribute lists */

function attrString(spec) {
  const classes = [];
  let out = "";
  for (const token of spec.trim().split(/\s+/)) {
    if (token.startsWith(".")) classes.push(token.slice(1));
    else if (token.startsWith("#")) out += ` id="${esc(token.slice(1))}"`;
    else if (token.includes("=")) {
      const [k, ...v] = token.split("=");
      out += ` ${esc(k)}="${esc(v.join("=").replace(/^["']|["']$/g, ""))}"`;
    }
  }
  return (classes.length ? ` class="${esc(classes.join(" "))}"` : "") + out;
}

/** `![alt](src){ .be-shot }` and `[text](url){ .md-button }`, applied post-render. */
function applyAttrLists(html) {
  html = html.replace(/(<img\b[^>]*?)\s*\/?>\s*\{([^}\n]+)\}/g, (_, open, spec) => {
    stats.attrLists++;
    return open + attrString(spec) + ">";
  });
  html = html.replace(/<a\b([^>]*)>((?:(?!<\/a>)[\s\S])*?)<\/a>\s*\{([^}\n]+)\}/g, (_, attrs, text, spec) => {
    stats.attrLists++;
    return `<a${attrs}${attrString(spec)}>${text}</a>`;
  });
  return html;
}

/* --------------------------------------------------------------- rendering */

/** docs-relative source path → site URL. */
function pageUrl(rel) {
  const clean = rel.replace(/\\/g, "/").replace(/\.md$/, "");
  if (clean === "index") return "/";
  return "/" + clean.replace(/\/index$/, "") + "/";
}

/** Resolve a markdown link against the source tree and map it into the site. */
function resolveHref(href, ctx) {
  if (!href) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#") || href.startsWith("/")) {
    return href;
  }
  const hash = href.includes("#") ? href.slice(href.indexOf("#")) : "";
  const target = hash ? href.slice(0, href.length - hash.length) : href;
  if (!target) return href;

  const base = path.dirname(path.join(DOCS, ctx.rel));
  const abs = path.resolve(base, target);
  const relFromDocs = path.relative(DOCS, abs).replace(/\\/g, "/");
  if (relFromDocs.startsWith("..")) {
    warn(`${ctx.rel}: link "${href}" points outside docs/`);
    return href;
  }

  for (const candidate of [relFromDocs, relFromDocs + ".md", relFromDocs.replace(/\/$/, "") + "/index.md"]) {
    if (!fs.existsSync(path.join(DOCS, candidate))) continue;
    return (candidate.endsWith(".md") ? pageUrl(candidate) : "/" + candidate) + hash;
  }
  warn(`${ctx.rel}: link "${href}" does not resolve to a file in docs/`);
  return href;
}

function makeRenderer(ctx) {
  return {
    heading(token) {
      let inner = this.parser.parseInline(token.tokens);
      let id = null, extra = "";
      inner = inner.replace(/\s*\{([^}\n]+)\}\s*$/, (_, spec) => {
        const attrs = attrString(spec);
        const idMatch = / id="([^"]*)"/.exec(attrs);
        if (idMatch) id = idMatch[1];
        extra = attrs.replace(/ id="[^"]*"/, "");
        stats.attrLists++;
        return "";
      });
      id ||= slug(inner);
      let unique = id, n = 1;
      while (ctx.ids.has(unique)) unique = `${id}-${++n}`;
      ctx.ids.add(unique);
      const text = plain(inner).trim();
      if (token.depth === 1) ctx.h1 ||= text;
      if (token.depth === 2 || token.depth === 3) ctx.toc.push({ id: unique, text, depth: token.depth });
      return (
        `<h${token.depth} id="${esc(unique)}"${extra}>${inner}` +
        `<a class="headerlink" href="#${esc(unique)}" aria-label="Permalink to “${esc(text)}”">#</a>` +
        `</h${token.depth}>\n`
      );
    },

    link(token) {
      const href = resolveHref(token.href, ctx);
      const title = token.title ? ` title="${esc(token.title)}"` : "";
      return `<a href="${esc(href)}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
    },

    image(token) {
      const src = resolveHref(token.href, ctx);
      const alt = token.text || "";
      if (!alt.trim()) warn(`${ctx.rel}: image "${token.href}" has no alt text`);
      const title = token.title ? ` title="${esc(token.title)}"` : "";
      return `<img src="${esc(src)}" alt="${esc(alt)}"${title} loading="lazy" decoding="async">`;
    },

    code(token) {
      const lang = (token.lang || "").split(/\s+/)[0];
      return (
        `<div class="codeblock"${lang ? ` data-lang="${esc(lang)}"` : ""}>` +
        `<pre><code${lang ? ` class="language-${esc(lang)}"` : ""}>${esc(token.text)}\n</code></pre></div>\n`
      );
    },

    table(token) {
      return `<div class="tablewrap">${Renderer.prototype.table.call(this, token)}</div>\n`;
    },
  };
}

function preprocess(src, ctx) {
  // Fenced code is stashed first so no later rewrite can reach inside it.
  const fences = [];
  let out = src.replace(/^([ \t]*)(```+|~~~+)[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, (block) => {
    return `%%FENCE${fences.push(block) - 1}%%`;
  });

  out = out.replace(ICON_SHORTCODE, () => { stats.icons++; return ""; });
  out = admonitions(out);
  out = contentTabs(out);
  out = defLists(out);
  out = out.replace(/%%FENCE(\d+)%%/g, (_, i) => fences[Number(i)]);
  return protectMdBlocks(out, ctx);
}

function finish(html, ctx) {
  html = html.replace(/<p>\s*<!--MDB:(\d+)-->\s*<\/p>/g, (_, i) => ctx.blocks[Number(i)]);
  html = html.replace(/<!--MDB:(\d+)-->/g, (_, i) => ctx.blocks[Number(i)]);
  html = applyAttrLists(html);
  const leftover = html.match(/\{\s*[.#][\w-]/g);
  if (leftover) warn(`${ctx.rel}: ${leftover.length} attribute list(s) could not be attached: ${leftover.join(" ")}`);
  const stranded = html.match(/%%FENCE\d+%%|<!--MDB:\d+-->/g);
  if (stranded) throw new Error(`${ctx.rel}: internal placeholders survived rendering: ${stranded.join(" ")}`);
  return html;
}

function renderBlock(src, ctx) {
  return finish(ctx.md.parse(preprocess(src, ctx)), ctx);
}

function renderInline(src, ctx) {
  return finish(ctx.md.parseInline(preprocess(src, ctx)), ctx);
}

/* -------------------------------------------------------------- navigation */

function navHtml(currentUrl) {
  const link = (item) => {
    const url = pageUrl(item.page);
    const current = url === currentUrl;
    return `<li><a href="${url}"${current ? ' aria-current="page" class="current"' : ""}>${esc(item.title)}</a></li>`;
  };
  return NAV.map((section) => {
    if (section.page) return `<ul class="nav-list nav-list--flat">${link(section)}</ul>`;
    return (
      `<p class="nav-heading">${esc(section.title)}</p>` +
      `<ul class="nav-list">${section.children.map(link).join("")}</ul>`
    );
  }).join("");
}

function topbarHtml(currentUrl) {
  const first = (section) => (section.page ? section.page : section.children[0].page);
  const owns = (section, url) =>
    section.page ? pageUrl(section.page) === url : section.children.some((c) => pageUrl(c.page) === url);
  return NAV.map(
    (s) =>
      `<a href="${pageUrl(first(s))}"${owns(s, currentUrl) ? ' class="current"' : ""}>${esc(s.title)}</a>`
  ).join("");
}

function tocHtml(toc) {
  if (toc.length < 2) return "";
  const items = toc
    .map((h) => `<li class="lvl${h.depth}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
    .join("");
  return (
    `<aside class="toc" aria-label="On this page">` +
    `<div class="tocbox"><p class="toc-title">On this page</p><ol>${items}</ol></div>` +
    `</aside>`
  );
}

/* ---------------------------------------------------------------- template */

function layout(page) {
  const full = page.hide.includes("navigation");
  const toc = page.hide.includes("toc") ? "" : tocHtml(page.toc);
  const title = page.title.includes(SITE.name) ? page.title : `${page.title} — ${SITE.name}`;
  const canonical = SITE.url + page.url;
  const structuredData = page.url === "/" ? JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE.name,
    description: SITE.description,
    url: SITE.url,
    downloadUrl: "https://apps.microsoft.com/detail/9NZH5J31GHSL",
    operatingSystem: "Windows 10, Windows 11",
    applicationCategory: "UtilitiesApplication",
    offers: {
      "@type": "Offer",
      price: 0,
      priceCurrency: "USD",
    },
  }).replace(/</g, "\\u003c") : null;

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(SITE.url)}/assets/screenshots/staged.png">
<meta property="og:image:alt" content="Bird's Eye Staged workspace with grouped files ready for review">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0a0b0d">
${structuredData ? `<script type="application/ld+json">${structuredData}</script>` : ""}
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/icon.png">
<link rel="stylesheet" href="/fonts/space-grotesk/index.css">
<link rel="stylesheet" href="/fonts/jetbrains-mono/index.css">
<link rel="stylesheet" href="/styles.css">
<script src="/app.js" defer></script>
</head>
<body${full ? ' class="is-landing"' : ""}>
<a class="skip" href="#content">Skip to content</a>

<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="/">${BIRD_MARK}<span>${esc(SITE.name)}</span></a>
    <nav class="navlinks" aria-label="Sections">${topbarHtml(page.url)}</nav>
    <div class="topbar-tools">
      <div class="search" role="search">
        <label class="sr-only" for="q">Search the documentation</label>
        <input id="q" type="search" class="searchbox" placeholder="Search…" autocomplete="off"
               role="combobox" aria-expanded="false" aria-controls="results" aria-autocomplete="list">
        <kbd class="search-hint">/</kbd>
        <div id="results" class="results" role="listbox" aria-label="Search results" hidden></div>
      </div>
      <a class="ghlink" href="${SITE.repo}" aria-label="Bird's Eye on GitHub"><svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/></svg></a>
      <button class="navtoggle" type="button" aria-expanded="false" aria-controls="sidebar" aria-label="Open navigation">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
    </div>
  </div>
</header>

<div class="layout${full ? " layout--full" : ""}${toc ? "" : " layout--notoc"}">
  ${full ? "" : `<nav class="sidebar" id="sidebar" aria-label="Documentation">${navHtml(page.url)}</nav>`}
  <main class="content" id="content">
${page.body}
  </main>
  ${toc}
</div>

<footer>
  <div class="footer-in">
    <p><b>${esc(SITE.name)} — disk cleanup for Windows.</b> Free and MIT-licensed. Everything runs on your PC; nothing is uploaded.</p>
    <p class="footer-links">
      <a href="/guide/getting-started/">Getting started</a>
      <a href="/guide/stage-and-review/">Stage and review</a>
      <a href="/guide/working-safely/">Safety and recovery</a>
      <a href="${SITE.repo}">Source on GitHub</a>
      <a href="${SITE.repo}/blob/main/LICENSE">MIT License</a>
      <a href="${SITE.repo}/issues">Report an issue</a>
    </p>
  </div>
</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------- build */

function searchRecords(page, html) {
  // Split the rendered page at h2 boundaries so results deep-link to a section.
  const text = (s) =>
    plain(
      s
        .replace(/<(pre|script|style)[\s\S]*?<\/\1>/g, " ")
        .replace(/<h1[\s\S]*?<\/h1>/g, " ")
        .replace(/<a class="headerlink"[\s\S]*?<\/a>/g, " ")
    )
      .replace(/\s+/g, " ")
      .trim();

  const parts = html.split(/(?=<h2 id=")/);
  const records = [{ u: page.url, t: page.h1 || page.title, s: page.section, x: text(parts[0]).slice(0, 900) }];
  for (const part of parts.slice(1)) {
    const m = /^<h2 id="([^"]+)"[^>]*>([\s\S]*?)<a class="headerlink"[\s\S]*?<\/a><\/h2>/.exec(part);
    if (!m) continue;
    records.push({
      u: page.url + "#" + m[1],
      t: plain(m[2]).trim(),
      s: page.h1 || page.title,
      x: text(part.slice(m[0].length)).slice(0, 900),
    });
  }
  return records.filter((r) => r.t);
}

function build() {
  const t0 = Date.now();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const files = walk(DOCS, ".md")
    .map((f) => path.relative(DOCS, f).replace(/\\/g, "/"))
    .sort();

  const navPages = new Set(NAV.flatMap((s) => (s.page ? [s.page] : s.children.map((c) => c.page))));
  for (const rel of files) if (!navPages.has(rel)) warn(`docs/${rel} is not in the nav — it builds, but nothing links to it`);
  for (const rel of navPages) if (!files.includes(rel)) warn(`nav lists docs/${rel}, which does not exist`);

  const sectionOf = (rel) => {
    for (const s of NAV) {
      if (s.page === rel) return s.title;
      if (s.children?.some((c) => c.page === rel)) return s.title;
    }
    return SITE.name;
  };

  const pages = [];
  const index = [];

  for (const rel of files) {
    const raw = fs.readFileSync(path.join(DOCS, rel), "utf8");
    const [meta, body] = frontmatter(raw);

    const md = new Marked({ gfm: true, breaks: false });
    const ctx = { rel, md, ids: new Set(), toc: [], blocks: [], h1: null };
    md.use({ renderer: makeRenderer(ctx) });

    const html = renderBlock(body, ctx);
    const page = {
      rel,
      url: pageUrl(rel),
      h1: ctx.h1,
      title: meta.title || ctx.h1 || SITE.name,
      description: meta.description || SITE.description,
      section: sectionOf(rel),
      hide: Array.isArray(meta.hide) ? meta.hide : meta.hide ? [meta.hide] : [],
      toc: ctx.toc,
      body: html,
    };
    const file = write(page.url === "/" ? "index.html" : page.url.slice(1) + "index.html", layout(page));
    pages.push({ ...page, file, bytes: fs.statSync(file).size });
    index.push(...searchRecords(page, html));
  }

  // Static assets: theme, client script, docs assets, fonts, CNAME, sitemap.
  fs.copyFileSync(path.join(HERE, "theme.css"), path.join(OUT, "styles.css"));
  fs.copyFileSync(path.join(HERE, "app.js"), path.join(OUT, "app.js"));
  copyDir(path.join(DOCS, "assets"), path.join(OUT, "assets"));
  if (fs.existsSync(path.join(DOCS, "CNAME"))) fs.copyFileSync(path.join(DOCS, "CNAME"), path.join(OUT, "CNAME"));
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

  for (const [pkg, dir] of [
    ["@fontsource-variable/space-grotesk", "space-grotesk"],
    ["@fontsource-variable/jetbrains-mono", "jetbrains-mono"],
  ]) {
    const src = path.join(HERE, "node_modules", pkg);
    if (!fs.existsSync(src)) throw new Error(`missing font package ${pkg} — run npm install in docs-site/`);
    const dest = path.join(OUT, "fonts", dir);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(src, "index.css"), path.join(dest, "index.css"));
    copyDir(path.join(src, "files"), path.join(dest, "files"));
  }

  write("search.json", JSON.stringify(index));
  write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      pages.map((p) => `  <url><loc>${SITE.url}${p.url}</loc></url>`).join("\n") +
      `\n</urlset>\n`
  );
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`);

  // Guard the offline promise: nothing in the output may load from another host.
  // Subresources only: <a href> and <link rel=canonical> are navigation/metadata, not loads.
  const SUBRESOURCE = [
    /<link\b(?![^>]*\brel="(?:canonical|alternate)")[^>]*\bhref="(?:https?:)?\/\/[^"]*"/gi,
    /\bsrc\s*=\s*"(?:https?:)?\/\/[^"]*"/gi,
    /\bsrcset\s*=\s*"[^"]*(?:https?:)?\/\/[^"]*"/gi,
    /@import[^;]*(?:https?:)?\/\/[^;]*/gi,
    /url\(\s*['"]?(?:https?:)?\/\/[^)]*\)/gi,
  ];
  const offenders = [];
  for (const file of walk(OUT).filter((f) => /\.(html|css|js)$/.test(f))) {
    const text = fs.readFileSync(file, "utf8");
    for (const re of SUBRESOURCE) {
      for (const m of text.matchAll(re)) offenders.push(`${path.relative(OUT, file)}: ${m[0].slice(0, 90)}`);
    }
  }
  if (offenders.length) {
    console.error("\nExternal subresource(s) found — the docs must load nothing off-machine:");
    for (const o of offenders) console.error("  " + o);
    process.exit(1);
  }

  // Report
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nBird's Eye docs → ${path.relative(ROOT, OUT)}/\n`);
  for (const p of pages) {
    console.log(
      `  ${pad("docs/" + p.rel, 34)} → ${pad(p.url, 26)} ${pad((p.bytes / 1024).toFixed(1) + " KB", 9)} ` +
        `${p.toc.length} headings`
    );
  }
  const fontBytes = walk(path.join(OUT, "fonts")).reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(
    `\n  ${pages.length} pages · ${index.length} search records · ` +
      `${stats.admonitions} callouts · ${stats.tabsets} tab sets · ${stats.defLists} definition lists · ${stats.mdBlocks} markdown-in-html blocks · ` +
      `${stats.attrLists} attribute lists · ${stats.icons} icon shortcodes stripped`
  );
  console.log(`  fonts self-hosted: ${(fontBytes / 1024 / 1024).toFixed(2)} MB · 0 external requests`);
  if (warnings.length) {
    console.log(`\n  ${warnings.length} warning(s):`);
    for (const w of [...new Set(warnings)]) console.log("   ! " + w);
  }
  console.log(`\n  built in ${Date.now() - t0} ms\n`);
  return pages;
}

/* ------------------------------------------------------------------- serve */

async function serve(port = 8000) {
  const { createServer } = await import("node:http");
  const TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json",
    ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif",
    ".woff2": "font/woff2", ".xml": "application/xml",
  };
  createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(OUT, url);
    if (!file.startsWith(OUT)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404, { "content-type": "text/plain" }).end("404"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }).listen(port, () => console.log(`  serving ${path.relative(ROOT, OUT)}/ on http://localhost:${port}\n`));
}

/* ---------------------------------------------------------------- selftest */

/**
 * `node build.mjs --selftest` — renders one fixture that uses every construct the
 * generator claims to support and asserts each one produced its component. Keeps
 * support for constructs the current docs happen not to use from rotting.
 */
function selftest() {
  const fixture = `
!!! warning "Heads up"
    Body **text** with a [link](../brand.md).

=== "Tab A"

    Alpha

=== "Tab B"

    Beta

Term
: Definition

<div class="grid cards" markdown>

-   :material-radar:{ .lg .middle } **Scan**

    ---

    Card body.

</div>

<div class="grid g3" markdown>

<div class="card" markdown>

#### Hand-rolled card

With a <span class="chip">chip</span> and a <span class="stat"><span class="v">12.3 GB</span></span>.

</div>

</div>

<figure markdown="span">
  ![Alt text](../assets/logo.svg){ .be-shot }
  <figcaption>Cap</figcaption>
</figure>

| A | B |
|---|---|
| 1 | 2 |

\`\`\`powershell
echo "hi"   # !!! not an admonition, === not a tab
\`\`\`

> Quoted line.
> <cite>Someone</cite>

### Custom anchor { #custom }

[Button](../brand.md){ .md-button }
`;

  const md = new Marked({ gfm: true, breaks: false });
  const ctx = { rel: "develop/__selftest.md", md, ids: new Set(), toc: [], blocks: [], h1: null };
  md.use({ renderer: makeRenderer(ctx) });
  const html = renderBlock(fixture, ctx);

  const checks = [
    ['callout + variant', /<div class="callout warn">/],
    ["callout tag label", /<span class="tag">Heads up<\/span>/],
    ["content tabs → cards", /<div class="tabset">[\s\S]*Tab A[\s\S]*Tab B/],
    ["definition list", /<dl class="kv">[\s\S]*<dt>Term<\/dt>[\s\S]*<dd>Definition<\/dd>/],
    ["material grid cards", /<div class="grid cards">\s*<ul>[\s\S]*<hr>/],
    ["hand-rolled card grid", /<div class="grid g3">[\s\S]*<div class="card">[\s\S]*<h4/],
    ["chip / stat passthrough", /<span class="chip">chip<\/span>[\s\S]*<span class="v">12\.3 GB<\/span>/],
    ["figure with span markdown", /<figure>\s*<img [^>]*class="be-shot">\s*<figcaption>/],
    ["image alt + lazy", /<img src="\/assets\/logo\.svg" alt="Alt text" loading="lazy"/],
    ["table wrapper", /<div class="tablewrap"><table>/],
    ["code block + language", /<div class="codeblock" data-lang="powershell">[\s\S]*class="language-powershell"/],
    ["fenced code untouched by preprocessors", /echo &quot;hi&quot;\s+# !!! not an admonition, === not a tab/],
    ["blockquote + cite", /<blockquote>[\s\S]*<cite>Someone<\/cite>/],
    ["heading custom id", /<h3 id="custom">/],
    ["attr_list on link", /<a href="\/brand\/" class="md-button">Button<\/a>/],
    ["link .md → pretty url", /<a href="\/brand\/">link<\/a>/],
    ["icon shortcodes stripped", /^(?!.*:material-)/s],
    ["no stranded attribute lists", /^(?!.*\{ \.)/s],
  ];

  let failed = 0;
  for (const [name, re] of checks) {
    const ok = re.test(html);
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
  }

  // Asserted directly rather than through a fixture: no markdown input can express a
  // tag whose removal reassembles another one, and one pass of the old strip did.
  const strippedOk = !/<script/i.test(stripTags("<scr<script>ipt>alert(1)</script>"));
  if (!strippedOk) failed++;
  console.log(`  ${strippedOk ? "ok  " : "FAIL"}  stripTags leaves no reassembled tag`);
  if (warnings.length) for (const w of [...new Set(warnings)]) console.log("   ! " + w);
  const total = checks.length + 1; // the construct checks, plus the stripTags assertion
  console.log(`\n  ${total - failed}/${total} construct checks passed\n`);
  if (failed) {
    console.log(html);
    process.exit(1);
  }
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  build();
  if (process.argv.includes("--serve")) await serve(Number(process.env.PORT) || 9001);
}
