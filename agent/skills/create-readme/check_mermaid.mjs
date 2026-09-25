#!/usr/bin/env node
// Parse-check mermaid blocks without a browser. Chromium-free, so it works in
// sandboxes where @mermaid-js/mermaid-cli cannot launch.
//
//   npm i mermaid jsdom dompurify
//   node check_mermaid.mjs README.md        # checks every fence in the file
//   node check_mermaid.mjs arch.mmd         # checks a bare .mmd file
//
// Exit 0 = every diagram parses. Exit 1 = at least one fails, named on stdout.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.DOMPurify = (await import('dompurify')).default(dom.window);
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false });

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node check_mermaid.mjs <file.md|file.mmd> [...]');
  process.exit(2);
}

let seen = 0;
let bad = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const blocks = /\.mmd$/.test(file) ? [text] : [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

  if (!blocks.length) {
    console.log('none', file, '(no ```mermaid fences)');
    continue;
  }

  for (const [i, block] of blocks.entries()) {
    seen++;
    const label = `${file}#${i + 1}`;
    try {
      await mermaid.parse(block);
      console.log('PASS', label);
    } catch (e) {
      bad++;
      const first = (e.message || String(e)).split('\n').find((l) => l.trim()) || '';
      console.log('FAIL', label, '->', first);
      block.split('\n').forEach((line, n) => console.log(`   ${n + 1}| ${line}`));
    }
  }
}

console.log(`\n${seen - bad}/${seen} diagram(s) parsed`);
process.exit(bad ? 1 : 0);
