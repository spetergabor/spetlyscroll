import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "assets", "desktop", "icon.svg");
const iconset = path.join(root, "assets", "desktop", "Spetlyscroll.iconset");
const output = path.join(root, "assets", "desktop", "icon.icns");
const sizes = [16, 32, 128, 256, 512];

await fs.rm(iconset, { recursive: true, force: true });
await fs.mkdir(iconset, { recursive: true });

for (const size of sizes) {
  await sharp(source).resize(size, size).png().toFile(path.join(iconset, `icon_${size}x${size}.png`));
  await sharp(source).resize(size * 2, size * 2).png().toFile(path.join(iconset, `icon_${size}x${size}@2x.png`));
}

execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", output]);
await fs.rm(iconset, { recursive: true, force: true });
console.log(output);
