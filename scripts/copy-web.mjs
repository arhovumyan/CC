// Assembles the web game into ./www so Capacitor can package it.
// The repo root stays the source of truth (Firebase Hosting serves "."),
// and this script copies ONLY the game assets into www/ for the native apps.
import { existsSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const www = join(root, "www");

// Files/folders that make up the playable game. Add new asset dirs here.
const assets = [
  "index.html",
  "game.js",
  "level-objectives.js",
  "style.css",
  "images",
  "HorizontalLines",
  "VerticalLines",
];

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

for (const name of assets) {
  const src = join(root, name);
  if (!existsSync(src)) {
    console.warn(`skip (missing): ${name}`);
    continue;
  }
  cpSync(src, join(www, name), { recursive: true });
  console.log(`copied: ${name}`);
}

console.log("web assets assembled into www/");
