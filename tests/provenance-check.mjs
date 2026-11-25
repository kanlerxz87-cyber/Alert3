#!/usr/bin/env node
/* Verify that every data row in the site's HTML and Markdown tables carries an
 * official/first-party source link. Header and separator rows are skipped.
 *
 * Official sources are MLB StatsAPI, MLB/MLB Static, first-party GitHub repos
 * and APIs, GitHub Docs, and the two first-party GitHub Pages deployments.
 * Values that cannot be confirmed are expected to be blank and flagged in the
 * row's status cell; this check does not infer or fill them. */
import { JSDOM } from 'jsdom';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OFFICIAL_HOSTS = new Set([
  'statsapi.mlb.com',
  'www.mlb.com',
  'mlb.com',
  'www.mlbstatic.com',
  'img.mlbstatic.com',
  'github.com',
  'api.github.com',
  'docs.github.com',
  'snapquast73-boop.github.io',
  'kanlerxz87-cyber.github.io',
]);

function officialUrl(text) {
  for (const match of String(text).matchAll(/https?:\/\/([^\s"'<>)&#]+)/g)) {
    const host = match[1].split('/')[0].toLowerCase();
    if ([...OFFICIAL_HOSTS].some((allowed) => host === allowed || host.endsWith('.' + allowed))) return true;
  }
  return false;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules' || entry === '.cache') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(?:html|md)$/i.test(entry)) out.push(full);
  }
  return out;
}

const problems = [];
let htmlRows = 0;
let markdownRows = 0;

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replaceAll(path.sep, '/');
  const source = readFileSync(file, 'utf8');
  if (file.endsWith('.html')) {
    const dom = new JSDOM(source);
    for (const row of dom.window.document.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll('td, th')];
      if (!row.querySelector('td') || cells.every((c) => c.tagName === 'TH')) continue;
      htmlRows += 1;
      const links = [...row.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).join(' ');
      if (!officialUrl(links) && !officialUrl(row.textContent)) {
        problems.push(`${rel}: HTML data row missing official source: ${row.textContent.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
      }
    }
    dom.window.close();
  } else {
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/^\s*\|/.test(line)) continue;
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^[-: ]*$/.test(c))) continue;
      if (i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
      markdownRows += 1;
      if (!officialUrl(line)) {
        problems.push(`${rel}:${i + 1}: Markdown data row missing official source: ${line.trim().slice(0, 160)}`);
      }
    }
  }
}

console.log(`provenance-check: ${htmlRows} HTML data rows, ${markdownRows} Markdown data rows`);
if (problems.length) {
  console.error(`provenance-check: ${problems.length} row(s) missing official source links`);
  for (const problem of problems) console.error(' - ' + problem);
  process.exit(1);
}
console.log('provenance-check: OK — every data row has an official/first-party source link');
