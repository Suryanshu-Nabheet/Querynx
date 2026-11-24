/**
 * Documentation site builder: renders markdown sources (docs-src/)
 * into a static site (site/).
 *
 * Zero dependencies: a small CommonMark-subset renderer (headings,
 * paragraphs, code fences, lists, tables, links, inline code, bold,
 * italic) plus a layout with syntax-free CSS. Content lives in
 * docs-src/*.md; the build is deterministic and testable.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const SRC = new URL('./docs-src', import.meta.url).pathname;
const OUT = new URL('./site', import.meta.url).pathname;

/** Render markdown (CommonMark subset) to HTML. */
export function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let codeLang = '';
  let codeBuffer = [];
  let listStack = [];
  let tableBuffer = [];

  const flushLists = () => {
    while (listStack.length) out.push(listStack.pop());
    listStack = [];
  };
  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const rows = tableBuffer.filter((r) => !/^\|[\s:|-]+\|$/.test(r.trim()));
    const cells = (row) =>
      row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
    out.push('<table>');
    if (rows.length > 0) {
      out.push('<thead><tr>' + cells(rows[0]).map((c) => `<th>${c}</th>`).join('') + '</tr></thead>');
      out.push('<tbody>');
      for (const row of rows.slice(1)) {
        out.push('<tr>' + cells(row).map((c) => `<td>${c}</td>`).join('') + '</tr>');
      }
      out.push('</tbody>');
    }
    out.push('</table>');
    tableBuffer = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code${codeLang ? ` class="lang-${codeLang}"` : ''}>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        inCode = false;
        codeBuffer = [];
      } else {
        flushLists();
        flushTable();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (line.trim().startsWith('|')) {
      flushLists();
      tableBuffer.push(line);
      continue;
    }
    flushTable();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushLists();
      const level = heading[1].length + 1; // h1 reserved for the page title
      out.push(`<h${level} id="${slugify(heading[2])}">${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      const open = listStack.at(-1);
      if (open !== '<ul>') {
        flushLists();
        out.push('<ul>');
        listStack.push('</ul>');
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      const open = listStack.at(-1);
      if (open !== '</ol>') {
        flushLists();
        out.push('<ol>');
        listStack.push('</ol>');
      }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    if (line.trim() === '') {
      flushLists();
      continue;
    }

    flushLists();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushLists();
  flushTable();
  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  }
  return out.join('\n');
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

const LAYOUT = (title, nav, content) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Querynx Docs</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="shell">
<nav class="sidebar">
  <a class="brand" href="/">Querynx</a>
  ${nav}
</nav>
<main>
${content}
</main>
</div>
</body>
</html>`;

const CSS = `:root{--bg:#0b0d10;--panel:#14171c;--border:#23272f;--text:#e6e9ef;--muted:#8b93a3;--accent:#4f8cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 ui-sans-serif,-apple-system,"Segoe UI",sans-serif}
.shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
.sidebar{border-right:1px solid var(--border);padding:24px 16px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:block;font-weight:800;font-size:18px;color:var(--text);text-decoration:none;margin-bottom:18px}
.sidebar a{display:block;color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:6px;font-size:13.5px}
.sidebar a:hover{color:var(--text);background:var(--panel)}
main{padding:40px 48px;max-width:860px}
h1{font-size:30px;margin:0 0 8px}
h2{font-size:21px;margin-top:36px;border-bottom:1px solid var(--border);padding-bottom:6px}
h3{font-size:16px;margin-top:26px;color:var(--accent)}
p{color:#c4cad6}
code{background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
pre{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;overflow-x:auto}
pre code{background:none;border:none;padding:0;font-size:13px}
table{border-collapse:collapse;width:100%;margin:16px 0}
th,td{border:1px solid var(--border);padding:8px 12px;text-align:left;font-size:13.5px}
th{background:var(--panel);color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:.06em}
a{color:var(--accent)}
@media(max-width:800px){.shell{grid-template-columns:1fr}.sidebar{position:static;height:auto;border-right:none}main{padding:24px}}`;

/** Build the static site. Returns the list of pages written. */
export function buildSite() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'style.css'), CSS);

  const sources = readdirSync(SRC).filter((f) => f.endsWith('.md')).sort();
  const nav = sources
    .map((f) => {
      const name = basename(f, '.md');
      const title = titleCase(name);
      return `<a href="/${name}.html">${title}</a>`;
    })
    .join('\n  ');

  const written = [];
  for (const file of sources) {
    const name = basename(file, '.md');
    const md = readFileSync(join(SRC, file), 'utf-8');
    const content = renderMarkdown(md);
    const html = LAYOUT(titleCase(name), nav, content);
    writeFileSync(join(OUT, `${name}.html`), html);
    written.push(`${name}.html`);
  }

  // Index page.
  const index = LAYOUT(
    'Querynx',
    nav,
    `<h1>Querynx</h1>
<p><strong>The open web, built for agents.</strong> Self-hostable, agent-native web search, extraction, crawling, indexing and autonomous research infrastructure.</p>
<p>Start with the <a href="/quickstart.html">quickstart</a>, browse the <a href="/api.html">API reference</a>, or read the <a href="/architecture.html">architecture</a>.</p>
<h2>What can it do?</h2>
<ul>
<li>Federated multi-provider web search with RRF merge and dedupe</li>
<li>Robots-compliant crawling with resumable state</li>
<li>Readability-grade content extraction with metadata</li>
<li>Native BM25 corpus with hybrid retrieval</li>
<li>Bounded autonomous research with evidence tracking</li>
<li>MCP server, TypeScript + Python SDKs, Tavily-compatible surface</li>
</ul>`
  );
  writeFileSync(join(OUT, 'index.html'), index);
  written.push('index.html');
  return written;
}

function titleCase(name) {
  return name
    .split('-')
    .map((w) => (w === 'api' ? 'API' : w === 'mcp' ? 'MCP' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// Run when executed directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const pages = buildSite();
  console.log(`[docs] built ${pages.length} pages: ${pages.join(', ')}`);
}
