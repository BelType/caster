/**
 * An SVG `<img>` that an engine shows through a slot it assigned by hand is seated as a drawing in the same slot, and a file with no `viewBox` is scaled to the box as the image was.
 *
 * @remarks
 * Under Cicero a top-level `<img>` is a light child of `<beltype-root>`, shown on its page only while a manually assigned slot holds it. The seated `<svg>` replaced it in the light tree and no slot took it, so it was connected, unstyled and 0 × 0, and the seating refused (codeberg.org/BelType/caster issue 3). A file with a width and a height and no `viewBox` was then cropped rather than scaled, since an inline `<svg>` synthesizes no viewBox where an image does.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentType } from '@beltype/common/mime';
import { launchBrowser } from './launch.ts';

const DIST = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));

const MAP = '<svg width="2180" height="1600" xmlns="http://www.w3.org/2000/svg"><rect width="2180" height="1600" fill="#c33"/></svg>';
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>body { margin: 0 } img { width: 100% }</style></head><body><div id="host"><img src="/map.svg" alt="A map"></div></body></html>`;

test('in the page: an SVG <img> held by a manually assigned slot is seated in that slot, with the viewBox an image would have', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    if (url.pathname === '/map.svg') return void response.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(MAP);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file)) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const seen = await page.evaluate(async () => {
      const img = document.querySelector('img') as HTMLImageElement;
      await img.decode();
      // Cicero's shape: the page lives in the host's shadow, and a slot assigned by hand shows the light child on it.
      const shadow = (document.getElementById('host') as HTMLElement).attachShadow({ mode: 'open', slotAssignment: 'manual' });
      shadow.innerHTML = '<div style="width: 400px"><p>Map.</p><slot></slot></div>';
      (shadow.querySelector('slot') as HTMLSlotElement).assign(img);
      const before = img.getBoundingClientRect();
      const { inlineSvgImages } = await import('/src/images/svgInline.js' as string);
      const walk = { images: [{ element: img, src: img.src, domPath: 'img[0]', path: 'Document/Figure[0]', tag: 'Figure', alt: 'A map' }], svgs: [] as { element: SVGSVGElement }[], decorated: [] };
      try {
        inlineSvgImages(walk, new Map([[img.src, { bytes: new Uint8Array(await (await fetch(img.src)).arrayBuffer()), mimeType: 'image/svg+xml' }]]));
      } catch (e: any) {
        return { error: String(e.message) };
      }
      const svg = walk.svgs[0].element;
      const after = svg.getBoundingClientRect();
      return { before: [before.width, before.height], after: [after.width, after.height], viewBox: svg.getAttribute('viewBox'), slotted: svg.assignedSlot !== null };
    });
    assert.equal(seen.error, undefined);
    assert.equal(seen.slotted, true);
    assert.deepEqual(seen.after?.map(Math.round), seen.before?.map(Math.round));
    assert.equal(seen.viewBox, '0 0 2180 1600');
  } finally {
    await browser.close();
    server.close();
  }
});
