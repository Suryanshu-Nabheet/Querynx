/**
 * Docs site tests: the builder renders every source, every internal
 * link resolves, and the output is valid-enough HTML (balanced tags
 * on the subset we emit).
 */

import { describe, expect, it } from 'vitest';
import { buildSite, renderMarkdown } from '../build.mjs';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../site', import.meta.url).pathname;
const SRC = new URL('../docs-src', import.meta.url).pathname;

describe('renderMarkdown', () => {
  it('renders headings with ids', () => {
    const html = renderMarkdown('# Title\n\n## Section Name');
    expect(html).toContain('<h2 id="title">Title</h2>');
    expect(html).toContain('<h3 id="section-name">Section Name</h3>');
  });

  it('renders code fences with language classes', () => {
    const html = renderMarkdown('```bash\ndocker compose up\n```');
    expect(html).toContain('<pre><code class="lang-bash">docker compose up</code></pre>');
  });

  it('renders tables with headers', () => {
    const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>2</td>');
  });

  it('renders lists, links, bold and inline code', () => {
    const html = renderMarkdown('- item **bold**\n\nsee [docs](/x.html) and `code`');
    expect(html).toContain('<li>item <strong>bold</strong></li>');
    expect(html).toContain('<a href="/x.html">docs</a>');
    expect(html).toContain('<code>code</code>');
  });

  it('escapes HTML in content', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('buildSite', () => {
  it('builds every source into the site directory', () => {
    const pages = buildSite();
    const sources = readdirSync(SRC).filter((f) => f.endsWith('.md'));
    expect(pages.length).toBe(sources.length + 1); // + index
    for (const source of sources) {
      const page = source.replace('.md', '.html');
      expect(pages).toContain(page);
      expect(existsSync(join(OUT, page))).toBe(true);
    }
    expect(existsSync(join(OUT, 'index.html'))).toBe(true);
    expect(existsSync(join(OUT, 'style.css'))).toBe(true);
  });

  it('every internal link resolves to a built file', () => {
    buildSite();
    // All built files are valid link targets, not just pages.
    const targets = new Set(readdirSync(OUT));
    targets.add(''); // root

    for (const file of readdirSync(OUT).filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(join(OUT, file), 'utf-8');
      const links = [
        ...html.matchAll(/(?:href)="\/([^"#]*)"/g),
        ...html.matchAll(/(?:href="\/style\.css")/g),
      ].map((m) => m[1] ?? 'style.css');
      for (const link of links) {
        expect(targets.has(link), `${file} links to missing /${link}`).toBe(true);
      }
    }
  });

  it('each page has a title, nav and layout', () => {
    buildSite();
    for (const file of readdirSync(OUT).filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(join(OUT, file), 'utf-8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<title>');
      expect(html).toContain('class="sidebar"');
      expect(html).toContain('href="/style.css"');
    }
  });

  it('emits balanced tags for the subset we produce', () => {
    buildSite();
    for (const file of readdirSync(OUT).filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(join(OUT, file), 'utf-8');
      for (const tag of ['table', 'ul', 'pre', 'main', 'nav']) {
        const opens = html.split(`<${tag}`).length - 1;
        const closes = html.split(`</${tag}>`).length - 1;
        expect(opens, `${file}: <${tag}> open=${opens} close=${closes}`).toBe(closes);
      }
    }
  });
});
