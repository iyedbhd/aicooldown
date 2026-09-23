/**
 * Writes every logo file from the mark drawn in src/lib/brand.ts. Change the
 * logo there, then run
 *
 *   npm run brand
 *
 *   public/mark.svg           the mark playing its cooldown (SMIL, self-contained)
 *   public/logo.svg           mark and wordmark, for dark backgrounds
 *   public/logo-on-light.svg  mark and wordmark, for light backgrounds
 *   src/app/icon.svg          favicon: the small-size mark
 *   src/app/favicon.ico       16, 32 and 48px, for browsers and crawlers that ask for /favicon.ico
 *   src/app/icon.png          192px, a multiple of 48px as Google's favicon guidelines ask
 *   src/app/apple-icon.png    180px and square: iOS rounds the corners itself
 *   desktop/icon.ico          the Windows executable's icon, 16 to 256px
 *
 * Needs Node 22.18 or later, which runs the TypeScript import as it is.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { markBody } from "../src/lib/brand.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * "AI Cooldown" as the Wordmark component sets it (Geist SemiBold, 30px,
 * -0.03em tracking), outlined so the logo looks the same where the font is
 * missing, as in a README. Baseline at y = 0; capitals are 21.3 tall.
 */
const WORDMARK =
  "M0.57 0L8.25 -21.3L13.02 -21.3L20.7 0L16.62 0L14.85 -5.04L6.42 -5.04L4.65 0ZM7.56 -8.37L13.71 -8.37L10.65 -17.37ZM22.06 0L22.06 -21.3L25.96 -21.3L25.96 0ZM44.78 0.48Q41.87 0.48 39.65 -0.85Q37.43 -2.19 36.17 -4.66Q34.91 -7.14 34.91 -10.62Q34.91 -14.04 36.14 -16.54Q37.37 -19.05 39.59 -20.41Q41.81 -21.78 44.81 -21.78Q48.89 -21.78 51.14 -19.75Q53.39 -17.73 54.08 -14.1L50 -13.89Q49.61 -15.99 48.32 -17.19Q47.03 -18.39 44.81 -18.39Q43.01 -18.39 41.69 -17.43Q40.37 -16.47 39.65 -14.73Q38.93 -12.99 38.93 -10.62Q38.93 -8.22 39.67 -6.49Q40.4 -4.77 41.72 -3.84Q43.04 -2.91 44.78 -2.91Q47.15 -2.91 48.46 -4.21Q49.76 -5.52 50.12 -7.8L54.2 -7.59Q53.78 -5.1 52.58 -3.28Q51.38 -1.47 49.42 -0.49Q47.45 0.48 44.78 0.48ZM63.23 0.36Q60.86 0.36 59.08 -0.67Q57.29 -1.71 56.32 -3.6Q55.34 -5.49 55.34 -8.01Q55.34 -10.56 56.32 -12.43Q57.29 -14.31 59.08 -15.34Q60.86 -16.38 63.23 -16.38Q65.6 -16.38 67.37 -15.34Q69.14 -14.31 70.12 -12.43Q71.09 -10.56 71.09 -8.01Q71.09 -5.49 70.12 -3.6Q69.14 -1.71 67.37 -0.67Q65.6 0.36 63.23 0.36ZM63.23 -2.76Q65.09 -2.76 66.1 -4.14Q67.1 -5.52 67.1 -8.01Q67.1 -10.47 66.1 -11.86Q65.09 -13.26 63.23 -13.26Q61.37 -13.26 60.35 -11.86Q59.33 -10.47 59.33 -8.01Q59.33 -5.52 60.35 -4.14Q61.37 -2.76 63.23 -2.76ZM80.12 0.36Q77.75 0.36 75.97 -0.67Q74.18 -1.71 73.21 -3.6Q72.23 -5.49 72.23 -8.01Q72.23 -10.56 73.21 -12.43Q74.18 -14.31 75.97 -15.34Q77.75 -16.38 80.12 -16.38Q82.49 -16.38 84.26 -15.34Q86.03 -14.31 87.01 -12.43Q87.98 -10.56 87.98 -8.01Q87.98 -5.49 87.01 -3.6Q86.03 -1.71 84.26 -0.67Q82.49 0.36 80.12 0.36ZM80.12 -2.76Q81.98 -2.76 82.99 -4.14Q83.99 -5.52 83.99 -8.01Q83.99 -10.47 82.99 -11.86Q81.98 -13.26 80.12 -13.26Q78.26 -13.26 77.24 -11.86Q76.22 -10.47 76.22 -8.01Q76.22 -5.52 77.24 -4.14Q78.26 -2.76 80.12 -2.76ZM94.04 0Q92.3 0 91.25 -0.9Q90.2 -1.8 90.2 -3.78L90.2 -21.3L94.04 -21.3L94.04 -4.17Q94.04 -3.57 94.36 -3.27Q94.67 -2.97 95.24 -2.97L96.41 -2.97L96.41 0ZM103.67 0.36Q101.63 0.36 100.15 -0.66Q98.66 -1.68 97.85 -3.57Q97.04 -5.46 97.04 -8.01Q97.04 -10.56 97.85 -12.45Q98.66 -14.34 100.16 -15.36Q101.66 -16.38 103.67 -16.38Q105.35 -16.38 106.63 -15.69Q107.9 -15 108.56 -13.74L108.56 -21.3L112.4 -21.3L112.4 0L108.74 0L108.65 -2.37Q107.99 -1.08 106.67 -0.36Q105.35 0.36 103.67 0.36ZM104.84 -2.76Q106.04 -2.76 106.87 -3.36Q107.69 -3.96 108.13 -5.14Q108.56 -6.33 108.56 -8.01Q108.56 -9.72 108.13 -10.89Q107.69 -12.06 106.87 -12.66Q106.04 -13.26 104.84 -13.26Q103.1 -13.26 102.07 -11.86Q101.03 -10.47 101.03 -8.01Q101.03 -5.61 102.07 -4.18Q103.1 -2.76 104.84 -2.76ZM122.36 0.36Q119.99 0.36 118.21 -0.67Q116.42 -1.71 115.45 -3.6Q114.47 -5.49 114.47 -8.01Q114.47 -10.56 115.45 -12.43Q116.42 -14.31 118.21 -15.34Q119.99 -16.38 122.36 -16.38Q124.73 -16.38 126.5 -15.34Q128.27 -14.31 129.25 -12.43Q130.22 -10.56 130.22 -8.01Q130.22 -5.49 129.25 -3.6Q128.27 -1.71 126.5 -0.67Q124.73 0.36 122.36 0.36ZM122.36 -2.76Q124.22 -2.76 125.23 -4.14Q126.23 -5.52 126.23 -8.01Q126.23 -10.47 125.23 -11.86Q124.22 -13.26 122.36 -13.26Q120.5 -13.26 119.48 -11.86Q118.46 -10.47 118.46 -8.01Q118.46 -5.52 119.48 -4.14Q120.5 -2.76 122.36 -2.76ZM135.12 0L130.29 -16.02L134.22 -16.02L137.34 -4.35L140.55 -16.02L143.91 -16.02L147.15 -4.35L150.27 -16.02L154.2 -16.02L149.37 0L145.41 0L142.23 -10.74L139.08 0ZM155.36 0L155.36 -16.02L158.84 -16.02L158.99 -11.52L158.54 -11.7Q158.78 -13.38 159.53 -14.4Q160.28 -15.42 161.36 -15.9Q162.44 -16.38 163.73 -16.38Q165.5 -16.38 166.71 -15.6Q167.93 -14.82 168.56 -13.45Q169.19 -12.09 169.19 -10.29L169.19 0L165.35 0L165.35 -9.06Q165.35 -10.41 165.08 -11.34Q164.81 -12.27 164.19 -12.76Q163.58 -13.26 162.56 -13.26Q161.03 -13.26 160.11 -12.18Q159.2 -11.1 159.2 -9.06L159.2 0Z";

const svg = (width, height, body, scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * scale}" height="${height * scale}" role="img" aria-label="AI Cooldown"><title>AI Cooldown</title>${body}</svg>\n`;

/** Mark and wordmark side by side, the capitals centred on the tile. */
const lockup = (ink) => svg(250, 64, `${markBody({ id: "m" })}<path transform="translate(80 42.65)" fill="${ink}" d="${WORDMARK}"/>`, 2);

/** The mark as a PNG drawn at `size` pixels: the small-size mark up to 32px. */
const png = (size, options) =>
  sharp(Buffer.from(svg(64, 64, markBody({ id: "m", small: size <= 32, ...options }), 1)), { density: (72 * size) / 64 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

/** A 32-bit bottom-up bitmap with its transparency mask, as an .ico stores small images. */
async function bitmap(image, size) {
  const { data } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = 40;
  const mask = pixels + size * size * 4;
  const stride = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(mask + stride * size);
  out.writeUInt32LE(40, 0); // BITMAPINFOHEADER
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8); // the colour rows, then the mask's
  out.writeUInt16LE(1, 12);
  out.writeUInt16LE(32, 14);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = data.subarray((y * size + x) * 4);
      out.set([b, g, r, a], pixels + (row * size + x) * 4);
      if (a === 0) out[mask + row * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** An .ico of the mark at each size: bitmaps below 64px, which every reader takes, and PNG from 64px, which Windows reads since Vista. */
async function ico(sizes) {
  const images = await Promise.all(sizes.map(async (size) => (size < 64 ? bitmap(await png(size), size) : png(size))));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); // an icon, not a cursor
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + 16 * i;
    header[entry] = header[entry + 1] = size % 256; // 0 means 256
    header.writeUInt16LE(1, entry + 4); // planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(images[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

const files = {
  "public/mark.svg": svg(64, 64, markBody({ id: "m", animate: "smil" }), 4),
  "public/logo.svg": lockup("#fafafa"),
  "public/logo-on-light.svg": lockup("#0f1115"),
  "src/app/icon.svg": svg(64, 64, markBody({ id: "m", small: true }), 1),
  "src/app/favicon.ico": await ico([16, 32, 48]),
  "src/app/icon.png": await png(192),
  "src/app/apple-icon.png": await png(180, { bleed: true }),
  "desktop/icon.ico": await ico([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]),
};
for (const [file, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(ROOT, file), content);
  console.log(`${file.padEnd(26)} ${(Buffer.byteLength(content) / 1024).toFixed(1)} KB`);
}
