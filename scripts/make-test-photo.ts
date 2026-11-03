/**
 * `node scripts/make-test-photo.ts`: draws the two photographs `fixtures/roads/downsample.html` places, with no photograph from anywhere and no randomness from the machine.
 *
 * @remarks
 * Egildo's ruling 11 of 2026-11-03: the test photograph is synthetic, drawn by code, deterministic and free of any licence. {@link paint} is plain integer arithmetic over a seeded generator (a linear congruential one), so two runs on any machine draw the same pixels: smooth gradients (so no run of identical pixels is long enough to look flat), hard-edged shapes and fine lines (so a resampler has something to get wrong), and a low-amplitude noise (so the opaque-photo rule's sampled unique-colour ratio clears its gate). `large.png` (2 400 by 1 600, 8-bit RGB) is written here with node's zlib, filter type Sub on every row; `large.jpg` (4 000 by 3 000) is encoded once by Chromium's canvas, which is the only JPEG encoder in this stack, and committed, since the encoder's bytes are the browser's and not this script's. Run it again only to replace the fixtures, and re-record the `downsample` document of the identity corpus after.
 *
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../test/launch.ts';

const ROADS = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'fixtures', 'roads');

/**
 * RGBA pixels of the drawing, row-major from the top. Self-contained: its source is sent to the page whole, so it may name nothing outside itself.
 *
 * @remarks
 * `noise` is the amplitude of the grain on the blue channel alone and `grain` the amplitude on all three; a PNG pays for every bit of noise, a JPEG at this quality quantises most of it away.
 */
function paint(width: number, height: number, seed: number, noise: number, grain: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = seed >>> 0;
  const next = (range: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state >>> 8) % range; };
  const triangle = (v: number, period: number): number => { const m = v % (2 * period); return m < period ? m : 2 * period - m; };
  const third = Math.max(1, Math.floor(height / 3));
  const fifth = Math.max(1, Math.floor(width / 5));
  // The sky and the ground: three gradients that never agree on where they climb, so neighbouring pixels differ in at least one channel.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = 30 + Math.floor((x * 150) / width) + Math.floor((triangle(y, third) * 40) / third);
      data[at + 1] = 70 + Math.floor((y * 120) / height) + Math.floor((triangle(x, fifth) * 25) / fifth);
      data[at + 2] = 210 - Math.floor(((x + y) * 130) / (width + height)) + Math.floor((triangle(x + 2 * y, third) * 20) / third);
      data[at + 3] = 255;
    }
  }
  // Hard-edged shapes with their own slopes: a bar, a disc and a wedge.
  const barX = Math.floor(width / 10), barY = Math.floor(height / 5), barW = Math.floor(width / 3), barH = Math.floor(height / 8);
  for (let y = barY; y < barY + barH; y++) for (let x = barX; x < barX + barW; x++) {
    const at = (y * width + x) * 4;
    data[at] = 200 + Math.floor(((x - barX) * 40) / barW);
    data[at + 1] = 60 + Math.floor(((y - barY) * 50) / barH);
    data[at + 2] = 50;
  }
  const cx = Math.floor((width * 3) / 5), cy = Math.floor((height * 3) / 5), radius = Math.floor(Math.min(width, height) / 5);
  for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) {
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
    const at = (y * width + x) * 4;
    data[at] = 235 - Math.floor(((y - cy + radius) * 80) / (2 * radius));
    data[at + 1] = 215 - Math.floor(((x - cx + radius) * 60) / (2 * radius));
    data[at + 2] = 90 + Math.floor(((x - cx + radius) * 40) / (2 * radius));
  }
  for (let y = Math.floor(height / 2); y < Math.floor((height * 9) / 10); y++) {
    const reach = Math.floor(((y - Math.floor(height / 2)) * width) / (6 * height));
    for (let x = Math.floor(width / 12); x < Math.floor(width / 12) + reach; x++) {
      const at = (y * width + x) * 4;
      data[at] = 35 + (y % 24);
      data[at + 1] = 90 + (x % 40);
      data[at + 2] = 55;
    }
  }
  // Fine lines, two pixels wide and every so often: the detail a reduction smears or keeps.
  const lineEvery = Math.max(8, Math.floor(width / 60));
  for (let y = Math.floor(height / 20); y < Math.floor(height / 6); y++) {
    for (let x = Math.floor(width / 2); x < Math.floor((width * 9) / 10); x++) {
      if (x % lineEvery > 1 && y % lineEvery > 1) continue;
      const at = (y * width + x) * 4;
      data[at] = 20; data[at + 1] = 25; data[at + 2] = 40 + (x % 32);
    }
  }
  // The grain.
  for (let i = 0; i < width * height; i++) {
    const at = i * 4;
    if (noise > 0) data[at + 2] += next(2 * noise + 1) - noise;
    if (grain > 0) { data[at] += next(2 * grain + 1) - grain; data[at + 1] += next(2 * grain + 1) - grain; data[at + 2] += next(2 * grain + 1) - grain; }
  }
  return data;
}

/** An RGB PNG of the pixels, every row filtered with Sub and deflated at level 9. */
function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 1;
    for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
      const here = rgba[(y * width + x) * 4 + c];
      const left = x === 0 ? 0 : rgba[(y * width + x - 1) * 4 + c];
      raw[y * (stride + 1) + 1 + x * 3 + c] = (here - left) & 0xff;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Buffer): number => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const png = encodePng(2400, 1600, paint(2400, 1600, 0x5eed, 1, 0));
fs.writeFileSync(path.join(ROADS, 'large.png'), png);

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const encoded: number[] = await page.evaluate(async ([source, width, height]: [string, number, number]) => {
    const draw = (0, eval)(`(${source})`) as (w: number, h: number, seed: number, noise: number, grain: number) => Uint8ClampedArray;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.putImageData(new ImageData(draw(width, height, 0x7e57, 0, 2) as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
    return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer())];
  }, [paint.toString(), 4000, 3000]);
  fs.writeFileSync(path.join(ROADS, 'large.jpg'), Buffer.from(encoded));
} finally {
  await browser.close();
}
console.log(`large.png ${png.length} bytes, large.jpg ${fs.statSync(path.join(ROADS, 'large.jpg')).size} bytes`);
