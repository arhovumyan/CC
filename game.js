"use strict";

const COLOR_NAMES = window.COLOR_NAMES || ["red", "green", "yellow", "blue", "purple"];

// ============================================================================
// Core game logic — ported faithfully from the C# (Board / MatchFinder /
// SeededRandom). Zero rendering concerns live in here.
// Convention: grid is grid[x][y], y=0 is the BOTTOM row. Tiles fall toward y=0.
// ============================================================================

const EMPTY = -1;
const IDOL_BASE = 10;   // 10=Idol25, 11=Idol50, 12=Idol75, 13=Idol100
const IDOL_LEVELS = 4;
const LINE_H_BASE = IDOL_BASE + IDOL_LEVELS; // horizontal stripe (color 0..4)
const LINE_V_BASE = LINE_H_BASE + 5; // vertical stripe (color 0..4)
const GEM = LINE_V_BASE + 5;         // drop objective — falls to exit tiles
const SAFE_BASE = GEM + 1;           // 25=Safe L1, 26=L2, 27=L3
const SAFE_LEVELS = 3;

function baseColor(c) {
  if (c === EMPTY || isIdol(c) || isSafe(c) || isGem(c)) return -1;
  if (isLineH(c)) return c - LINE_H_BASE;
  if (isLineV(c)) return c - LINE_V_BASE;
  return c;
}
function isIdol(c) { return c >= IDOL_BASE && c < IDOL_BASE + IDOL_LEVELS; }
function idolLevel(c) { return c - IDOL_BASE + 1; }
function toIdol(level) { return IDOL_BASE + level - 1; }
const isChain = isIdol;
const chainLevel = idolLevel;
const toChain = toIdol;
function isLineH(c) { return c >= LINE_H_BASE && c < LINE_V_BASE; }
function isLineV(c) { return c >= LINE_V_BASE && c < LINE_V_BASE + 5; }
function toLineH(color) { return LINE_H_BASE + color; }
function toLineV(color) { return LINE_V_BASE + color; }
function isGem(c) { return c === GEM; }
function isSafe(c) { return c >= SAFE_BASE && c < SAFE_BASE + SAFE_LEVELS; }
function safeLevel(c) { return c - SAFE_BASE + 1; }
function toSafe(level) { return SAFE_BASE + level - 1; }
function isImmovable(c) { return isIdol(c) || isSafe(c) || isGem(c); }
function isMatchable(c) { return c !== EMPTY && !isIdol(c) && !isSafe(c) && !isGem(c); }
function isVoidCell(b, x, y) {
  return b && b.voidCells && b.voidCells.has(x + "," + y);
}
function cellBlocksMatch(grid, x, y, voidCells) {
  if (voidCells && voidCells.has(x + "," + y)) return true;
  return !isMatchable(grid[x][y]);
}

function clearTileAt(b, x, y) {
  const c = b.grid[x][y];
  if (c === EMPTY) return;
  if (isIdol(c)) b.grid[x][y] = idolLevel(c) <= 1 ? EMPTY : c - 1;
  else if (isSafe(c)) b.grid[x][y] = safeLevel(c) <= 1 ? EMPTY : c - 1;
  else b.grid[x][y] = EMPTY;
}

// Stripe/line blast removes idols and candies in one hit.
function clearWaveCell(b, x, y) {
  const c = b.grid[x][y];
  if (c === EMPTY) return;
  if (isIdol(c)) {
    const lvl = idolLevel(c);
    b.grid[x][y] = EMPTY;
    onIdolDamaged(true);
    triggerIdolHit(x, y, true, lvl);
    return;
  }
  if (isSafe(c)) {
    b.grid[x][y] = EMPTY;
    onSafeDamaged(true);
    triggerSafeHit(x, y, true, safeLevel(c));
    return;
  }
  b.grid[x][y] = EMPTY;
}

function applyWaveClears(keys, snap) {
  for (const key of keys) {
    const [x, y] = key.split(",").map(Number);
    if (snap && snap.get(key) === EMPTY) continue;
    clearWaveCell(board, x, y);
  }
}

function waveOrderAlongRow(x0, y, width) {
  const out = [{ x: x0, y }];
  for (let d = 1; d < width; d++) {
    if (x0 + d < width) out.push({ x: x0 + d, y });
    if (x0 - d >= 0) out.push({ x: x0 - d, y });
  }
  return out;
}

function waveOrderAlongCol(x, y0, height) {
  const out = [{ x, y: y0 }];
  for (let d = 1; d < height; d++) {
    if (y0 + d < height) out.push({ x, y: y0 + d });
    if (y0 - d >= 0) out.push({ x, y: y0 - d });
  }
  return out;
}

// Row/column wave from each stripe trigger; chaining if the wave hits another stripe.
function collectLineWaveCells(initialTriggers, grid, width, height, voidCells) {
  const ordered = [];
  const seen = new Set();
  const processed = new Set();
  const queue = initialTriggers.map((t) => ({ ...t }));

  while (queue.length > 0) {
    const { x, y, horizontal } = queue.shift();
    const tk = x + "," + y;
    if (processed.has(tk)) continue;
    processed.add(tk);
    const seq = horizontal
      ? waveOrderAlongRow(x, y, width)
      : waveOrderAlongCol(x, y, height);
    for (const cell of seq) {
      const k = cell.x + "," + cell.y;
      if (seen.has(k)) continue;
      if (voidCells && voidCells.has(k)) continue;
      seen.add(k);
      ordered.push(k);
      const tile = grid[cell.x][cell.y];
      if ((isLineH(tile) || isLineV(tile)) && !processed.has(k)) {
        queue.push({
          x: cell.x,
          y: cell.y,
          horizontal: isLineH(tile),
        });
      }
    }
  }
  return ordered;
}

function sameTile(a, b) {
  return isMatchable(a) && isMatchable(b) && baseColor(a) === baseColor(b);
}

// mulberry32 — deterministic: same seed => same sequence.
class SeededRandom {
  constructor(seed) { this.state = seed >>> 0; }
  nextUInt() {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }
  next(maxExclusive) { return this.nextUInt() % maxExclusive; }
}

// Returns the set of "x,y" cells that are part of any horizontal/vertical 3+ run.
function findMatches(grid, width, height, voidCells) {
  const matched = new Set();

  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      if (cellBlocksMatch(grid, x, y, voidCells)) { x++; continue; }
      const runStart = x;
      x++;
      while (x < width && !cellBlocksMatch(grid, x, y, voidCells) &&
        sameTile(grid[x][y], grid[runStart][y])) x++;
      if (x - runStart >= 3)
        for (let k = runStart; k < x; k++) matched.add(k + "," + y);
    }
  }

  for (let x = 0; x < width; x++) {
    let y = 0;
    while (y < height) {
      if (cellBlocksMatch(grid, x, y, voidCells)) { y++; continue; }
      const runStart = y;
      y++;
      while (y < height && !cellBlocksMatch(grid, x, y, voidCells) &&
        sameTile(grid[x][y], grid[x][runStart])) y++;
      if (y - runStart >= 3)
        for (let k = runStart; k < y; k++) matched.add(x + "," + k);
    }
  }

  return matched;
}

class Board {
  constructor(width, height, colorCount, seed, voidCells) {
    this.width = width;
    this.height = height;
    this.colorCount = colorCount;
    this.rng = new SeededRandom(seed);
    this.voidCells = voidCells || new Set();
    this.exitCells = new Set();
    this.pathCells = new Set();
    this.pillows = Array.from({ length: width }, () => new Array(height).fill(0));
    this.grid = Array.from({ length: width }, () => new Array(height).fill(EMPTY));

    this.fillNoMatches();
    let safety = 0;
    while (!this.hasValidMove() && safety++ < 50) this.fillNoMatches();
  }

  get(x, y) { return this.grid[x][y]; }

  // Fill so NO 3-in-a-row exists at start (avoid colors that complete a run).
  fillNoMatches() {
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        if (isVoidCell(this, x, y)) {
          this.grid[x][y] = EMPTY;
          continue;
        }
        const cur = this.grid[x][y];
        if (isImmovable(cur) || isLineH(cur) || isLineV(cur)) continue;
        let color;
        do {
          color = this.rng.next(this.colorCount);
        } while (
          (x >= 2 && !isVoidCell(this, x - 1, y) && !isVoidCell(this, x - 2, y) &&
            this.grid[x - 1][y] === color && this.grid[x - 2][y] === color) ||
          (y >= 2 && !isVoidCell(this, x, y - 1) && !isVoidCell(this, x, y - 2) &&
            this.grid[x][y - 1] === color && this.grid[x][y - 2] === color)
        );
        this.grid[x][y] = color;
      }
    }
  }

  isAdjacent(ax, ay, bx, by) {
    return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
  }

  swap(ax, ay, bx, by) {
    const tmp = this.grid[ax][ay];
    this.grid[ax][ay] = this.grid[bx][by];
    this.grid[bx][by] = tmp;
  }

  // Swap two adjacent tiles. Keep it only if it creates a match. Idols never move.
  trySwap(ax, ay, bx, by) {
    if (!this.isAdjacent(ax, ay, bx, by)) return false;
    if (isVoidCell(this, ax, ay) || isVoidCell(this, bx, by)) return false;
    if (isImmovable(this.grid[ax][ay]) || isImmovable(this.grid[bx][by])) return false;
    this.swap(ax, ay, bx, by);
    if (findMatches(this.grid, this.width, this.height, this.voidCells).size > 0) return true;
    this.swap(ax, ay, bx, by); // revert
    return false;
  }

  // ONE resolution pass: clear matches, gravity, refill. Returns tiles cleared.
  resolveStep() {
    const matched = findMatches(this.grid, this.width, this.height, this.voidCells);
    if (matched.size === 0) return 0;
    for (const key of matched) {
      const [x, y] = key.split(",").map(Number);
      this.grid[x][y] = EMPTY;
    }
    this.applyGravity();
    this.refill();
    return matched.size;
  }

  columnSlots(x) {
    const slots = [];
    for (let y = 0; y < this.height; y++)
      if (!isVoidCell(this, x, y)) slots.push(y);
    return slots;
  }

  applyGravity() {
    for (let x = 0; x < this.width; x++) {
      const slots = this.columnSlots(x);
      const tiles = [];
      for (const y of slots)
        if (this.grid[x][y] !== EMPTY) tiles.push(this.grid[x][y]);
      for (const y of slots) this.grid[x][y] = EMPTY;
      for (let i = 0; i < tiles.length; i++) this.grid[x][slots[i]] = tiles[i];
    }
  }

  refill() {
    for (let x = 0; x < this.width; x++)
      for (let y = 0; y < this.height; y++)
        if (!isVoidCell(this, x, y) && this.grid[x][y] === EMPTY)
          this.grid[x][y] = this.rng.next(this.colorCount);
  }

  // ---- Animation-friendly variants -------------------------------------
  // Same mechanics as resolveStep(), but split into observable steps that
  // report what moved/spawned so the renderer can tween candies.

  clearMatches(matched) {
    for (const key of matched) {
      const [x, y] = key.split(",").map(Number);
      this.grid[x][y] = EMPTY;
    }
  }

  // When a match/wave clears next to an idol or safe, damage it one tier.
  damageAdjacentChains(matched) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const hit = new Set();
    for (const key of matched) {
      const [x, y] = key.split(",").map(Number);
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
        if (isVoidCell(this, nx, ny)) continue;
        const nc = this.grid[nx][ny];
        if (isIdol(nc) || isSafe(nc)) hit.add(nx + "," + ny);
      }
    }
    for (const key of hit) {
      const [x, y] = key.split(",").map(Number);
      const c = this.grid[x][y];
      if (isIdol(c)) {
        const before = idolLevel(c);
        const removed = before <= 1;
        this.grid[x][y] = removed ? EMPTY : c - 1;
        if (typeof onIdolDamaged === "function") onIdolDamaged(removed);
        triggerIdolHit(x, y, removed, before);
      } else if (isSafe(c)) {
        const before = safeLevel(c);
        const removed = before <= 1;
        this.grid[x][y] = removed ? EMPTY : c - 1;
        if (typeof onSafeDamaged === "function") onSafeDamaged(removed);
        triggerSafeHit(x, y, removed, before);
      }
    }
  }

  applyGravityMapped(opts) {
    const skipColumns = opts && opts.skipColumns ? opts.skipColumns : null;
    const moves = [];
    for (let x = 0; x < this.width; x++) {
      if (skipColumns && skipColumns.has(x)) continue;
      const slots = this.columnSlots(x);
      const segments = [];
      let seg = [];
      for (const y of slots) {
        if (isGravityBlocked(x, y)) {
          if (seg.length) { segments.push(seg); seg = []; }
        } else {
          seg.push(y);
        }
      }
      if (seg.length) segments.push(seg);

      for (const segment of segments) {
        const tiles = [];
        const fromYs = [];
        for (const y of segment) {
          if (this.grid[x][y] !== EMPTY) {
            tiles.push(this.grid[x][y]);
            fromYs.push(y);
          }
        }
        for (const y of segment) this.grid[x][y] = EMPTY;
        for (let i = 0; i < tiles.length; i++) {
          const toY = segment[i];
          if (fromYs[i] !== toY) moves.push({ x, fromY: fromYs[i], toY, color: tiles[i] });
          this.grid[x][toY] = tiles[i];
        }
      }
    }
    return moves;
  }

  refillMapped(opts) {
    const skipColumns = opts && opts.skipColumns ? opts.skipColumns : null;
    const spawns = [];
    for (let x = 0; x < this.width; x++) {
      if (skipColumns && skipColumns.has(x)) continue;
      const slots = this.columnSlots(x);
      let nEmpty = 0;
      for (const y of slots)
        if (this.grid[x][y] === EMPTY) nEmpty++;
      if (nEmpty === 0) continue;
      let spawned = 0;
      for (const y of slots) {
        if (this.grid[x][y] === EMPTY && !isGravityBlocked(x, y)) {
          const color = this.rng.next(this.colorCount);
          this.grid[x][y] = color;
          spawns.push({ x, y, color, startY: y + (nEmpty - spawned) });
          spawned++;
        }
      }
    }
    return spawns;
  }

  hasValidMove() {
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        if (isVoidCell(this, x, y) || isImmovable(this.grid[x][y])) continue;
        if (x + 1 < this.width && !isVoidCell(this, x + 1, y) &&
          !isImmovable(this.grid[x + 1][y]) && this.wouldMatch(x, y, x + 1, y)) return true;
        if (y + 1 < this.height && !isVoidCell(this, x, y + 1) &&
          !isImmovable(this.grid[x][y + 1]) && this.wouldMatch(x, y, x, y + 1)) return true;
      }
    }
    return false;
  }

  wouldMatch(ax, ay, bx, by) {
    this.swap(ax, ay, bx, by);
    const ok = findMatches(this.grid, this.width, this.height, this.voidCells).size > 0;
    this.swap(ax, ay, bx, by);
    return ok;
  }

  findHint() {
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        if (isVoidCell(this, x, y) || isImmovable(this.grid[x][y])) continue;
        if (x + 1 < this.width && !isVoidCell(this, x + 1, y) &&
          !isImmovable(this.grid[x + 1][y]) && this.wouldMatch(x, y, x + 1, y))
          return [{ x, y }, { x: x + 1, y }];
        if (y + 1 < this.height && !isVoidCell(this, x, y + 1) &&
          !isImmovable(this.grid[x][y + 1]) && this.wouldMatch(x, y, x, y + 1))
          return [{ x, y }, { x, y: y + 1 }];
      }
    }
    return null;
  }

  reshuffle() {
    let safety = 0;
    do { this.fillNoMatches(); }
    while (
      (findMatches(this.grid, this.width, this.height, this.voidCells).size > 0 || !this.hasValidMove())
      && safety++ < 50
    );
  }
}

// ============================================================================
// Rendering + input — the only part that touches the DOM/canvas.
// ============================================================================

// WIDTH/HEIGHT are mutable: the grid grows with the level (see levelConfig).
// COLOR_COUNT stays 5 so every color/sprite is always in play.
let WIDTH = 8, HEIGHT = 8;
const COLOR_COUNT = 5;
const CELL = 56;
const GAP = 4;
const CELL_DRAW_SIZE = CELL - GAP;
const SPRITE_INSET = 5;
const SPRITE_SIZE = CELL_DRAW_SIZE - SPRITE_INSET * 2;
const SPRITE_MAX_SIZE = CELL_DRAW_SIZE - 2;

// Each "color" is now an image. Index order is fixed: the board stores these
// indices, IMAGE_FILES[i] is the sprite drawn for tile i, and SPARKLE_COLORS[i]
// is the matching spark color used by the particle burst on a clear.
const IMAGE_FILES = [
  "images/colors/red.png",    // 0 red
  "images/colors/green.png",  // 1 green
  "images/colors/yellow.png", // 2 yellow
  "images/colors/blue.png",   // 3 blue
  "images/colors/purple.png", // 4 purple
];
const SPARKLE_COLORS = [
  "#e84d57", // red
  "#66cc73", // green
  "#f7ed5c", // yellow
  "#599ef0", // blue
  "#b373e0", // purple
];
const IMAGES = IMAGE_FILES.map((src) => { const im = new Image(); im.src = src; return im; });
const IDOL_IMAGE_FILES = [
  "images/idols/Idol25.png",
  "images/idols/Idol50.png",
  "images/idols/Idol75.png",
  "images/idols/Idol100.png"
];
const IDOL_IMAGES = IDOL_IMAGE_FILES.map((src) => { const im = new Image(); im.src = src; return im; });
const CHAIN_IMAGES = IDOL_IMAGES;
const SAFE_IMAGE_FILES = [
  "images/safe/Safe1.png",
  "images/safe/Safe2.png",
  "images/safe/Safe3.png",
];
const SAFE_IMAGES = SAFE_IMAGE_FILES.map((src) => { const im = new Image(); im.src = src; return im; });
const goldBarImg = new Image();
goldBarImg.src = "images/safe/GoldBar.png";
const SAFE_DEATH_MS = 600;
const SAFE_DEATH_COVER_SCALE = (CELL * 3.1) / SPRITE_SIZE;
const pillowImg = new Image();
pillowImg.src = "images/items/pillow.png";
const rocksImg = new Image();
rocksImg.src = "images/items/rocks.png";
const keyedRocksCanvas = document.createElement("canvas");
const keyedRocksCtx = keyedRocksCanvas.getContext("2d");
let rocksLoaded = false;

function processRocks() {
  if (rocksLoaded) return;
  if (!rocksImg.complete || rocksImg.naturalWidth === 0) return;
  keyedRocksCanvas.width = rocksImg.naturalWidth;
  keyedRocksCanvas.height = rocksImg.naturalHeight;
  keyedRocksCtx.drawImage(rocksImg, 0, 0);
  try {
    const imgData = keyedRocksCtx.getImageData(0, 0, keyedRocksCanvas.width, keyedRocksCanvas.height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i+1];
      const b = data[i+2];
      const maxVal = Math.max(r, g, b);
      if (maxVal < 15) {
        data[i+3] = 0;
      } else if (maxVal < 35) {
        const ratio = (maxVal - 15) / 20;
        data[i+3] = Math.round(data[i+3] * ratio);
      }
    }
    keyedRocksCtx.putImageData(imgData, 0, 0);
    rocksLoaded = true;
  } catch (e) {
    console.error("Error keying out black from rocks.png", e);
    rocksLoaded = true;
  }
}
rocksImg.onload = processRocks;
if (rocksImg.complete) {
  processRocks();
}
const HLINE_IMAGE_FILES = [
  "HorizontalLines/red.png",
  "HorizontalLines/green.png",
  "HorizontalLines/yellow.png",
  "HorizontalLines/blue.png",
  "HorizontalLines/Purple.png",
];
const VLINE_IMAGE_FILES = [
  "VerticalLines/red.png",
  "VerticalLines/green.png",
  "VerticalLines/yellow.png",
  "VerticalLines/blue.png",
  "VerticalLines/purple.png",
];
const HLINE_IMAGES = HLINE_IMAGE_FILES.map((src) => { const im = new Image(); im.src = src; return im; });
const VLINE_IMAGES = VLINE_IMAGE_FILES.map((src) => { const im = new Image(); im.src = src; return im; });

// The page uses one fixed backdrop (bg1). Preload it up front for both layouts
// so the body never flashes an empty backdrop before the CSS url() resolves.
const BG_IMAGE = "bg1";
const BG_PRELOAD = [
  `images/backgroundImages/Desktop/${BG_IMAGE}.png`,
  `images/backgroundImages/mobile/${BG_IMAGE}.png`,
].map((src) => { const im = new Image(); im.src = src; return im; });

function shufflePool(pool, rng) {
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.next(i + 1);
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
}

function candyPool(b) {
  const pool = [];
  for (let x = 0; x < b.width; x++)
    for (let y = 0; y < b.height; y++) {
      if (isVoidCell(b, x, y)) continue;
      const c = b.grid[x][y];
      if (c >= 0 && c < COLOR_COUNT) pool.push(x + "," + y);
    }
  return pool;
}

function countChainsOnBoard(b) {
  let n = 0;
  for (let x = 0; x < b.width; x++)
    for (let y = 0; y < b.height; y++)
      if (isIdol(b.grid[x][y])) n++;
  return n;
}
const countIdolsOnBoard = countChainsOnBoard;

function countSafesOnBoard(b) {
  let n = 0;
  for (let x = 0; x < b.width; x++)
    for (let y = 0; y < b.height; y++)
      if (isSafe(b.grid[x][y])) n++;
  return n;
}

function distributeSafes(total, arena, finale, progress) {
  const s = { s1: 0, s2: 0, s3: 0 };
  if (total <= 0) return s;
  const p = progress || 0;
  if (arena <= 2) {
    s.s1 = total;
  } else if (arena === 3) {
    s.s3 = finale ? Math.max(1, Math.floor(total * 0.15)) : (p > 0.6 ? Math.floor(total * 0.1) : 0);
    s.s2 = Math.floor(total * (finale ? 0.35 : 0.28 + p * 0.12));
    s.s1 = Math.max(0, total - s.s2 - s.s3);
  } else {
    s.s3 = Math.floor(total * (finale ? 0.28 : 0.12 + p * 0.1));
    s.s2 = Math.floor(total * (finale ? 0.38 : 0.3));
    s.s1 = Math.max(0, total - s.s2 - s.s3);
  }
  return s;
}

function placeSafes(b, safes) {
  const tiers = [];
  for (let i = 0; i < (safes.s3 || 0); i++) tiers.push(3);
  for (let i = 0; i < (safes.s2 || 0); i++) tiers.push(2);
  for (let i = 0; i < (safes.s1 || 0); i++) tiers.push(1);
  if (tiers.length === 0) return;
  const pool = candyPool(b).filter((key) => {
    const [x, y] = key.split(",").map(Number);
    return !isIdol(b.grid[x][y]) && !isSafe(b.grid[x][y]);
  });
  shufflePool(pool, b.rng);
  let placed = 0;
  for (let i = 0; i < pool.length && placed < tiers.length; i++) {
    const [x, y] = pool[i].split(",").map(Number);
    const old = b.grid[x][y];
    b.grid[x][y] = toSafe(tiers[placed]);
    if (findMatches(b.grid, b.width, b.height, b.voidCells).size > 0) {
      b.grid[x][y] = old;
      continue;
    }
    placed++;
  }
}

function placeLevelSafes(b) {
  if (!currentLevelCfg) return;
  const safes = currentLevelCfg.safes || {};
  const total = (safes.s1 || 0) + (safes.s2 || 0) + (safes.s3 || 0);
  if (total <= 0) return;
  placeSafes(b, safes);
}

// Idols only spawn inside fixed zones (never scattered). y=0 is the bottom row.
function chainPlacementPool(b, pattern) {
  const keys = [];
  const w = b.width, h = b.height;
  const add = (x, y) => {
    if (x >= 0 && x < w && y >= 0 && y < h && !isVoidCell(b, x, y)) keys.push(x + "," + y);
  };
  const bottomThrough = (pct) => {
    const maxY = Math.max(0, Math.ceil(h * pct) - 1);
    for (let y = 0; y <= maxY; y++)
      for (let x = 0; x < w; x++) add(x, y);
  };
  const topBandFree = (pct) => {
    const chainBelowY = Math.ceil(h * (1 - pct));
    for (let y = 0; y < chainBelowY; y++)
      for (let x = 0; x < w; x++) add(x, y);
  };

  if (pattern === "bottom2") {
    for (let y = 0; y < Math.min(2, h); y++)
      for (let x = 0; x < w; x++) add(x, y);
  } else if (pattern === "bottom3") {
    for (let y = 0; y < Math.min(3, h); y++)
      for (let x = 0; x < w; x++) add(x, y);
  } else if (pattern === "bottomSides") {
    for (let y = 0; y < Math.min(2, h); y++)
      for (let x = 0; x < w; x++) add(x, y);
    for (let y = 2; y < h; y++) { add(0, y); add(w - 1, y); }
  } else if (pattern === "bottomHeavy") {
    for (let y = 0; y < Math.min(3, h); y++)
      for (let x = 0; x < w; x++) add(x, y);
    for (let y = 3; y < Math.ceil(h * 0.55); y++) { add(0, y); add(w - 1, y); }
  } else if (pattern === "bottom70") {
    bottomThrough(0.7);
  } else if (pattern === "bottom75") {
    bottomThrough(0.75);
  } else if (pattern === "bottom80") {
    bottomThrough(0.8);
  } else if (pattern === "bottom85") {
    bottomThrough(0.85);
  } else if (pattern === "topBand20") {
    topBandFree(0.2);
  } else if (pattern === "topBand25") {
    topBandFree(0.25);
  } else if (pattern === "bottomSplit") {
    const maxY = Math.max(0, Math.ceil(h * 0.8) - 1);
    const mid = Math.floor(w / 2);
    const ventY = Math.ceil(h * 0.55);
    for (let y = 0; y <= maxY; y++)
      for (let x = 0; x < w; x++) {
        if (x === mid && y >= ventY) continue;
        add(x, y);
      }
  } else if (pattern === "bottomWings") {
    const maxY = Math.max(0, Math.ceil(h * 0.78) - 1);
    const l = Math.max(1, Math.floor(w * 0.28));
    const r = Math.min(w - 2, Math.floor(w * 0.72));
    for (let y = 0; y <= maxY; y++)
      for (let x = 0; x < w; x++)
        if (x <= l || x >= r || y < Math.min(3, h)) add(x, y);
  } else if (pattern === "bottomMoat") {
    for (let y = 0; y < Math.min(3, h); y++)
      for (let x = 0; x < w; x++) add(x, y);
    const maxY = Math.max(3, Math.ceil(h * 0.72) - 1);
    for (let y = 3; y <= maxY; y++) { add(0, y); add(w - 1, y); }
    for (let y = 3; y <= maxY; y++)
      for (let x = 1; x < w - 1; x++) add(x, y);
  } else if (pattern === "bottomCorridor") {
    const maxY = Math.max(0, Math.ceil(h * 0.75) - 1);
    const l = Math.max(0, Math.floor(w * 0.22));
    const r = Math.min(w - 1, Math.floor(w * 0.78));
    for (let y = 0; y <= maxY; y++)
      for (let x = 0; x < w; x++)
        if (x <= l || x >= r) add(x, y);
  } else if (pattern === "lowerWalls") {
    const maxY = Math.max(0, Math.ceil(h * 0.82) - 1);
    for (let y = 0; y <= maxY; y++) { add(0, y); add(w - 1, y); }
    for (let y = 0; y < Math.min(2, h); y++)
      for (let x = 1; x < w - 1; x++) add(x, y);
  } else if (pattern === "walls") {
    const maxY = Math.max(0, Math.ceil(h * 0.85) - 1);
    for (let y = 0; y <= maxY; y++) { add(0, y); add(w - 1, y); }
    for (let y = 0; y < Math.min(2, h); y++)
      for (let x = 1; x < w - 1; x++) add(x, y);
  } else if (pattern === "finale") {
    bottomThrough(0.88);
  } else if (pattern === "arena5pit") {
    topBandFree(0.15);
  }
  return keys;
}

const ARENA2_IDOL_PATTERNS = [
  "bottom2", "bottom3", "bottomSides", "bottomHeavy", "bottomSides",
  "bottom3", "bottomHeavy", "bottomMoat", "bottomCorridor", "bottomHeavy",
  "bottomSides", "bottom3", "bottomWings", "bottomHeavy", "bottomMoat",
  "bottomCorridor", "bottomHeavy", "bottomSides", "bottom3", "finale",
];

const ARENA3_IDOL_PATTERNS = [
  "bottom70", "bottom80", "topBand20", "bottom75", "bottomWings",
  "bottomSplit", "bottomMoat", "bottom80", "topBand25", "bottomCorridor",
  "bottom85", "bottomSplit", "bottom75", "bottomWings", "bottom80",
  "bottomMoat", "bottomCorridor", "bottom85", "bottom80", "finale",
];

const ARENA4_IDOL_PATTERNS = [
  "bottom75", "lowerWalls", "bottom80", "bottomSplit", "bottomMoat",
  "topBand25", "bottomCorridor", "bottom85", "bottomWings", "lowerWalls",
  "bottom80", "bottomSplit", "bottom75", "bottomMoat", "topBand20",
  "bottomCorridor", "lowerWalls", "bottom85", "bottom80", "finale",
];

const ARENA5_IDOL_PATTERNS = [
  "arena5pit", "bottom85", "bottomCorridor", "arena5pit", "bottomSplit",
  "lowerWalls", "bottom85", "bottomMoat", "arena5pit", "bottom80",
  "bottomWings", "lowerWalls", "bottom85", "bottomSplit", "arena5pit",
  "bottomMoat", "bottomCorridor", "bottom85", "bottom80", "finale",
];

function chainPlacementForArena(arena, slot, finale) {
  const idx = Math.min(19, Math.max(0, slot - 1));
  if (arena === 2) return finale ? "finale" : ARENA2_IDOL_PATTERNS[idx];
  if (arena === 3) return finale ? "finale" : ARENA3_IDOL_PATTERNS[idx];
  if (arena === 4) return finale ? "finale" : ARENA4_IDOL_PATTERNS[idx];
  if (arena === 5) return finale ? "arena5pit" : ARENA5_IDOL_PATTERNS[idx];
  return "bottom80";
}

function chainPlacementForArena2(slot, finale) {
  return chainPlacementForArena(2, slot, finale);
}

function orderedChainPool(b, pattern, seed) {
  const keys = chainPlacementPool(b, pattern);
  const byY = {};
  for (const k of keys) {
    const [x, y] = k.split(",").map(Number);
    if (!byY[y]) byY[y] = [];
    byY[y].push(k);
  }
  const out = [];
  const ys = Object.keys(byY).map(Number).sort((a, b) => a - b);
  for (const y of ys) {
    const row = byY[y];
    const rng = { next: (m) => ((seed + y * 31 + row.length) % m) };
    shufflePool(row, rng);
    out.push(...row);
  }
  return out;
}

function placeChainsStrategic(b, chains, pattern, levelSeed) {
  const tiers = [];
  for (let i = 0; i < (chains.c4 || 0); i++) tiers.push(4);
  for (let i = 0; i < (chains.c3 || 0); i++) tiers.push(3);
  for (let i = 0; i < (chains.c2 || 0); i++) tiers.push(2);
  for (let i = 0; i < (chains.c1 || 0); i++) tiers.push(1);
  if (tiers.length === 0) return;
  const seed = levelSeed || 0;
  const pool = orderedChainPool(b, pattern, seed).filter((key) => {
    const [x, y] = key.split(",").map(Number);
    const c = b.grid[x][y];
    return c >= 0 && c < COLOR_COUNT;
  });
  let placed = 0;
  for (let i = 0; i < pool.length && placed < tiers.length; i++) {
    const [x, y] = pool[i].split(",").map(Number);
    const old = b.grid[x][y];
    b.grid[x][y] = toIdol(tiers[placed]);
    if (findMatches(b.grid, b.width, b.height, b.voidCells).size > 0) {
      b.grid[x][y] = old;
      continue;
    }
    placed++;
  }
}

function placeChains(b, chains) {
  const tiers = [];
  for (let i = 0; i < (chains.c4 || 0); i++) tiers.push(4);
  for (let i = 0; i < (chains.c3 || 0); i++) tiers.push(3);
  for (let i = 0; i < (chains.c2 || 0); i++) tiers.push(2);
  for (let i = 0; i < (chains.c1 || 0); i++) tiers.push(1);
  if (tiers.length === 0) return;
  const pool = candyPool(b);
  shufflePool(pool, b.rng);
  let placed = 0;
  for (let i = 0; i < pool.length && placed < tiers.length; i++) {
    const [x, y] = pool[i].split(",").map(Number);
    const old = b.grid[x][y];
    b.grid[x][y] = toIdol(tiers[placed]);
    if (findMatches(b.grid, b.width, b.height, b.voidCells).size > 0) b.grid[x][y] = old;
    else placed++;
  }
}

function placeLinePowers(b, minN, maxN) {
  const n = minN + (maxN > minN ? b.rng.next(maxN - minN + 1) : 0);
  const pool = candyPool(b);
  shufflePool(pool, b.rng);
  let placed = 0;
  for (let i = 0; i < pool.length && placed < n; i++) {
    const [x, y] = pool[i].split(",").map(Number);
    const color = b.rng.next(COLOR_COUNT);
    const tile = b.rng.next(2) === 0 ? toLineH(color) : toLineV(color);
    const old = b.grid[x][y];
    b.grid[x][y] = tile;
    if (findMatches(b.grid, b.width, b.height, b.voidCells).size > 0) b.grid[x][y] = old;
    else placed++;
  }
}

function placeLevelChains(b) {
  if (!currentLevelCfg) return;
  const chains = currentLevelCfg.idols || currentLevelCfg.chains || {};
  const total =
    (chains.c1 || 0) +
    (chains.c2 || 0) +
    (chains.c3 || 0) +
    (chains.c4 || 0);
  if (total <= 0) return;
  const pattern =
    currentLevelCfg.idolPlacement ||
    currentLevelCfg.chainPlacement ||
    chainPlacementForArena(currentLevelCfg.arena || 1, currentLevelCfg.slot || 1, !!currentLevelCfg.finale);
  placeChainsStrategic(b, chains, pattern, currentLevel || 1);
}

function applyPillows(b, pillows) {
  if (!pillows || !b.pillows) return;
  for (const p of pillows) {
    if (!isVoidCell(b, p.x, p.y)) b.pillows[p.x][p.y] = p.layers;
  }
}

function applyPathBlockers(b, pathCfg, chains) {
  if (!pathCfg || !pathCfg.cells) return;
  chains = chains || {};
  b.pathCells = new Set(pathCfg.cells);
  const blockN = Math.ceil(pathCfg.cells.length * (pathCfg.block || 0.6));
  const pool = pathCfg.cells.filter((k) => {
    const [x, y] = k.split(",").map(Number);
    return b.grid[x][y] >= 0 && b.grid[x][y] < COLOR_COUNT;
  });
  shufflePool(pool, b.rng);
  let placed = 0;
  const tiers = [];
  for (let i = 0; i < (chains.c4 || 0); i++) tiers.push(4);
  for (let i = 0; i < (chains.c3 || 0); i++) tiers.push(3);
  for (let i = 0; i < (chains.c2 || 0); i++) tiers.push(2);
  for (let i = 0; i < (chains.c1 || 0); i++) tiers.push(1);
  for (let i = 0; i < pool.length && placed < Math.min(blockN, tiers.length); i++) {
    const [x, y] = pool[i].split(",").map(Number);
    const old = b.grid[x][y];
    b.grid[x][y] = toIdol(tiers[placed]);
    if (findMatches(b.grid, b.width, b.height, b.voidCells).size > 0) b.grid[x][y] = old;
    else placed++;
  }
}

function placeDropGems(b, drops) {
  if (!drops || drops.count <= 0) return;
  b.exitCells = new Set(drops.exits || []);
  const tops = [];
  for (let x = 0; x < b.width; x++) {
    for (let y = b.height - 1; y >= 0; y--) {
      if (!isVoidCell(b, x, y) && b.grid[x][y] >= 0 && b.grid[x][y] < COLOR_COUNT) {
        tops.push(x + "," + y);
        break;
      }
    }
  }
  shufflePool(tops, b.rng);
  let placed = 0;
  for (let i = 0; i < tops.length && placed < drops.count; i++) {
    const [x, y] = tops[i].split(",").map(Number);
    b.grid[x][y] = GEM;
    placed++;
  }
}

function setupLevelFeatures() {
  if (!currentLevelCfg) return;
  board.exitCells = new Set();
  board.pathCells = new Set();
  for (let x = 0; x < board.width; x++)
    for (let y = 0; y < board.height; y++) board.pillows[x][y] = 0;

  applyPillows(board, currentLevelCfg.pillows);
  if (currentLevelCfg.path) board.pathCells = new Set(currentLevelCfg.path.cells);
  placeLevelChains(board);
  placeLevelSafes(board);
  placeDropGems(board, currentLevelCfg.drops);
  placeLinePowers(board, currentLevelCfg.lines[0], currentLevelCfg.lines[1]);
  ensureBoardPlayable();
}

function ensureBoardPlayable() {
  let safety = 0;
  while (!board.hasValidMove() && safety++ < 50) {
    board.reshuffle();
    if (currentLevelCfg) {
      applyPillows(board, currentLevelCfg.pillows);
      if (currentLevelCfg.path) board.pathCells = new Set(currentLevelCfg.path.cells);
      placeLevelChains(board);
      placeLevelSafes(board);
      placeDropGems(board, currentLevelCfg.drops);
      placeLinePowers(board, currentLevelCfg.lines[0], currentLevelCfg.lines[1]);
    }
  }
}

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
let boardRenderScale = 1;

function renderDpr() {
  return Math.max(2, window.devicePixelRatio || 1);
}

function setCanvasQuality(context) {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
}

// Separate overlay canvas for sparkles + combo text, so it can animate freely
// on top of the board without being wiped by the board's per-frame redraws.
const fx = document.getElementById("fx");
const fxCtx = fx.getContext("2d");
const coinCanvas = document.getElementById("coin-fx");
const coinCtx = coinCanvas.getContext("2d");
const coinImg = new Image();
coinImg.src = "images/items/coin.png";
let coinRain = null;

function resizeCoinCanvas() {
  const dpr = renderDpr();
  coinCanvas.width = Math.floor(window.innerWidth * dpr);
  coinCanvas.height = Math.floor(window.innerHeight * dpr);
  coinCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  setCanvasQuality(coinCtx);
}
resizeCoinCanvas();

function clearCoinRain() {
  coinRain = null;
  flyingWalletCoins = [];
  coinCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

function spawnCoinRain() {
  resizeCoinCanvas();
  const w = window.innerWidth;
  const count = 50 + Math.floor(Math.random() * 51);
  coinRain = [];
  for (let i = 0; i < count; i++) {
    const size = 22 + Math.random() * 42;
    coinRain.push({
      x: Math.random() * w,
      y: -(30 + Math.random() * (window.innerHeight * 0.65 + 120)),
      vx: (Math.random() - 0.5) * 90,
      vy: 140 + Math.random() * 260,
      size,
      rot: Math.random() * Math.PI * 2,
      rotSpd: (Math.random() - 0.5) * 5.5,
      flipX: Math.random() < 0.5 ? -1 : 1,
      flipY: Math.random() < 0.5 ? -1 : 1,
    });
  }
}

function updateFlyingWalletCoins(now) {
  if (flyingWalletCoins.length === 0) return;
  const ready = coinImg.complete && coinImg.naturalWidth > 0;
  const aspect = ready ? coinImg.naturalWidth / coinImg.naturalHeight : 1;
  for (const c of flyingWalletCoins) {
    const t = Math.min(1, Math.max(0, (now - c.start) / c.duration));
    const e = 1 - Math.pow(1 - t, 2.2);
    const x = c.x + (c.tx - c.x) * e;
    const y = c.y + (c.ty - c.y) * e - Math.sin(t * Math.PI) * 32;
    const alpha = t < 0.1 ? t / 0.1 : 1;
    if (!ready) continue;
    const ch = c.size;
    const cw = ch * aspect;
    coinCtx.save();
    coinCtx.globalAlpha = alpha;
    coinCtx.drawImage(coinImg, x - cw / 2, y - ch / 2, cw, ch);
    coinCtx.restore();
  }
  flyingWalletCoins = flyingWalletCoins.filter((c) => now < c.start + c.duration);
}

function updateCoinRain(dt) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  coinCtx.clearRect(0, 0, w, h);
  updateFlyingWalletCoins(performance.now());

  if (!coinRain || coinRain.length === 0) {
    if (coinRain) clearCoinRain();
    return;
  }
  const ready = coinImg.complete && coinImg.naturalWidth > 0;
  const aspect = ready ? coinImg.naturalWidth / coinImg.naturalHeight : 1;

  for (const c of coinRain) {
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.rot += c.rotSpd * dt;
    if (c.y > h + c.size * 2) continue;
    if (!ready) continue;
    const ch = c.size;
    const cw = ch * aspect;
    coinCtx.save();
    coinCtx.translate(c.x, c.y);
    coinCtx.rotate(c.rot);
    coinCtx.scale(c.flipX, c.flipY);
    coinCtx.drawImage(coinImg, -cw / 2, -ch / 2, cw, ch);
    coinCtx.restore();
  }

  coinRain = coinRain.filter((c) => c.y <= h + c.size * 2);
  if (coinRain.length === 0) clearCoinRain();
}

function canvasCssSize() {
  const r = canvas.getBoundingClientRect();
  const logicalW = WIDTH * CELL;
  const logicalH = HEIGHT * CELL;
  return {
    width: Math.max(1, r.width || logicalW),
    height: Math.max(1, r.height || logicalH),
    logicalW,
    logicalH,
  };
}

// Size both canvases to the current rendered board. The game still draws in
// logical CELL units, but the backing bitmap now matches CSS pixels * DPR so
// the browser does not upscale a low-resolution canvas on large screens.
function resizeBoard() {
  const dpr = renderDpr();
  // Update the layout to the current grid FIRST, so the canvas is measured with
  // the right aspect ratio. Setting these after measuring would size the backing
  // bitmap and render scale against the previous level's (possibly different)
  // aspect ratio — which left sprites off-center and bled a partial column in on
  // the right whenever the grid was non-square.
  const gridOverlay = document.getElementById("grid-overlay");
  if (gridOverlay) {
    gridOverlay.style.setProperty("--cols", WIDTH);
    gridOverlay.style.setProperty("--rows", HEIGHT);
  }
  const wrap = document.getElementById("wrap");
  if (wrap) {
    wrap.style.aspectRatio = WIDTH + " / " + HEIGHT;
    // Size the board box explicitly to the largest WIDTH/HEIGHT-aspect rectangle
    // that fits the available area. Relying on CSS `width` + `max-height` let the
    // box become non-square when vertical space was tight (max-height clamped the
    // height but width stayed put), which rendered the board letterboxed and
    // top-left anchored while the grid overlay used the full width — so sprites
    // drifted left, accumulating per column. Computing both dimensions here keeps
    // the canvas at the exact grid aspect, so the draw scale is uniform and the
    // overlay boxes line up.
    const area = document.getElementById("board-area");
    if (area && area.clientWidth > 0 && area.clientHeight > 0) {
      const ratio = WIDTH / HEIGHT;
      let w = area.clientWidth;
      let h = w / ratio;
      if (h > area.clientHeight) {
        h = area.clientHeight;
        w = h * ratio;
      }
      wrap.style.width = w + "px";
      wrap.style.height = h + "px";
    }
  }
  // canvasCssSize() reads getBoundingClientRect(), which forces a synchronous
  // reflow, so the measurement reflects the size set just above.
  const size = canvasCssSize();
  boardRenderScale = Math.min(size.width / size.logicalW, size.height / size.logicalH);
  canvas.width = Math.ceil(size.width * dpr);
  canvas.height = Math.ceil(size.height * dpr);
  ctx.setTransform(boardRenderScale * dpr, 0, 0, boardRenderScale * dpr, 0, 0);
  setCanvasQuality(ctx);
  fx.width = canvas.width;
  fx.height = canvas.height;
  fxCtx.setTransform(boardRenderScale * dpr, 0, 0, boardRenderScale * dpr, 0, 0);
  setCanvasQuality(fxCtx);
}
resizeBoard();

function refreshResolution() {
  resizeCoinCanvas();
  resizeBoard();
  if (board) render();
}
window.addEventListener("resize", refreshResolution);
if (window.visualViewport) window.visualViewport.addEventListener("resize", refreshResolution);

const scoreEl = document.getElementById("score");
const movesEl = document.getElementById("moves");
const levelEl = document.getElementById("level");
const goalEl = document.getElementById("goal");
const overlay = document.getElementById("overlay");
const ovBig = document.getElementById("ovBig");
const ovSub = document.getElementById("ovSub");

let board, selX = -1, selY = -1, score = 0;
let movesLeft = 0, levelMoves = 0;
let gameOver = false, resolving = false, autoFinishing = false;
let boardAnimating = false;
let cascadePromise = null;
let levelGoalCelebrated = false;
let passCelebrationPending = false;
let lastMatchBoardX = 0, lastMatchBoardY = 0;
let flyingWalletCoins = [];
let seed = 12345;
let lastTs = 0;
let particles = [];      // active sparkle particles
let safeAnims = [];      // { x, y, type: 'pulse'|'death', level, start, dur }
let safeBlockers = new Set(); // "x,y" cells that block gravity during safe death
let idolAnims = [];      // { x, y, type: 'pulse'|'death', level, start, dur, rocksSpawned: false }
let idolBlockers = new Set(); // "x,y" cells that block gravity during idol death
let idolExplosions = []; // { x, y, start, dur } screen-space burst rings for idols
const IDOL_DEATH_MS = 250; // Faster death animation/blocker duration to be gone in an instant

function triggerIdolHit(x, y, removed, prevLevel) {
  const now = performance.now();
  idolAnims = idolAnims.filter((a) => !(a.x === x && a.y === y));
  if (removed) {
    idolBlockers.add(x + "," + y);
    // Spawn explosion and rocks immediately so they are gone in an instant
    spawnIdolExplosion(x, y);
    spawnIdolRocks(x, y);
    idolAnims.push({
      x, y, type: "death", level: prevLevel, start: now, dur: IDOL_DEATH_MS, rocksSpawned: true
    });
  } else {
    idolAnims.push({ x, y, type: "pulse", level: prevLevel, start: now, dur: 300 });
  }
}

function spawnIdolExplosion(x, y) {
  const cx = x * CELL + CELL / 2;
  const cy = (HEIGHT - 1 - y) * CELL + CELL / 2;
  idolExplosions.push({ x: cx, y: cy, start: performance.now(), dur: 250 }); // Faster expanding circle (250ms instead of 520ms)
}

function isGravityBlocked(x, y) {
  return safeBlockers.has(x + "," + y) || idolBlockers.has(x + "," + y);
}

function idolAnimAt(x, y, now) {
  const anim = idolAnims.find((a) => a.x === x && a.y === y && now - a.start < a.dur);
  if (!anim) return null;
  const progress = Math.min(1, (now - anim.start) / anim.dur);
  if (anim.type === "pulse") {
    const pulse = 1 + 0.15 * Math.sin(progress * Math.PI);
    return { type: "pulse", scale: pulse, dx: 0, dy: 0, alpha: 1, level: anim.level };
  }
  const scale = 1.0 + progress;
  const shakeRamp = Math.pow(progress, 2.5);
  const amp = shakeRamp * CELL * 0.08;
  const elapsed = now - anim.start;
  const freqX = 40 + 120 * progress;
  const freqY = 46 + 130 * progress;
  const shakeX = Math.sin(elapsed * 0.001 * freqX) * amp;
  const shakeY = Math.cos(elapsed * 0.001 * freqY) * amp;
  let alpha = 1;
  if (progress > 0.85) {
    alpha = (1 - progress) / 0.15;
  }
  return { type: "death", scale, dx: shakeX, dy: shakeY, alpha, level: anim.level };
}
let safeExplosions = []; // { x, y, start, dur } screen-space burst rings
let safeBlastCenters = []; // { x, y } safes that just exploded — their neighbors get killed
let comboPopup = null;   // { text, start } for the "Double/Triple" pop
const COMBO_BONUS_MS = 6000;
let comboBonusUntil = 0; // perf-now deadline for the bonus window
let comboBonusPct = 0;   // active bonus rate (0.20 = +20%, etc.)
let lastActivity = 0;    // perf-now of the last input; drives the idle hint
let hint = null;         // { cells: [{x,y},{x,y}], start } while the hint pulses

const HINT_IDLE_MS = 4000;   // show a hint after this long with no input
const HINT_DURATION_MS = 2000; // how long the hint pulses before clearing
const HINT_PULSES = 2;       // grow/shrink cycles packed into the duration

// ---- Levels (100 levels, 5 arenas × 20) -----------------------------------
const MAX_LEVEL = 100;
const ARENA_NAMES = ["Sweet Start", "Idol Lane", "Tight Twist", "Combo Canyon", "Master Mix"];
// First level of each arena is always playable.
const ARENA_ENTRY_LEVELS = [1, 21, 41, 61, 81];

function levelArenaSlot(level) {
  const arena = Math.ceil(level / 20);
  const slot = ((level - 1) % 20) + 1;
  return { arena, slot };
}

function slotsFromLegacyLevel(n) {
  const slots = [1, 1, 1, 1, 1];
  const capped = Math.min(MAX_LEVEL, Math.max(1, n));
  for (let a = 0; a < 5; a++) {
    const start = a * 20 + 1;
    if (capped >= start + 19) slots[a] = 20;
    else if (capped >= start) slots[a] = capped - start + 1;
  }
  return slots;
}

function loadUnlockedSlots() {
  try {
    const raw = localStorage.getItem("matchDuel.unlockedSlots");
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length === 5) {
        return arr.map((x) => Math.min(20, Math.max(1, parseInt(x, 10) || 1)));
      }
    }
  } catch (e) { /* ignore */ }
  try {
    const legacy = parseInt(localStorage.getItem("matchDuel.unlocked"), 10);
    if (legacy > 1) return slotsFromLegacyLevel(legacy);
  } catch (e) { /* ignore */ }
  return [1, 1, 1, 1, 1];
}

function saveUnlockedSlots() {
  try {
    localStorage.setItem("matchDuel.unlockedSlots", JSON.stringify(unlockedSlots));
    let maxLvl = 1;
    for (let a = 0; a < 5; a++) maxLvl = Math.max(maxLvl, a * 20 + unlockedSlots[a]);
    localStorage.setItem("matchDuel.unlocked", String(maxLvl));
  } catch (e) { /* ignore */ }
}

function unlockLevelAfterWin(level) {
  const { arena, slot } = levelArenaSlot(level);
  const idx = arena - 1;
  if (slot < 20) unlockedSlots[idx] = Math.max(unlockedSlots[idx], slot + 1);
  if (slot === 20 && arena < 5)
    unlockedSlots[arena] = Math.max(unlockedSlots[arena], 1);
  saveUnlockedSlots();
}

function isLevelUnlocked(level) {
  if (ARENA_ENTRY_LEVELS.includes(level)) return true;
  const { arena, slot } = levelArenaSlot(level);
  return slot <= unlockedSlots[arena - 1];
}

function menuFocusArena() {
  if (currentLevel) return Math.ceil(currentLevel / 20);
  for (let a = 4; a >= 0; a--) {
    if (unlockedSlots[a] > 1 || ARENA_ENTRY_LEVELS.includes(a * 20 + 1)) return a + 1;
  }
  return 1;
}

let unlockedSlots = loadUnlockedSlots();

function buildVoidCells(pattern, w, h) {
  const s = new Set();
  const add = (x, y) => { if (x >= 0 && x < w && y >= 0 && y < h) s.add(x + "," + y); };
  if (!pattern || pattern === "none") return s;
  if (pattern === "corners") {
    add(0, 0); add(w - 1, 0); add(0, h - 1); add(w - 1, h - 1);
    if (w >= 9) { add(1, 0); add(w - 2, 0); add(0, 1); add(w - 1, 1); }
  } else if (pattern === "ring" && w >= 8 && h >= 8) {
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) add(cx + dx, cy + dy);
  } else if (pattern === "split") {
    const mid = Math.floor(w / 2);
    for (let y = 0; y < h; y++) add(mid, y);
  } else if (pattern === "island") {
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) add(cx + dx, cy + dy);
  } else if (pattern === "trenches") {
    const mx = Math.floor(w / 2), my = Math.floor(h / 2);
    for (let x = 0; x < w; x++) add(x, my);
    for (let y = 0; y < h; y++) add(mx, y);
  } else if (pattern === "pillars") {
    for (let y = 1; y < h - 1; y++) { add(1, y); add(w - 2, y); }
  }
  return s;
}

function distributeChains(total, arena, finale, progress) {
  const c = { c1: 0, c2: 0, c3: 0, c4: 0 };
  if (total <= 0) return c;
  const p = progress || 0;
  if (arena === 2) {
    c.c4 = finale ? Math.max(1, Math.floor(total * 0.08)) : 0;
    c.c3 = finale ? Math.max(1, Math.floor(total * 0.2)) : (p > 0.55 ? Math.floor(total * 0.12) : 0);
    c.c2 = Math.floor(total * (0.12 + p * 0.24));
    c.c1 = Math.max(0, total - c.c2 - c.c3 - c.c4);
  } else if (arena <= 1) {
    c.c4 = 0;
    c.c3 = 0;
    c.c2 = 0;
    c.c1 = total;
  } else if (arena === 3) {
    c.c4 = Math.floor(total * (finale ? 0.12 : p > 0.65 ? 0.06 : 0));
    c.c3 = Math.floor(total * (finale ? 0.24 : 0.14));
    c.c2 = Math.floor(total * 0.34);
    c.c1 = Math.max(0, total - c.c2 - c.c3 - c.c4);
  } else {
    c.c4 = Math.floor(total * (finale ? 0.2 : arena >= 5 ? 0.12 + p * 0.08 : 0.08 + p * 0.05));
    c.c3 = Math.floor(total * (finale ? 0.32 : 0.22));
    c.c2 = Math.floor(total * 0.3);
    c.c1 = Math.max(0, total - c.c2 - c.c3 - c.c4);
  }
  return c;
}
const distributeIdols = distributeChains;

// Level defs built in level-objectives.js (loaded before this script ends).
let LEVEL_DEFINITIONS = [];

function levelConfig(level) {
  const def = LEVEL_DEFINITIONS[level - 1];
  return { ...def, gridW: def.w, gridH: def.h };
}

const goalLabelEl = document.getElementById("goal-label");
let levelProgress = null;

function initLevelProgress() {
  levelProgress = {
    collect: {},
    stripes: 0,
  idolsBroken: 0,
    safesBroken: 0,
    combos: 0,
    dropsCollected: 0,
  };
  if (!currentLevelCfg) return;
  for (const obj of currentLevelCfg.objectives || []) {
    if (obj.type === "collect") levelProgress.collect[obj.color] = 0;
  }
}

function countPillowsRemaining(b) {
  let n = 0;
  if (!b || !b.pillows) return 0;
  for (let x = 0; x < b.width; x++)
    for (let y = 0; y < b.height; y++)
      if (b.pillows[x][y] > 0) n++;
  return n;
}

function pathBlockersRemaining(b) {
  if (!b.pathCells || b.pathCells.size === 0) return 0;
  let n = 0;
  for (const key of b.pathCells) {
    const [x, y] = key.split(",").map(Number);
    if (isIdol(b.grid[x][y])) n++;
  }
  return n;
}

function onIdolDamaged(removed) {
  if (levelProgress) levelProgress.idolsBroken += removed ? 1 : 0;
}
const onChainDamaged = onIdolDamaged;

function onSafeDamaged(removed) {
  if (levelProgress) levelProgress.safesBroken += removed ? 1 : 0;
}

function damagePillowsOnCells(b, keys) {
  if (!b.pillows) return;
  for (const key of keys) {
    const [x, y] = key.split(",").map(Number);
    if (b.pillows[x][y] > 0) b.pillows[x][y]--;
  }
}

function trackCollectFromMatch(matched) {
  if (!levelProgress) return;
  for (const key of matched) {
    const [x, y] = key.split(",").map(Number);
    const c = board.grid[x][y];
    if (c >= 0 && c < COLOR_COUNT) {
      levelProgress.collect[c] = (levelProgress.collect[c] || 0) + 1;
    }
  }
}

function collectGemsAtExits() {
  if (!board || !board.exitCells || board.exitCells.size === 0) return;
  for (const key of board.exitCells) {
    const [x, y] = key.split(",").map(Number);
    if (isGem(board.get(x, y))) {
      board.grid[x][y] = EMPTY;
      if (levelProgress) levelProgress.dropsCollected++;
    }
  }
}

function objectiveMet(obj) {
  if (!obj) return true;
  switch (obj.type) {
    case "score": return score >= obj.target;
    case "pillows": return countPillowsRemaining(board) === 0;
    case "chains":
    case "idols": return countIdolsOnBoard(board) === 0;
    case "safes": return countSafesOnBoard(board) === 0;
    case "drops": return levelProgress.dropsCollected >= obj.amount;
    case "collect": return (levelProgress.collect[obj.color] || 0) >= obj.amount;
    case "stripes": return levelProgress.stripes >= obj.amount;
    case "combos": return levelProgress.combos >= obj.amount;
    case "path": return pathBlockersRemaining(board) === 0;
    default: return true;
  }
}

function levelGoalMet() {
  if (!currentLevelCfg || !currentLevelCfg.objectives) return score >= levelTarget;
  return currentLevelCfg.objectives.every(objectiveMet);
}

function objectiveHudLine(obj) {
  switch (obj.type) {
    case "score": return "Score " + score + "/" + obj.target;
    case "pillows": {
      const n = countPillowsRemaining(board);
      return "Clouds " + (n === 0 ? "✓" : n + " left");
    }
    case "chains":
    case "idols": {
      const n = countIdolsOnBoard(board);
      return "Idols " + (n === 0 ? "✓" : n + " left");
    }
    case "safes": {
      const n = countSafesOnBoard(board);
      return "Safes " + (n === 0 ? "✓" : n + " left");
    }
    case "drops":
      return "Drop " + levelProgress.dropsCollected + "/" + obj.amount;
    case "collect": {
      const name = obj.label || COLOR_NAMES[obj.color] || "candy";
      return name + " " + (levelProgress.collect[obj.color] || 0) + "/" + obj.amount;
    }
    case "stripes": return "Stripes " + levelProgress.stripes + "/" + obj.amount;
    case "combos": return "Combos " + levelProgress.combos + "/" + obj.amount;
    case "path": {
      const n = pathBlockersRemaining(board);
      return "Path " + (n === 0 ? "open" : n + " blocked");
    }
    default: return "";
  }
}

function updateGoalHud() {
  if (!goalEl) return;
  if (!currentLevelCfg || !currentLevelCfg.objectives || currentLevelCfg.objectives.length === 0) {
    if (goalLabelEl) goalLabelEl.textContent = "Goal";
    goalEl.textContent = levelTarget;
    return;
  }
  if (goalLabelEl) goalLabelEl.textContent = "Goals";
  const lines = currentLevelCfg.objectives.map(objectiveHudLine).filter(Boolean);
  goalEl.innerHTML = lines.join("<br>");
  goalEl.style.fontSize = lines.length > 2 ? "clamp(10px, 2.8vw, 13px)" : "";
  goalEl.style.lineHeight = "1.25";
}

let currentLevel = 1;
let currentLevelCfg = null;
let levelTarget = 0;
let hintsEnabled = true;
let inLevel = false;        // true only while a level is actually being played
let won = false;            // did the last round end by reaching the target?

// ---- Wallet (coins) -------------------------------------------------------
// Level clear reward curves upward (not linear): 500 at level 1, then ~level^1.28.
let walletCoins = 0;

function levelCoinReward(level) {
  return Math.round(500 * Math.pow(Math.max(1, level), 1.28));
}

function autoMoveCoinBonus(level) {
  return Math.round(levelCoinReward(level) * 0.05);
}

function loadCoins() {
  try {
    const v = parseInt(localStorage.getItem("matchDuel.coins"), 10);
    if (!isNaN(v)) walletCoins = Math.max(0, v);
  } catch (e) {}
}

function saveCoins() {
  try { localStorage.setItem("matchDuel.coins", String(walletCoins)); } catch (e) {}
}

function addCoins(amount, animateFromMatch = true) {
  if (amount <= 0) return;
  walletCoins += amount;
  saveCoins();
  renderWallet();
  if (animateFromMatch && inLevel) spawnFlyingCoinsToWallet();
}

function updateLastMatchCenter(matched) {
  let sx = 0, sy = 0, n = 0;
  for (const key of matched) {
    const [x, y] = key.split(",").map(Number);
    sx += x * CELL + CELL / 2;
    sy += (HEIGHT - 1 - y) * CELL + CELL / 2;
    n++;
  }
  if (n > 0) {
    lastMatchBoardX = sx / n;
    lastMatchBoardY = sy / n;
  }
}

function boardPointToScreen(bx, by) {
  const wrap = document.getElementById("wrap");
  const r = wrap.getBoundingClientRect();
  const bw = WIDTH * CELL, bh = HEIGHT * CELL;
  return {
    x: r.left + (bx / bw) * r.width,
    y: r.top + (by / bh) * r.height,
  };
}

function walletCoinTarget() {
  const el = document.getElementById("play-coins");
  if (!el) return { x: window.innerWidth * 0.5, y: 32, size: 24 };
  const icon = el.querySelector(".coin-icon") || el;
  const r = icon.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, size: r.width };
}

function spawnFlyingCoinsToWallet() {
  const from = boardPointToScreen(lastMatchBoardX, lastMatchBoardY);
  const to = walletCoinTarget();
  const n = 1 + Math.floor(Math.random() * 3);
  const now = performance.now();
  for (let i = 0; i < n; i++) {
    flyingWalletCoins.push({
      x: from.x + (Math.random() - 0.5) * 40,
      y: from.y + (Math.random() - 0.5) * 40,
      tx: to.x + (Math.random() - 0.5) * 10,
      ty: to.y + (Math.random() - 0.5) * 10,
      start: now + i * 70,
      duration: 480 + Math.random() * 220,
      size: to.size,
    });
  }
}

function coinsDisplayHtml() {
  return '<img src="images/items/coin.png" alt="" class="coin-icon" /><span>' + walletCoins.toLocaleString() + "</span>";
}

function renderWallet() {
  const el = document.getElementById("play-coins");
  if (el) el.innerHTML = coinsDisplayHtml();
  renderHearts();
}

// ---- Hearts (lives) -------------------------------------------------------
// You start with MAX_HEARTS. Running out of moves on a level costs one heart.
// Hearts refill one at a time, HEART_REGEN_MS apart, even while the page is
// closed (we persist the count and a timestamp). At 0 hearts you can't play
// until one regenerates.
const MAX_HEARTS = 5;
const HEART_REGEN_MS = 10 * 60 * 1000; // one heart every 10 minutes
let hearts = MAX_HEARTS;
let heartTimer = Date.now(); // when the current regen interval started ticking

function loadHearts() {
  try {
    const h = parseInt(localStorage.getItem("matchDuel.hearts"), 10);
    const t = parseInt(localStorage.getItem("matchDuel.heartTimer"), 10);
    if (!isNaN(h)) hearts = Math.min(MAX_HEARTS, Math.max(0, h));
    if (!isNaN(t)) heartTimer = t;
  } catch (e) {}
}
function saveHearts() {
  try {
    localStorage.setItem("matchDuel.hearts", String(hearts));
    localStorage.setItem("matchDuel.heartTimer", String(heartTimer));
  } catch (e) {}
}

// Grant any hearts earned since heartTimer; advance the clock by whole intervals.
function regenHearts() {
  if (hearts >= MAX_HEARTS) { heartTimer = Date.now(); return; }
  const gained = Math.floor((Date.now() - heartTimer) / HEART_REGEN_MS);
  if (gained > 0) {
    hearts = Math.min(MAX_HEARTS, hearts + gained);
    heartTimer = hearts >= MAX_HEARTS ? Date.now() : heartTimer + gained * HEART_REGEN_MS;
    saveHearts();
  }
}

function loseHeart() {
  if (hearts <= 0) return;
  if (hearts === MAX_HEARTS) heartTimer = Date.now(); // start the regen clock
  hearts--;
  saveHearts();
}

// ms until the next heart, or 0 when full.
function msToNextHeart() {
  if (hearts >= MAX_HEARTS) return 0;
  return Math.max(0, HEART_REGEN_MS - (Date.now() - heartTimer));
}
function fmtTime(ms) {
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// Record a real interaction so the idle timer restarts and any live hint stops.
// Repaint the settled board if we interrupted a pulse, so no glow frame lingers.
function noteActivity() {
  lastActivity = performance.now();
  if (hint) { hint = null; render(); }
}

function newGame() {
  board = new Board(WIDTH, HEIGHT, COLOR_COUNT, seed, currentLevelCfg?.voidCells);
  setupLevelFeatures();
  initLevelProgress();
  selX = selY = -1;
  score = 0;
  movesLeft = levelMoves;
  gameOver = false;
  won = false;
  resolving = false;
  boardAnimating = false;
  cascadePromise = null;
  particles = [];
  safeAnims = [];
  safeExplosions = [];
  idolExplosions = [];
  safeBlastCenters = [];
  safeBlockers.clear();
  idolAnims = [];
  idolBlockers.clear();
  comboPopup = null;
  comboBonusUntil = 0;
  comboBonusPct = 0;
  autoFinishing = false;
  levelGoalCelebrated = false;
  passCelebrationPending = false;
  flyingWalletCoins = [];
  passLevelPopup = null;
  lastActivity = performance.now();
  hint = null;
  updateComboBonusHud(performance.now());
  scoreEl.textContent = score;
  updateGoalHud();
  const arenaName = ARENA_NAMES[(currentLevelCfg?.arena || 1) - 1];
  levelEl.textContent = currentLevel + (arenaName ? " · " + arenaName.split(" ")[0] : "");
  movesEl.textContent = movesLeft;
  fxCtx.clearRect(0, 0, WIDTH * CELL, HEIGHT * CELL);
  overlay.classList.remove("show");
  render();
}

function roundRect(px, py, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(px + r, py);
  ctx.arcTo(px + w, py, px + w, py + h, r);
  ctx.arcTo(px + w, py + h, px, py + h, r);
  ctx.arcTo(px, py + h, px, py, r);
  ctx.arcTo(px, py, px + w, py, r);
  ctx.closePath();
}

// Draw one candy. gx/gy are grid coords (y=0 bottom) and MAY be fractional so
// candies can be tweened between cells. dx/dy are extra pixel offsets (shake).
// sx/sy are independent width/height multipliers used for squash-and-stretch.
// glow (0..1) makes the sprite "light up" — a white halo plus an additive
// re-draw that brightens it — used by the idle hint pulse.
function drawCell(gx, gy, c, scale = 1, alpha = 1, dx = 0, dy = 0, sx = 1, sy = 1, glow = 0, clipToCell = false) {
  if (clipToCell) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(gx * CELL + 1, (HEIGHT - 1 - gy) * CELL + 1, CELL - 2, CELL - 2);
    ctx.clip();
  }
  const finishDrawCell = () => {
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    if (clipToCell) ctx.restore();
  };
  const cx = gx * CELL + CELL / 2 + dx;
  const cy = (HEIGHT - 1 - gy) * CELL + CELL / 2 + dy;
  const w = Math.min(SPRITE_MAX_SIZE, SPRITE_SIZE * scale * sx);
  const h = Math.min(SPRITE_MAX_SIZE, SPRITE_SIZE * scale * sy);
  ctx.globalAlpha = alpha;
  if (glow > 0) {
    ctx.shadowColor = "rgba(255,255,255,0.95)";
    ctx.shadowBlur = 14 * glow;
  }
  if (isGem(c)) {
    ctx.fillStyle = "#ff6eb4";
    ctx.beginPath();
    ctx.arc(cx, cy, SPRITE_SIZE * 0.32, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    finishDrawCell();
    return;
  }
  if (isIdol(c)) {
    const img = IDOL_IMAGES[idolLevel(c) - 1];
    if (img && img.complete && img.naturalWidth > 0)
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    else {
      ctx.fillStyle = "#6a5a8a";
      roundRect(cx - w / 2, cy - h / 2, w, h, 10);
      ctx.fill();
    }
    finishDrawCell();
    return;
  }
  if (isSafe(c)) {
    const anim = safeAnimAt(gx, gy, performance.now());
    const isDeath = anim && anim.type === "death";
    const drawScale = scale * (anim && anim.type === "pulse" ? anim.scale : isDeath ? anim.scale : 1);
    const drawAlpha = alpha * (anim ? anim.alpha : 1);
    const adx = dx + (anim ? anim.dx : 0);
    const ady = dy + (anim ? anim.dy : 0);
    const maxDim = isDeath ? CELL * 3.2 : SPRITE_MAX_SIZE;
    const sw = Math.min(maxDim, SPRITE_SIZE * drawScale * sx);
    const sh = Math.min(maxDim, SPRITE_SIZE * drawScale * sy);
    const img = SAFE_IMAGES[safeLevel(c) - 1];
    ctx.globalAlpha = drawAlpha;
    if (img && img.complete && img.naturalWidth > 0)
      ctx.drawImage(img, cx - sw / 2 + adx, cy - sh / 2 + ady, sw, sh);
    else {
      ctx.fillStyle = "#8a7040";
      roundRect(cx - sw / 2 + adx, cy - sh / 2 + ady, sw, sh, 10);
      ctx.fill();
    }
    finishDrawCell();
    return;
  }
  const bc = baseColor(c);
  let img;
  if (isLineH(c)) img = HLINE_IMAGES[bc % HLINE_IMAGES.length];
  else if (isLineV(c)) img = VLINE_IMAGES[bc % VLINE_IMAGES.length];
  else img = IMAGES[bc % IMAGES.length];
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    // Sprite not loaded yet — fall back to a flat swatch so nothing pops blank.
    ctx.fillStyle = SPARKLE_COLORS[bc % SPARKLE_COLORS.length];
    roundRect(cx - w / 2, cy - h / 2, w, h, 10);
    ctx.fill();
  }
  if (glow > 0) {
    ctx.shadowBlur = 0;
    // Additive second pass brightens the sprite so it reads as "lit up".
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha * glow * 0.6;
    if (img && img.complete && img.naturalWidth > 0)
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    ctx.globalCompositeOperation = "source-over";
  }
  finishDrawCell();
}

function sparkleOf(c) {
  if (isIdol(c)) return "#d8c9ff";
  if (isSafe(c)) return "#ffd45a";
  if (isGem(c)) return "#ff6eb4";
  const bc = baseColor(c);
  if (bc < 0) return "#ffffff";
  return SPARKLE_COLORS[bc % SPARKLE_COLORS.length];
}
const clear = () => ctx.clearRect(0, 0, WIDTH * CELL, HEIGHT * CELL);

function drawVoidLayer() {
  if (!board) return;
  for (let x = 0; x < WIDTH; x++)
    for (let y = 0; y < HEIGHT; y++)
      if (isVoidCell(board, x, y)) drawVoidCell(x, y);
}

function pillowAlpha(layers) {
  return window.pillowOpacity ? window.pillowOpacity(layers) : (layers >= 3 ? 0.7 : layers === 2 ? 0.5 : 0.2);
}

function drawPillow(x, y) {
  if (!board || !board.pillows || board.pillows[x][y] <= 0) return;
  const layers = board.pillows[x][y];
  const size = CELL - GAP;
  const px = x * CELL + GAP / 2;
  const py = (HEIGHT - 1 - y) * CELL + GAP / 2;
  ctx.save();
  ctx.globalAlpha = pillowAlpha(layers);
  if (pillowImg.complete && pillowImg.naturalWidth > 0)
    ctx.drawImage(pillowImg, px, py, size, size);
  else {
    ctx.fillStyle = "#c9b8f0";
    roundRect(px, py, size, size, 8);
    ctx.fill();
  }
  ctx.restore();
}

function canPlayerMove() {
  return (
    inLevel &&
    !gameOver &&
    !autoFinishing &&
    !passCelebrationPending &&
    !boardAnimating &&
    movesLeft > 0
  );
}

function drawPathCell(x, y) {
  if (!board || !board.pathCells || !board.pathCells.has(x + "," + y)) return;
  const size = CELL - GAP;
  const px = x * CELL + GAP / 2 + size / 2;
  const py = (HEIGHT - 1 - y) * CELL + GAP / 2 + size / 2;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#7ec8ff";
  ctx.beginPath();
  ctx.arc(px, py, size * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawExitCell(x, y) {
  if (!board || !board.exitCells || !board.exitCells.has(x + "," + y)) return;
  const size = CELL - GAP;
  const px = x * CELL + GAP / 2;
  const py = (HEIGHT - 1 - y) * CELL + GAP / 2;
  ctx.strokeStyle = "rgba(255, 220, 100, 0.85)";
  ctx.lineWidth = 2;
  roundRect(px + 3, py + 3, size - 6, size - 6, 6);
  ctx.stroke();
}

function drawUnderlayers(x, y) {
  drawPillow(x, y);
  drawPathCell(x, y);
  drawExitCell(x, y);
}

function drawVoidCell(x, y) {
  const size = CELL - GAP;
  const px = x * CELL + GAP / 2;
  const py = (HEIGHT - 1 - y) * CELL + GAP / 2;
  ctx.fillStyle = "#d2cfdb";
  roundRect(px, py, size, size, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth = 1;
  roundRect(px, py, size, size, 8);
  ctx.stroke();
}

function drawEmptyCell(x, y) {
  const size = CELL - GAP;
  const px = x * CELL + GAP / 2;
  const py = (HEIGHT - 1 - y) * CELL + GAP / 2;
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  roundRect(px, py, size, size, 8);
  ctx.fill();
}

function drawBoardCell(x, y, ignoreCandy = false) {
  if (isVoidCell(board, x, y)) {
    drawVoidCell(x, y);
    return;
  }
  drawEmptyCell(x, y);
  drawUnderlayers(x, y);
  const c = board.get(x, y);
  if (!ignoreCandy && c !== EMPTY) {
    drawCell(x, y, c, 1, 1, 0, 0, 1, 1, 0, true);
  }
}

// Static render of the settled board, including the selection highlight.
function render() {
  clear();
  for (let x = 0; x < WIDTH; x++) {
    for (let y = 0; y < HEIGHT; y++) {
      if (board && isVoidCell(board, x, y)) { drawVoidCell(x, y); continue; }
      drawEmptyCell(x, y);
      drawUnderlayers(x, y);
      const c = board.get(x, y);
      if (c === EMPTY) {
        continue;
      }
      const selected = (x === selX && y === selY);
      drawCell(x, y, c, selected ? 1.04 : 1, 1, 0, 0, 1, 1, 0, true);
      if (selected) {
        const size = SPRITE_MAX_SIZE;
        const cx = x * CELL + CELL / 2;
        const cy = (HEIGHT - 1 - y) * CELL + CELL / 2;
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        roundRect(cx - size / 2, cy - size / 2, size, size, 10);
        ctx.stroke();
      }
    }
  }
  drawSafeDeathOverlays(performance.now());
  drawIdolDeathOverlays(performance.now());
}

// Idle hint: redraw the settled board with the two suggested tiles pulsing —
// growing up to +20% and lighting up, then settling back. Driven by tick().
function renderHint(now) {
  const t = (now - hint.start) / HINT_DURATION_MS;        // 0..1 over the hint
  const p = Math.abs(Math.sin(t * Math.PI * HINT_PULSES)); // 0→1→0, pulsing
  const scale = 1 + 0.12 * p;                              // stays inside cell lines
  const hintSet = new Set(hint.cells.map((c) => c.x + "," + c.y));
  clear();
  drawVoidLayer();
  for (let x = 0; x < WIDTH; x++)
    for (let y = 0; y < HEIGHT; y++) {
      if (isVoidCell(board, x, y)) continue;
      drawEmptyCell(x, y);
      drawUnderlayers(x, y);   // keep pillows/paths/exits visible during the hint
      const c = board.get(x, y);
      if (c === EMPTY) continue;
      if (hintSet.has(x + "," + y)) drawCell(x, y, c, scale, 1, 0, 0, 1, 1, p, true);
      else drawCell(x, y, c, 1, 1, 0, 0, 1, 1, 0, true);
    }
}

// ---- Tiny tween runner ----------------------------------------------------
// Calls draw(easedProgress) every frame for `duration` ms, resolves when done.
function animate(duration, draw, easing) {
  return new Promise((resolve) => {
    const start = performance.now();
    function frame(now) {
      let t = (now - start) / duration;
      if (t > 1) t = 1;
      draw(easing ? easing(t) : t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}
const easeIn = (t) => t * t;            // accelerate — reads like gravity/falling
const easeOut = (t) => 1 - (1 - t) * (1 - t);
// Overshoots past 1 then settles — gives moves a springy "jiggle" landing.
const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
// Fall easing with a very slight anticipation (dips up a hair before dropping)
// and a slightly bigger landing bounce (overshoots past the slot, then settles).
// Asymmetric easeInOutBack: small cIn keeps the rise subtle; larger cOut gives
// the landing a bit more bounce. (Both halves still meet at 0.5, so it's smooth.)
const easeFallBounce = (t) => {
  const cIn = 0.6 * 1.525;    // tiny anticipation up
  const cOut = 0.95 * 1.525;  // a bit more bounce on landing
  return t < 0.5
    ? (Math.pow(2 * t, 2) * ((cIn + 1) * 2 * t - cIn)) / 2
    : (Math.pow(2 * t - 2, 2) * ((cOut + 1) * (2 * t - 2) + cOut) + 2) / 2;
};

// A damped squash-and-stretch wobble played on cells right after they land,
// so every move/drop ends with a little jiggle. cells: [{x,y}].
function animateJiggle(cells, speed = 1) {
  if (cells.length === 0) return Promise.resolve();
  const set = new Set(cells.map((c) => c.x + "," + c.y));
  return animate(Math.max(40, Math.round(260 * speed)), (t) => {
    const wob = Math.sin(t * Math.PI * 3) * (1 - t) * 0.24; // decays to 0
    clear();
    for (let x = 0; x < WIDTH; x++)
      for (let y = 0; y < HEIGHT; y++) {
        if (set.has(x + "," + y)) {
          drawBoardCell(x, y, true);
          drawCell(x, y, board.get(x, y), 1, 1, 0, 0, 1 + wob, 1 - wob);
        } else {
          drawBoardCell(x, y);
        }
      }
  });
}

// ---- Sparkles + combo popup ----------------------------------------------

// Burst of little sparks out of every candy in a match (called each clear).
function spawnSparkles(matched, count = 7) {
  if (particles.length > 220) particles.length = 180;
  for (const key of matched) {
    const [x, y] = key.split(",").map(Number);
    const cx = x * CELL + CELL / 2;
    const cy = (HEIGHT - 1 - y) * CELL + CELL / 2;
    const base = sparkleOf(board.get(x, y));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 45 + Math.random() * 130;
      const life = 0.45 + Math.random() * 0.35;
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40,   // bias upward so they "spark" out
        life, maxLife: life,
        size: 2 + Math.random() * 4,
        color: Math.random() < 0.5 ? "#ffffff" : base,
      });
    }
  }
}

// On a pop, for a single object: fling little colored rock shards outward (in
// the object's own color) and leave a few twinkling stars where it used to be.
function spawnDebrisAt(x, y, tileColor) {
  if (particles.length > 240) particles.length = 180;
  const cx = x * CELL + CELL / 2;
  const cy = (HEIGHT - 1 - y) * CELL + CELL / 2;
  const base = sparkleOf(tileColor);
  // Rock shards: irregular chunks in the object's color, flung outward.
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 60 + Math.random() * 150;
    const life = 0.4 + Math.random() * 0.3;          // gone within ~0.7s
    const n = 5 + (Math.random() * 3 | 0);
    const verts = [];
    for (let j = 0; j < n; j++) verts.push(0.6 + Math.random() * 0.5);
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30,
      life, maxLife: life,
      size: 3 + Math.random() * 4,
      color: base, shape: "rock",
      verts, rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 12,
    });
  }
  // Little stars that hover where the object was and twinkle out.
  for (let i = 0; i < 3; i++) {
    const life = 0.45 + Math.random() * 0.25;
    particles.push({
      x: cx + (Math.random() - 0.5) * CELL * 0.5,
      y: cy + (Math.random() - 0.5) * CELL * 0.5,
      vx: (Math.random() - 0.5) * 24,
      vy: (Math.random() - 0.5) * 24 - 8,
      life, maxLife: life,
      size: 3 + Math.random() * 3,
      color: Math.random() < 0.4 ? base : "#fff7d6",
      shape: "star", float: true,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 6,
    });
  }
}

// Spawn the rock/star debris for a whole set of popped cells.
function spawnExplosionDebris(matched) {
  for (const key of matched) {
    const [x, y] = key.split(",").map(Number);
    spawnDebrisAt(x, y, board.get(x, y));
  }
}

function occupiedCellsNear(b, x, y, maxDist) {
  const out = [];
  for (let nx = 0; nx < b.width; nx++) {
    for (let ny = 0; ny < b.height; ny++) {
      const dist = Math.max(Math.abs(nx - x), Math.abs(ny - y));
      if (dist === 0 || dist > maxDist) continue;
      if (isVoidCell(b, nx, ny)) continue;
      if (b.grid[nx][ny] === EMPTY) continue;
      out.push({ x: nx, y: ny, dist });
    }
  }
  out.sort((a, b) => a.dist - b.dist || a.x - b.x || a.y - b.y);
  return out;
}

function spawnGoldTowardTargets(fromX, fromY, targets, kind) {
  if (!targets.length) return;
  const cx = fromX * CELL + CELL / 2;
  const cy = (HEIGHT - 1 - fromY) * CELL + CELL / 2;
  for (const t of targets) {
    const tx = t.x * CELL + CELL / 2;
    const ty = (HEIGHT - 1 - t.y) * CELL + CELL / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const sp = kind === "bar" ? 95 + Math.random() * 55 : 110 + Math.random() * 70;
    const life = kind === "bar" ? 0.55 + Math.random() * 0.25 : 0.42 + Math.random() * 0.2;
    particles.push({
      x: cx + (Math.random() - 0.5) * 10,
      y: cy + (Math.random() - 0.5) * 10,
      vx: (dx / dist) * sp + (Math.random() - 0.5) * 28,
      vy: (dy / dist) * sp + (Math.random() - 0.5) * 28 - 18,
      life,
      maxLife: life,
      size: kind === "bar" ? 9 + Math.random() * 7 : 4 + Math.random() * 3,
      color: kind === "bar" ? "#ffc840" : "#ffe566",
      shape: kind === "bar" ? "goldBar" : "goldPlate",
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 8,
    });
  }
}

function spawnSafeGoldPlates(x, y, count) {
  const near = occupiedCellsNear(board, x, y, 1);
  if (!near.length) return;
  const picks = [];
  for (let i = 0; i < count; i++) picks.push(near[i % near.length]);
  spawnGoldTowardTargets(x, y, picks, "plate");
}

function spawnSafeExplosion(x, y) {
  const cx = x * CELL + CELL / 2;
  const cy = (HEIGHT - 1 - y) * CELL + CELL / 2;
  safeExplosions.push({ x: cx, y: cy, start: performance.now(), dur: 520 });
  spawnDebrisAt(x, y, toSafe(1));
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 160 + Math.random() * 280;
    const life = 0.3 + Math.random() * 0.45;
    const isStar = Math.random() < 0.4;
    const p = {
      x: cx + (Math.random() - 0.5) * CELL * 0.4,
      y: cy + (Math.random() - 0.5) * CELL * 0.4,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 70,
      life,
      maxLife: life,
      size: 3 + Math.random() * 7,
      color: Math.random() < 0.55 ? "#ffd45a" : "#ff8c20",
      shape: isStar ? "star" : "rock",
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 14,
      float: false,
      gravity: 360,
    };
    if (!isStar) {
      const n = 5 + (Math.random() * 3 | 0);
      p.verts = [];
      for (let j = 0; j < n; j++) p.verts.push(0.6 + Math.random() * 0.5);
    }
    particles.push(p);
  }
}

function spawnSafeGoldBars(x, y, count) {
  const cx = x * CELL + CELL / 2;
  const cy = (HEIGHT - 1 - y) * CELL + CELL / 2;
  const G = 640;
  for (let i = 0; i < count; i++) {
    // Burst the bars outward in every direction (slight upward bias) with a
    // wide spread of speeds, so they scatter far instead of clustering.
    const ang = Math.random() * Math.PI * 2;
    const speed = 260 + Math.random() * 560;
    const vx = Math.cos(ang) * speed;
    const vy = Math.sin(ang) * speed - 150;
    const life = 2.6 + Math.random() * 2.4;
    particles.push({
      x: cx + (Math.random() - 0.5) * CELL * 0.5,
      y: cy + (Math.random() - 0.5) * CELL * 0.5,
      vx,
      vy,
      life,
      maxLife: life,
      size: 6.5 + Math.random() * 5,
      shape: "goldBar",
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 7,
      float: false,
      gravity: G,
    });
  }
}

function triggerSafeHit(x, y, removed, prevLevel) {
  const now = performance.now();
  safeAnims = safeAnims.filter((a) => !(a.x === x && a.y === y));
  if (removed) {
    safeBlockers.add(x + "," + y);
    safeAnims.push({
      x, y, type: "death", level: prevLevel, start: now, dur: SAFE_DEATH_MS, barsSpawned: false,
    });
  } else {
    safeAnims.push({ x, y, type: "pulse", level: prevLevel, start: now, dur: 300 });
    spawnSafeGoldPlates(x, y, 2 + (Math.random() * 2 | 0));
  }
}

function safeAnimAt(x, y, now) {
  const anim = safeAnims.find((a) => a.x === x && a.y === y && now - a.start < a.dur);
  if (!anim) return null;
  const t = Math.min(1, (now - anim.start) / anim.dur);
  if (anim.type === "pulse") {
    const pulse = 1 + 0.2 * Math.sin(t * Math.PI);
    return { type: "pulse", scale: pulse, dx: 0, dy: 0, alpha: 1, level: anim.level };
  }
  const elapsed = now - anim.start;
  const progress = t;
  const shakeRamp = Math.pow(progress, 0.32);
  const amp = 0.06 + 0.36 * shakeRamp * shakeRamp;
  const freqX = 32 + 108 * shakeRamp;
  const freqY = 38 + 112 * shakeRamp;
  const shakeX = Math.sin(elapsed * 0.001 * freqX) * amp * CELL * 0.12;
  const shakeY = Math.cos(elapsed * 0.001 * freqY) * amp * CELL * 0.12;
  const vanishStart = 0.79;
  let scale;
  if (progress < vanishStart) {
    scale = 1 + (progress / vanishStart);
  } else {
    const vt = (progress - vanishStart) / (1 - vanishStart);
    const ease = vt * vt * (3 - 2 * vt);
    scale = 2 + ease * (SAFE_DEATH_COVER_SCALE - 2);
  }
  return { type: "death", scale, dx: shakeX, dy: shakeY, alpha: 1, level: anim.level };
}

function finishSafeDeathAnim(a) {
  if (a.barsSpawned) return;
  a.barsSpawned = true;
  a.exploded = true;
  spawnSafeExplosion(a.x, a.y);
  spawnSafeGoldBars(a.x, a.y, 30);
  safeBlockers.delete(a.x + "," + a.y);
  safeBlastCenters.push({ x: a.x, y: a.y });
}

function finishIdolDeathAnim(a) {
  idolBlockers.delete(a.x + "," + a.y);
  if (a.rocksSpawned) return;
  a.rocksSpawned = true;
  spawnIdolExplosion(a.x, a.y);
  spawnIdolRocks(a.x, a.y);
}

function spawnIdolRocks(gridX, gridY) {
  if (particles.length > 200) particles.length = 150;
  const cx = gridX * CELL + CELL / 2;
  const cy = (HEIGHT - 1 - gridY) * CELL + CELL / 2;
  for (let i = 0; i < 25; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 120 + Math.random() * 130; // Slightly faster throwing speed
    const vx = Math.cos(a) * speed;
    const vy = Math.sin(a) * speed - 20;
    const life = 0.3 + Math.random() * 0.25; // Slightly longer visible flight time
    const size = 7 + Math.random() * 9;
    particles.push({
      x: cx + (Math.random() - 0.5) * CELL * 0.4,
      y: cy + (Math.random() - 0.5) * CELL * 0.4,
      vx,
      vy,
      life,
      maxLife: life,
      size,
      color: "#555555",
      shape: "idolRock",
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 12, // Faster spin
      float: false,
      gravity: 300 // Slightly stronger gravity for nicer arcs
    });
  }
}

// A safe's explosion hits every object in the 3x3 block around it — left,
// right, top, bottom and the four corners. Each object takes exactly one tier
// of damage, like a regular adjacent match: candies pop with the usual
// shrink-fade-and-bubble, idols drop one level (gone at the lowest), and safes
// drop one level but are never destroyed by the blast. Stripe specials caught
// in the blast still fire their full row/column wave (chaining into others).
async function blastSafeNeighbors(speed = 1) {
  if (safeBlastCenters.length === 0) return;
  const waveSpd = autoFinishing ? AUTO_WAVE_SPEED : 0.48;
  const cells = new Set();
  for (const c of safeBlastCenters) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
        if (isVoidCell(board, nx, ny)) continue;
        if (board.grid[nx][ny] !== EMPTY) cells.add(nx + "," + ny);
      }
    }
  }
  safeBlastCenters = [];
  if (cells.size === 0) return;

  // Stripe specials in range detonate their whole row/column (and chain into
  // any other stripes the wave passes through).
  const triggers = [];
  for (const key of cells) {
    const [x, y] = key.split(",").map(Number);
    const c = board.grid[x][y];
    if (isLineH(c)) triggers.push({ x, y, horizontal: true });
    else if (isLineV(c)) triggers.push({ x, y, horizontal: false });
  }
  const waveOrdered = triggers.length > 0
    ? collectLineWaveCells(triggers, board.grid, WIDTH, HEIGHT, board.voidCells)
    : [];
  const waveSet = new Set(waveOrdered);
  const waveSnap = new Map();
  for (const k of waveOrdered) {
    const [x, y] = k.split(",").map(Number);
    waveSnap.set(k, board.get(x, y));
  }

  // Everything else in the blast radius takes one tier of damage by type.
  const popSet = new Set(); // candies/gems removed outright → combo-kill pop
  for (const key of cells) {
    if (waveSet.has(key)) continue; // handled by the wave instead
    const [x, y] = key.split(",").map(Number);
    const c = board.grid[x][y];
    if (isSafe(c)) {
      // Chip the safe down one tier but never finish it off here.
      const lvl = safeLevel(c);
      if (lvl > 1) {
        board.grid[x][y] = c - 1;
        if (typeof onSafeDamaged === "function") onSafeDamaged(false);
        triggerSafeHit(x, y, false, lvl);
      }
    } else if (isIdol(c)) {
      const lvl = idolLevel(c);
      const removed = lvl <= 1;
      board.grid[x][y] = removed ? EMPTY : c - 1;
      if (typeof onIdolDamaged === "function") onIdolDamaged(removed);
      triggerIdolHit(x, y, removed, lvl);
    } else {
      popSet.add(key);
    }
  }

  if (popSet.size > 0) {
    spawnExplosionDebris(popSet);
    spawnSparkles(popSet);
    await animateClear(popSet, speed);
    board.clearMatches(popSet);
  }

  if (waveOrdered.length > 0) {
    if (levelProgress) levelProgress.stripes += triggers.length;
    await animateLineWaveClear(waveOrdered, waveSnap, waveSpd);
  }
}

function pruneSafeAnims(now) {
  safeAnims = safeAnims.filter((a) => {
    if (now - a.start >= a.dur) {
      if (a.type === "death") finishSafeDeathAnim(a);
      return false;
    }
    return true;
  });
}

function hasSafeBlockers() {
  return safeBlockers.size > 0;
}

function hasIdolBlockers() {
  return idolBlockers.size > 0;
}

function hasBlockers() {
  return safeBlockers.size > 0 || idolBlockers.size > 0;
}

function safeBlockedColumns() {
  const cols = new Set();
  for (const key of safeBlockers) cols.add(Number(key.split(",")[0]));
  return cols;
}

function blockedColumns() {
  const cols = new Set();
  for (const key of safeBlockers) cols.add(Number(key.split(",")[0]));
  for (const key of idolBlockers) cols.add(Number(key.split(",")[0]));
  return cols;
}

function pruneIdolAnims(now) {
  idolAnims = idolAnims.filter((a) => {
    if (now - a.start >= a.dur) {
      if (a.type === "death") finishIdolDeathAnim(a);
      return false;
    }
    return true;
  });
}

async function finishBlockersCascade(speed = 1) {
  await animateBlockersHold(speed);
  await blastSafeNeighbors(speed);
  if (hasBlockers()) {
    await cascadeGravityWithBlockersHold(speed);
    return;
  }
  const moves = board.applyGravityMapped();
  const spawns = board.refillMapped();
  await animateFall(moves, spawns, speed);
}

async function cascadeGravityWithBlockersHold(speed = 1) {
  const skip = blockedColumns();
  const moves = board.applyGravityMapped({ skipColumns: skip });
  const spawns = board.refillMapped({ skipColumns: skip });
  if (moves.length > 0 || spawns.length > 0)
    await animateFall(moves, spawns, speed);
  await finishBlockersCascade(speed);
}

function animateVanishFromSnap(matched, snap, speed = 1) {
  const cells = [];
  for (const k of matched) {
    const [x, y] = k.split(",").map(Number);
    cells.push({ x, y, color: snap.get(k) });
  }
  return animate(Math.max(40, Math.round(200 * speed)), (t) => {
    clear();
    for (let x = 0; x < WIDTH; x++)
      for (let y = 0; y < HEIGHT; y++) {
        const k = x + "," + y;
        if (matched.has(k)) {
          drawBoardCell(x, y, true);
          const c = snap.get(k);
          if (c !== undefined) {
            drawCell(x, y, c, 1 - 0.5 * t, 1 - t);
            drawCellBubble(x, y, t, sparkleOf(c));
          }
        } else {
          drawBoardCell(x, y);
        }
      }
    drawSafeDeathOverlays(performance.now());
    drawIdolDeathOverlays(performance.now());
  });
}

function animateBlockersHold(speed = 1) {
  const maxSafeDur = hasSafeBlockers() ? SAFE_DEATH_MS : 0;
  const maxIdolDur = hasIdolBlockers() ? IDOL_DEATH_MS : 0;
  const maxDur = Math.max(maxSafeDur, maxIdolDur);
  const dur = Math.max(40, Math.round(maxDur * speed));
  return animate(dur, (frameT) => {
    const now = performance.now();
    clear();
    for (let x = 0; x < WIDTH; x++)
      for (let y = 0; y < HEIGHT; y++)
        drawBoardCell(x, y);
    drawSafeDeathOverlays(now);
    drawIdolDeathOverlays(now);
    for (const a of safeAnims) {
      if (a.type !== "death" || a.barsSpawned) continue;
      if (now - a.start >= a.dur) finishSafeDeathAnim(a);
    }
    for (const a of idolAnims) {
      if (a.type !== "death" || a.rocksSpawned) continue;
      if (now - a.start >= a.dur) finishIdolDeathAnim(a);
    }
  }).then(() => {
    const now = performance.now();
    for (const a of safeAnims) {
      if (a.type === "death" && !a.barsSpawned) finishSafeDeathAnim(a);
    }
    for (const a of idolAnims) {
      if (a.type === "death" && !a.rocksSpawned) finishIdolDeathAnim(a);
    }
    pruneSafeAnims(now);
    pruneIdolAnims(now);
  });
}

function drawSafeDeathOverlays(now) {
  for (const a of safeAnims) {
    if (a.type !== "death" || a.exploded || now - a.start >= a.dur) continue;
    const state = safeAnimAt(a.x, a.y, now);
    if (!state) continue;
    drawCell(a.x, a.y, toSafe(state.level), 1, 1, state.dx, state.dy, 1, 1, 0, false);
  }
}

function drawIdolDeathOverlays(now) {
  for (const a of idolAnims) {
    if (a.type !== "death" || a.rocksSpawned || now - a.start >= a.dur) continue;
    const state = idolAnimAt(a.x, a.y, now);
    if (!state) continue;
    drawCell(a.x, a.y, toIdol(state.level), state.scale, state.alpha, state.dx, state.dy, 1, 1, 0, false);
  }
}

function drawSafeExplosionFx(now) {
  safeExplosions = safeExplosions.filter((e) => now - e.start < e.dur);
  for (const e of safeExplosions) {
    const t = (now - e.start) / e.dur;
    const alpha = 1 - t * t;
    const r = CELL * (0.55 + t * 5.2);
    fxCtx.save();
    const grad = fxCtx.createRadialGradient(e.x, e.y, r * 0.08, e.x, e.y, r);
    grad.addColorStop(0, "rgba(255, 240, 160, " + (alpha * 0.95) + ")");
    grad.addColorStop(0.35, "rgba(255, 170, 40, " + (alpha * 0.55) + ")");
    grad.addColorStop(0.7, "rgba(255, 90, 20, " + (alpha * 0.22) + ")");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    fxCtx.fillStyle = grad;
    fxCtx.beginPath();
    fxCtx.arc(e.x, e.y, r, 0, Math.PI * 2);
    fxCtx.fill();
    fxCtx.lineWidth = 5 * (1 - t * 0.6);
    fxCtx.strokeStyle = "rgba(255, 255, 220, " + (alpha * 0.85) + ")";
    fxCtx.stroke();
    const r2 = r * 0.62;
    const grad2 = fxCtx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r2);
    grad2.addColorStop(0, "rgba(255, 255, 255, " + (alpha * 0.7) + ")");
    grad2.addColorStop(0.5, "rgba(255, 200, 60, " + (alpha * 0.35) + ")");
    grad2.addColorStop(1, "rgba(255, 120, 20, 0)");
    fxCtx.fillStyle = grad2;
    fxCtx.beginPath();
    fxCtx.arc(e.x, e.y, r2, 0, Math.PI * 2);
    fxCtx.fill();
    fxCtx.restore();
  }
}

function drawIdolExplosionFx(now) {
  idolExplosions = idolExplosions.filter((e) => now - e.start < e.dur);
  for (const e of idolExplosions) {
    const t = (now - e.start) / e.dur;
    const alpha = 1 - t * t;
    const r = CELL * (0.55 + t * 4.2);
    fxCtx.save();
    const grad = fxCtx.createRadialGradient(e.x, e.y, r * 0.08, e.x, e.y, r);
    grad.addColorStop(0, "rgba(220, 220, 255, " + (alpha * 0.95) + ")");
    grad.addColorStop(0.35, "rgba(140, 140, 160, " + (alpha * 0.55) + ")");
    grad.addColorStop(0.7, "rgba(80, 80, 90, " + (alpha * 0.22) + ")");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    fxCtx.fillStyle = grad;
    fxCtx.beginPath();
    fxCtx.arc(e.x, e.y, r, 0, Math.PI * 2);
    fxCtx.fill();
    fxCtx.lineWidth = 4 * (1 - t * 0.6);
    fxCtx.strokeStyle = "rgba(230, 230, 250, " + (alpha * 0.8) + ")";
    fxCtx.stroke();
    fxCtx.restore();
  }
}

// Irregular chunky polygon — reads as a little colored rock shard.
function drawRockParticle(p) {
  const v = p.verts;
  fxCtx.save();
  fxCtx.translate(p.x, p.y);
  fxCtx.rotate(p.rot || 0);
  fxCtx.beginPath();
  for (let i = 0; i < v.length; i++) {
    const a = (i / v.length) * Math.PI * 2;
    const r = p.size * v[i];
    const px = Math.cos(a) * r, py = Math.sin(a) * r;
    if (i === 0) fxCtx.moveTo(px, py); else fxCtx.lineTo(px, py);
  }
  fxCtx.closePath();
  fxCtx.fill();
  fxCtx.restore();
}

function drawIdolRockParticle(p) {
  fxCtx.save();
  fxCtx.translate(p.x, p.y);
  fxCtx.rotate(p.rot || 0);
  const w = p.size;
  const h = p.size;
  if (rocksLoaded) {
    fxCtx.drawImage(keyedRocksCanvas, -w / 2, -h / 2, w, h);
  } else {
    fxCtx.fillStyle = "#4a4a4a";
    fxCtx.beginPath();
    const verts = [0.8, 1.1, 0.9, 1.2, 0.75, 1.0];
    for (let i = 0; i < verts.length; i++) {
      const a = (i / verts.length) * Math.PI * 2;
      const r = (p.size / 2) * verts[i];
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) fxCtx.moveTo(px, py);
      else fxCtx.lineTo(px, py);
    }
    fxCtx.closePath();
    fxCtx.fill();
  }
  fxCtx.restore();
}

function fxRoundRect(c, px, py, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(px + r, py);
  c.arcTo(px + w, py, px + w, py + h, r);
  c.arcTo(px + w, py + h, px, py + h, r);
  c.arcTo(px, py + h, px, py, r);
  c.arcTo(px, py, px + w, py, r);
  c.closePath();
}

function drawGoldPlateParticle(p) {
  const w = p.size * 1.8;
  const h = p.size * 1.1;
  fxCtx.save();
  fxCtx.translate(p.x, p.y);
  fxCtx.rotate(p.rot || 0);
  fxCtx.fillStyle = p.color;
  fxRoundRect(fxCtx, -w / 2, -h / 2, w, h, Math.max(1, p.size * 0.25));
  fxCtx.fill();
  fxCtx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  fxCtx.lineWidth = 1;
  fxCtx.stroke();
  fxCtx.restore();
}

function drawGoldBarParticle(p) {
  const w = p.size * 2.4;
  const aspect = goldBarImg.naturalWidth > 0
    ? goldBarImg.naturalHeight / goldBarImg.naturalWidth
    : 0.42;
  const h = w * aspect;
  fxCtx.save();
  fxCtx.translate(p.x, p.y);
  fxCtx.rotate(p.rot || 0);
  if (goldBarImg.complete && goldBarImg.naturalWidth > 0)
    fxCtx.drawImage(goldBarImg, -w / 2, -h / 2, w, h);
  else {
    fxCtx.fillStyle = "#ffc840";
    fxRoundRect(fxCtx, -w / 2, -h / 2, w, h, Math.max(1, p.size * 0.2));
    fxCtx.fill();
  }
  fxCtx.restore();
}

// Little 5-point star left where an object popped.
function drawStarParticle(p) {
  const spikes = 5, outer = p.size, inner = p.size * 0.45;
  fxCtx.save();
  fxCtx.translate(p.x, p.y);
  fxCtx.rotate(p.rot || 0);
  fxCtx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const px = Math.cos(a) * r, py = Math.sin(a) * r;
    if (i === 0) fxCtx.moveTo(px, py); else fxCtx.lineTo(px, py);
  }
  fxCtx.closePath();
  fxCtx.fill();
  fxCtx.restore();
}

// An expanding bubble that blooms inside a popping object's box, then pops.
// Runs at 2x speed (finishes in the first half of the pop), grows to 10%
// bigger than the box, and fades 70% → 0% opacity linearly.
function drawCellBubble(gx, gy, t, color) {
  const bt = Math.min(1, t * 2);             // bubble animation is half as long
  const alpha = 0.7 * (1 - bt);              // 70% → 0%, linear
  if (alpha <= 0) return;
  const cx = gx * CELL + CELL / 2;
  const cy = (HEIGHT - 1 - gy) * CELL + CELL / 2;
  const r = CELL_DRAW_SIZE * 0.55 * easeOut(bt);  // small → 110% of the box
  if (r <= 0.5) return;
  const rgb = glowHexRgb(color) || { r: 255, g: 255, b: 255 };
  ctx.save();
  const grad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  grad.addColorStop(0, "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + ",0)");
  grad.addColorStop(0.75, "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + "," + (alpha * 0.22) + ")");
  grad.addColorStop(1, "rgba(255,255,255," + (alpha * 0.5) + ")");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255,255,255," + alpha + ")";
  ctx.stroke();
  ctx.restore();
}

// Index matches cascade combo count: 2=Double … 9=Nonuple.
const COMBO_TIERS = [
  null, null,
  { label: "Double", file: "images/words/Double.png" },
  { label: "Triple", file: "images/words/Triple.png" },
  { label: "Quadruple", file: "images/words/Quadruple.png" },
  { label: "Quintuple", file: "images/words/Quintuple.png" },
  { label: "Sixfold", file: "images/words/Sixfold.png" },
  { label: "Sevenfold", file: "images/words/Sevenfold.png" },
  { label: "Octuple", file: "images/words/Octuple.png" },
  { label: "Nonuple", file: "images/words/Nonuple.png" },
];
const COMBO_IMAGES = {};
COMBO_TIERS.forEach((tier, i) => {
  if (!tier) return;
  const img = new Image();
  img.src = tier.file;
  COMBO_IMAGES[i] = img;
});

const comboWord = (n) => (COMBO_TIERS[n] && COMBO_TIERS[n].label) || (n + "× COMBO");

// Draw rotating sunburst rays for popups.
function drawSunburst(ctx, numRays, outerRadius, angle, color1, color2, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.rotate(angle);
  for (let i = 0; i < numRays; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    const a1 = (i / numRays) * Math.PI * 2;
    const a2 = ((i + 0.45) / numRays) * Math.PI * 2;
    ctx.lineTo(Math.cos(a1) * outerRadius, Math.sin(a1) * outerRadius);
    ctx.lineTo(Math.cos(a2) * outerRadius, Math.sin(a2) * outerRadius);
    ctx.closePath();
    
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, outerRadius);
    grad.addColorStop(0, color1);
    grad.addColorStop(0.65, color2);
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.restore();
}

// Popup grows with each tier (Double smallest → Nonuple largest; 10+ keeps scaling).
function comboPopupMetrics(combo) {
  const tier = Math.max(2, combo);
  return {
    height: 80 + (tier - 2) * 12,
    scaleMul: 1.6 + (tier - 2) * 0.08,
    fontSize: 52 + (tier - 2) * 8,
  };
}

function showCombo(n) {
  if (autoFinishing) return;
  comboPopup = { combo: n, text: comboWord(n), start: performance.now() };
}

const PASS_LEVEL_FILES = [
  "images/passingLevel/GoodJob.png",
  "images/passingLevel/YouDidIt.png",
  "images/passingLevel/Awesome.png",
];
const PASS_LEVEL_IMAGES = PASS_LEVEL_FILES.map((src) => {
  const im = new Image();
  im.src = src;
  return im;
});
let passLevelPopup = null;

function showPassLevelCelebration() {
  return new Promise((resolve) => {
    passLevelPopup = {
      img: PASS_LEVEL_IMAGES[Math.floor(Math.random() * PASS_LEVEL_IMAGES.length)],
      start: performance.now(),
      isPassLevel: true,
      height: 140,
      scaleMul: 2.2,
      onDone: resolve,
    };
  });
}

// Draw a centered popup image (combo / pass-level) on the fx canvas.
function drawCenterPopup(now, popup, grow, hold, fade) {
  const total = grow + hold + fade;
  const t = (now - popup.start) / 1000;
  
  if (t >= total) {
    return false;
  }

  let scale, alpha, rotation = 0, yOffset = 0;
  
  if (t < grow) {
    const p = t / grow;
    const spring = easeOutBack(p);
    scale = 0.1 + 0.9 * spring;
    alpha = Math.min(1, p * 2.0);
    rotation = -0.3 * (1 - p);
    yOffset = 40 * (1 - spring);
  } else if (t < grow + hold) {
    const holdTime = t - grow;
    scale = 1.0;
    alpha = 1.0;
    yOffset = Math.sin(holdTime * Math.PI * 2.0) * 8;
    scale = 1.0 + Math.sin(holdTime * Math.PI * 2.0) * 0.04;
    rotation = Math.sin(holdTime * Math.PI * 1.5) * 0.04;
  } else {
    const f = (t - grow - hold) / fade;
    scale = 1.0 + Math.sin(hold * Math.PI * 2.0) * 0.04 + 0.35 * easeIn(f);
    alpha = 1 - f;
    yOffset = Math.sin(hold * Math.PI * 2.0) * 8 - 100 * easeIn(f);
    rotation = Math.sin((hold + f * fade) * Math.PI * 1.5) * 0.04;
  }

  let s = scale * popup.scaleMul;
  const targetImg = popup.img || COMBO_IMAGES[popup.combo];
  
  let w = 0, h = popup.height;
  if (targetImg && targetImg.complete && targetImg.naturalWidth > 0) {
    w = targetImg.naturalWidth * (h / targetImg.naturalHeight);
  } else if (popup.text) {
    const fs = popup.fontSize || 44;
    w = fs * popup.text.length * 0.6;
  }
  
  // Safe limits to prevent overflow on small boards
  const maxAllowedW = (WIDTH * CELL) * 0.92;
  const maxAllowedH = (HEIGHT * CELL) * 0.85;
  if (w * s > maxAllowedW) {
    s = maxAllowedW / w;
  }
  if (h * s > maxAllowedH) {
    s = Math.min(s, maxAllowedH / h);
  }

  fxCtx.save();
  fxCtx.translate((WIDTH * CELL) / 2, (HEIGHT * CELL) / 2 + yOffset);
  
  const isLevelPass = !!popup.isPassLevel;
  const glowR = (50 + h * 0.3) * s;
  
  if (isLevelPass) {
    const sunAngle = (now / 1000) * 1.2;
    drawSunburst(fxCtx, 16, glowR * 1.4, sunAngle, "rgba(255, 230, 100, 0.45)", "rgba(255, 170, 0, 0.1)", alpha);
    drawSunburst(fxCtx, 12, glowR * 1.2, -sunAngle * 0.8, "rgba(255, 120, 200, 0.25)", "rgba(100, 220, 255, 0.05)", alpha);
    
    const radialGlow = fxCtx.createRadialGradient(0, 0, 0, 0, 0, glowR * 1.5);
    radialGlow.addColorStop(0, "rgba(255, 255, 255, " + (alpha * 0.75) + ")");
    radialGlow.addColorStop(0.35, "rgba(255, 220, 100, " + (alpha * 0.45) + ")");
    radialGlow.addColorStop(0.7, "rgba(255, 100, 180, " + (alpha * 0.2) + ")");
    radialGlow.addColorStop(1, "rgba(255, 255, 255, 0)");
    fxCtx.fillStyle = radialGlow;
    fxCtx.beginPath();
    fxCtx.arc(0, 0, glowR * 1.5, 0, Math.PI * 2);
    fxCtx.fill();
  } else {
    const comboTierVal = popup.combo || 2;
    const sunAngle = (now / 1000) * 0.8;
    const intensity = Math.min(0.65, 0.3 + comboTierVal * 0.04);
    const color1 = "rgba(255, 215, 0, " + (intensity * alpha) + ")";
    const color2 = "rgba(255, 99, 71, " + (intensity * 0.4 * alpha) + ")";
    
    drawSunburst(fxCtx, 12, glowR * 1.25, sunAngle, color1, color2, alpha);
    
    const radialGlow = fxCtx.createRadialGradient(0, 0, 0, 0, 0, glowR * 1.3);
    radialGlow.addColorStop(0, "rgba(255, 255, 255, " + (alpha * 0.65) + ")");
    radialGlow.addColorStop(0.4, "rgba(255, 215, 0, " + (alpha * 0.35) + ")");
    radialGlow.addColorStop(1, "rgba(255, 255, 255, 0)");
    fxCtx.fillStyle = radialGlow;
    fxCtx.beginPath();
    fxCtx.arc(0, 0, glowR * 1.3, 0, Math.PI * 2);
    fxCtx.fill();
  }

  fxCtx.globalAlpha = alpha;
  fxCtx.scale(s, s);
  fxCtx.rotate(rotation);

  if (targetImg && targetImg.complete && targetImg.naturalWidth > 0) {
    fxCtx.drawImage(targetImg, -w / 2, -h / 2, w, h);
  } else if (popup.text) {
    const fs = popup.fontSize || 44;
    fxCtx.textAlign = "center";
    fxCtx.textBaseline = "middle";
    fxCtx.font = "bold " + fs + "px -apple-system, system-ui, sans-serif";
    fxCtx.lineWidth = Math.max(4, Math.round(fs * 0.12));
    fxCtx.strokeStyle = "rgba(0,0,0,0.6)";
    fxCtx.strokeText(popup.text, 0, 0);
    fxCtx.fillStyle = "#ffe14d";
    fxCtx.fillText(popup.text, 0, 0);
  }

  fxCtx.restore();
  return true;
}

// Double starts the 3s window (+20%). Each higher combo step upgrades the rate and
// refreshes the timer: Triple +30%, Quadruple +40%, +10% per step.
function comboTierBonusRate(combo) {
  return combo >= 2 ? combo * 0.10 : 0;
}

function refreshComboBonusWindow(combo, now) {
  if (combo < 2) return;
  comboBonusPct = Math.max(comboBonusPct, comboTierBonusRate(combo));
  comboBonusUntil = now + COMBO_BONUS_MS;
}

function awardCascadeScore(tileCount, cascadeCombo) {
  const base = tileCount * 10;
  if (cascadeCombo < 2) return base;
  refreshComboBonusWindow(cascadeCombo, performance.now());
  return Math.round(base * (1 + comboBonusPct));
}

const comboBonusEl = document.getElementById("combo-bonus");
const comboBonusLabel = document.getElementById("combo-bonus-label");
const comboBonusFill = document.getElementById("combo-bonus-fill");

function updateComboBonusHud(now) {
  if (now < comboBonusUntil && comboBonusPct > 0) {
    comboBonusEl.classList.add("active");
    comboBonusLabel.textContent = "Combo bonus +" + Math.round(comboBonusPct * 100) + "%";
    comboBonusFill.style.transform = "scaleX(" + ((comboBonusUntil - now) / COMBO_BONUS_MS) + ")";
  } else {
    comboBonusEl.classList.remove("active");
    comboBonusPct = 0;
    comboBonusUntil = 0;
  }
}

// Advance + draw sparkles and the combo popup. Driven by the main rAF loop.
function updateFx(now, dt) {
  fxCtx.clearRect(0, 0, WIDTH * CELL, HEIGHT * CELL);

  // Sparkles
  const G = 320; // gravity px/s^2
  for (const p of particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const grav = p.gravity || G;
    if (!p.float) p.vy += grav * dt;
    if (p.vrot) p.rot += p.vrot * dt;
  }
  particles = particles.filter((p) => p.life > 0);

  drawSafeExplosionFx(now);
  drawIdolExplosionFx(now);

  fxCtx.shadowBlur = 8;
  for (const p of particles) {
    fxCtx.globalAlpha = Math.max(0, p.life / p.maxLife);
    fxCtx.fillStyle = p.color;
    fxCtx.shadowColor = p.color;
    if (p.shape === "rock") drawRockParticle(p);
    else if (p.shape === "idolRock") {
      fxCtx.shadowBlur = 0;
      drawIdolRockParticle(p);
      fxCtx.shadowBlur = 8;
    }
    else if (p.shape === "star") drawStarParticle(p);
    else if (p.shape === "goldPlate") drawGoldPlateParticle(p);
    else if (p.shape === "goldBar") drawGoldBarParticle(p);
    else fxCtx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  fxCtx.shadowBlur = 0;
  fxCtx.globalAlpha = 1;

  if (passLevelPopup) {
    passLevelPopup.height = passLevelPopup.height || 140;
    passLevelPopup.scaleMul = passLevelPopup.scaleMul || 2.2;
    if (!drawCenterPopup(now, passLevelPopup, 0.35, 2.2, 0.45)) {
      const done = passLevelPopup.onDone;
      passLevelPopup = null;
      if (done) done();
    }
  } else if (comboPopup) {
    const metrics = comboPopupMetrics(comboPopup.combo);
    comboPopup.height = metrics.height;
    comboPopup.scaleMul = metrics.scaleMul;
    comboPopup.text = comboPopup.text || comboWord(comboPopup.combo);
    comboPopup.fontSize = metrics.fontSize;
    if (!drawCenterPopup(now, comboPopup, 0.28, 0.5, 0.38)) comboPopup = null;
  }
}

// Idols cannot move — quick wiggle when the player tries to drag them.
function animateIceWiggle(cells) {
  const list = Array.isArray(cells) ? cells : [cells];
  const set = new Set(list.map((c) => c.x + "," + c.y));
  return animate(300, (t) => {
    const amp = Math.sin(t * Math.PI * 5) * 7 * (1 - t);
    clear();
    for (let x = 0; x < WIDTH; x++)
      for (let y = 0; y < HEIGHT; y++) {
        if (set.has(x + "," + y)) {
          drawBoardCell(x, y, true);
        } else {
          drawBoardCell(x, y);
        }
      }
    for (const { x, y } of list) {
        if (isVoidCell(board, x, y)) continue;
        const c = board.get(x, y);
        if (c === EMPTY) continue;
        drawCell(x, y, c, 1, 1, amp * 0.7, -amp * 0.5);
    }
  });
}

// Invalid swap: both candies jitter back and forth along the swap axis.
function animateShake(ax, ay, bx, by) {
  const horizontal = ay === by;
  return animate(360, (t) => {
    const amp = Math.sin(t * Math.PI * 5) * 8 * (1 - t);
    clear();
    for (let x = 0; x < WIDTH; x++)
      for (let y = 0; y < HEIGHT; y++) {
        const shaken = (x === ax && y === ay) || (x === bx && y === by);
        if (shaken) {
          drawBoardCell(x, y, true);
        } else {
          drawBoardCell(x, y);
        }
      }
    for (const { x, y } of [{x: ax, y: ay}, {x: bx, y: by}]) {
        if (isVoidCell(board, x, y)) continue;
        const c = board.get(x, y);
        if (c === EMPTY) continue;
        const dx = horizontal ? amp : 0;
        const dy = !horizontal ? -amp : 0;
        drawCell(x, y, c, 1, 1, dx, dy);
    }
  });
}

// Valid swap: the two candies slide into each other's cell. Grid is already
// swapped, so each target cell's candy is tweened in from the other position.
function animateSwap(ax, ay, bx, by, speed = 1) {
  const ca = board.get(ax, ay), cb = board.get(bx, by);
  const targets = new Set([ax + "," + ay, bx + "," + by]);
  return animate(Math.max(40, Math.round(140 * speed)), (t) => {
    clear();
    for (let x = 0; x < WIDTH; x++)
      for (let y = 0; y < HEIGHT; y++) {
        if (targets.has(x + "," + y)) {
          drawBoardCell(x, y, true);
          continue;
        }
        drawBoardCell(x, y);
      }
    drawCell(bx + (ax - bx) * t, by + (ay - by) * t, ca);
    drawCell(ax + (bx - ax) * t, ay + (by - ay) * t, cb);
  }, easeOutBack);
}

function glowHexRgb(glowColor) {
  if (!glowColor) return null;
  let hex = glowColor[0] === "#" ? glowColor.slice(1) : glowColor;
  if (/^[0-9a-fA-F]{3}$/.test(hex))
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

// Soft colored spark inside the tile box (after a pop).
function drawCellUnderglow(x, y, intensity, glowColor) {
  if (intensity <= 0) return;
  const rgb = glowHexRgb(glowColor);
  if (!rgb) return;
  const size = CELL - GAP;
  const cx = x * CELL + GAP / 2 + size / 2;
  const cy = (HEIGHT - 1 - y) * CELL + GAP / 2 + size / 2;
  const r = rgb.r, g = rgb.g, b = rgb.b;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const rad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.92);
  rad.addColorStop(0, "rgba(255, 255, 255, " + (intensity * 0.2) + ")");
  rad.addColorStop(0.4, "rgba(" + r + "," + g + "," + b + "," + (intensity * 0.35) + ")");
  rad.addColorStop(1, "rgba(" + r + "," + g + "," + b + ",0)");
  ctx.fillStyle = rad;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.92, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Staggered row/column wave — visual only until done; board clears applied at
// end. Each killed object gets the same explosion as a normal pop: it shrinks
// to half and fades, throws colored rock shards + stars, and blooms a bubble.
function animateLineWaveClear(keysOrdered, tileSnap, speed = 1) {
  const popDur = Math.max(80, Math.round(180 * speed));
  const stagger = Math.max(4, Math.round(7 * speed));

  const cells = [];
  for (let i = 0; i < keysOrdered.length; i++) {
    const key = keysOrdered[i];
    const c = tileSnap.get(key);
    if (c === undefined || c === EMPTY) continue;
    const [x, y] = key.split(",").map(Number);
    cells.push({
      x, y, color: c, sparkle: sparkleOf(c),
      start: i * stagger, sparked: false,
    });
  }
  if (cells.length === 0) {
    applyWaveClears(keysOrdered, tileSnap);
    return Promise.resolve();
  }

  const totalDur = (cells.length - 1) * stagger + popDur;
  const waveCells = new Set(cells.map((c) => c.x + "," + c.y));

  return new Promise((resolve) => {
    const t0 = performance.now();
    function finish() {
      applyWaveClears(keysOrdered, tileSnap);
      resolve();
    }
    function frame(now) {
      try {
        const elapsed = now - t0;
        clear();
        for (let x = 0; x < WIDTH; x++) {
          for (let y = 0; y < HEIGHT; y++) {
            const k = x + "," + y;
            if (waveCells.has(k)) continue;
            drawBoardCell(x, y);
          }
        }

        for (const cell of cells) {
          const local = elapsed - cell.start;
          if (local < 0) {
            drawBoardCell(cell.x, cell.y, true);
            drawCell(cell.x, cell.y, cell.color);
            continue;
          }
          if (!cell.sparked) {
            cell.sparked = true;
            spawnDebrisAt(cell.x, cell.y, cell.color);   // rocks + stars
          }
          drawBoardCell(cell.x, cell.y, true);
          if (local < popDur) {
            const p = local / popDur;
            // shrink to half + fade, bubble blooming inside the box
            drawCell(cell.x, cell.y, cell.color, 1 - 0.5 * p, 1 - p);
            drawCellBubble(cell.x, cell.y, p, cell.sparkle);
          }
        }
        drawSafeDeathOverlays(now);
        drawIdolDeathOverlays(now);

        if (elapsed < totalDur) requestAnimationFrame(frame);
        else finish();
      } catch (err) {
        console.error("line wave animation error", err);
        finish();
      }
    }
    requestAnimationFrame(frame);
  });
}

// Matched candies pop fast: they shrink to half size and fade while a bubble
// blooms inside each box. (Rock shards + stars are spawned separately.)
function animateClear(matched, speed = 1) {
  return animate(Math.max(40, Math.round(200 * speed)), (t) => {
    clear();
    for (let x = 0; x < WIDTH; x++)
      for (let y = 0; y < HEIGHT; y++) {
        const k = x + "," + y;
        if (matched.has(k)) {
          drawBoardCell(x, y, true);
          // The popping object shrinks to half size and fades away…
          drawCell(x, y, board.get(x, y), 1 - 0.5 * t, 1 - t);
          // …while a bubble blooms inside its box.
          drawCellBubble(x, y, t, sparkleOf(board.get(x, y)));
        } else {
          drawBoardCell(x, y);
        }
      }
    drawSafeDeathOverlays(performance.now());
    drawIdolDeathOverlays(performance.now());
  });
}

// Candies above cleared gaps fall down, and fresh candies drop in from the top.
function animateFall(moves, spawns, speed = 1) {
  const items = [];
  for (const m of moves) items.push({ x: m.x, fromY: m.fromY, toY: m.toY, color: m.color });
  for (const s of spawns) items.push({ x: s.x, fromY: s.startY, toY: s.y, color: s.color });
  const targets = new Set(items.map((i) => i.x + "," + i.toY));
  return animate(Math.max(40, Math.round(230 * speed)), (t) => {
    clear();
    for (let x = 0; x < WIDTH; x++)
      for (let y = 0; y < HEIGHT; y++) {
        if (targets.has(x + "," + y)) {
          drawBoardCell(x, y, true);
          continue;
        }
        drawBoardCell(x, y);
      }
    for (const it of items)
      drawCell(it.x, it.fromY + (it.toY - it.fromY) * t, it.color);
    drawSafeDeathOverlays(performance.now());
    drawIdolDeathOverlays(performance.now());
  }, easeFallBounce);
}

// Vanish + fall in one pass: the matched objects shrink to half and disappear
// FAST while the objects above them drop into the gap at the same time. `snap`
// holds the matched cells' colors (the grid is already cleared before this runs).
function animateClearAndFall(matched, snap, moves, spawns, speed = 1) {
  const items = [];
  for (const m of moves) items.push({ x: m.x, fromY: m.fromY, toY: m.toY, color: m.color });
  for (const s of spawns) items.push({ x: s.x, fromY: s.startY, toY: s.y, color: s.color });
  const fallTargets = new Set(items.map((i) => i.x + "," + i.toY));
  const vanishCells = [];
  for (const k of matched) {
    const [x, y] = k.split(",").map(Number);
    vanishCells.push({ x, y, color: snap.get(k) });
  }
  // Total = 0.1s hold + ~0.3s fall. The matched objects start vanishing right
  // away, but the objects above hold briefly before dropping.
  const HOLD_FRAC = 0.25;    // first quarter (~0.1s) — fallers wait, then drop
  const VANISH_FRAC = 0.45;  // matched objects are gone by ~0.18s — quick
  return animate(Math.max(40, Math.round(400 * speed)), (t) => {
    const fLin = t <= HOLD_FRAC ? 0 : (t - HOLD_FRAC) / (1 - HOLD_FRAC);
    const ft = easeFallBounce(fLin);           // fall: slight rise, then bounce
    const vt = Math.min(1, t / VANISH_FRAC);   // vanish progress (runs faster)
    clear();
    for (let x = 0; x < WIDTH; x++)
      for (let y = 0; y < HEIGHT; y++) {
        if (fallTargets.has(x + "," + y)) { drawBoardCell(x, y, true); continue; }
        drawBoardCell(x, y);
      }
    // Matched objects shrink to half and fade, with the bubble blooming in-box.
    if (vt < 1) {
      for (const c of vanishCells) {
        drawCell(c.x, c.y, c.color, 1 - 0.5 * vt, 1 - vt);
        drawCellBubble(c.x, c.y, vt, sparkleOf(c.color));
      }
    }
    // Objects above drop into place simultaneously.
    for (const it of items)
      drawCell(it.x, it.fromY + (it.toY - it.fromY) * ft, it.color);
    drawSafeDeathOverlays(performance.now());
    drawIdolDeathOverlays(performance.now());
  });
}

const AUTO_MOVE_MS = 200;
const AUTO_SWAP_SPEED = 0.11;
const AUTO_CASCADE_SPEED = 0.14;
const AUTO_WAVE_SPEED = 0.12;

function autoMovePause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveCascades(fast) {
  const auto = fast && autoFinishing;
  const spd = auto ? AUTO_CASCADE_SPEED : 1;
  const waveSpd = auto ? AUTO_WAVE_SPEED : 0.48;
  resolving = true;
  let combo = 0;
  try {
  while (true) {
    const matched = findMatches(board.grid, WIDTH, HEIGHT, board.voidCells);
    if (matched.size === 0) break;
    combo++;
    if (combo >= 2 && levelProgress) levelProgress.combos++;
    updateLastMatchCenter(matched);
    trackCollectFromMatch(matched);

    const triggers = [];
    for (const key of matched) {
      const [x, y] = key.split(",").map(Number);
      const c = board.get(x, y);
      if (isLineH(c)) triggers.push({ x, y, horizontal: true });
      else if (isLineV(c)) triggers.push({ x, y, horizontal: false });
    }
    const waveOrdered =
      triggers.length > 0
        ? collectLineWaveCells(triggers, board.grid, WIDTH, HEIGHT, board.voidCells)
        : [];
    const waveSet = new Set(waveOrdered);
    const waveSnap = new Map();
    for (const k of waveOrdered) {
      const [x, y] = k.split(",").map(Number);
      waveSnap.set(k, board.get(x, y));
    }
    const allClear = new Set(matched);
    for (const k of waveOrdered) allClear.add(k);

    score += awardCascadeScore(allClear.size, combo);
    scoreEl.textContent = score;

    if (combo >= 2 && !auto) showCombo(combo);

    boardAnimating = true;
    const matchOnly = new Set([...matched].filter((k) => !waveSet.has(k)));

    if (waveOrdered.length > 0) {
      // Line/stripe wave keeps its dedicated sweep, then settles with a fall.
      damagePillowsOnCells(board, matchOnly);
      if (matchOnly.size > 0) {
        if (!auto) spawnExplosionDebris(matchOnly);
        await animateClear(matchOnly, spd);
        board.clearMatches(matchOnly);
      }
      if (levelProgress) levelProgress.stripes += triggers.length;
      damagePillowsOnCells(board, waveSet);
      await animateLineWaveClear(waveOrdered, waveSnap, waveSpd);

      damagePillowsOnCells(board, allClear);
      board.damageAdjacentChains(allClear);
      if (hasBlockers()) {
        await cascadeGravityWithBlockersHold(spd);
      } else {
        const moves = board.applyGravityMapped();
        const spawns = board.refillMapped();
        await animateFall(moves, spawns, spd);
      }
    } else {
      // Common combo: the matched objects shrink away fast WHILE the objects
      // above them drop into the gap — the vanish and the fall play together,
      // not one after the other.
      damagePillowsOnCells(board, matchOnly);
      const snap = new Map();
      for (const k of matchOnly) {
        const [x, y] = k.split(",").map(Number);
        snap.set(k, board.get(x, y));
      }
      if (!auto) spawnExplosionDebris(matchOnly);
      board.clearMatches(matchOnly);

      damagePillowsOnCells(board, allClear);
      board.damageAdjacentChains(allClear);
      if (hasBlockers()) {
        await animateVanishFromSnap(matchOnly, snap, spd);
        await cascadeGravityWithBlockersHold(spd);
      } else {
        const moves = board.applyGravityMapped();
        const spawns = board.refillMapped();
        await animateClearAndFall(matchOnly, snap, moves, spawns, spd);
      }
    }

    collectGemsAtExits();
    boardAnimating = false;
  }
  } catch (err) {
    console.error("cascade error", err);
  } finally {
    boardAnimating = false;
    render();
  
    if (!levelGoalMet() && !board.hasValidMove()) {
      board.reshuffle();
      render();
    }
    updateGoalHud();
    resolving = false;
    lastActivity = performance.now();
    checkLevelEnd();
  }
}

// Goal reached: show passing-level art, then auto-play leftover moves / win UI.
async function passLevelSequence() {
  passCelebrationPending = true;
  await showPassLevelCelebration();
  passCelebrationPending = false;
  if (gameOver) return;
  if (movesLeft > 0) await autoFinishRemainingMoves();
  else winLevel();
}

// After the goal is met, burn leftover moves on-screen (fast) before the win UI.
async function autoFinishRemainingMoves() {
  if (autoFinishing || gameOver) return;
  autoFinishing = true;
  hint = null;
  const autoCoinPerMove = autoMoveCoinBonus(currentLevel);

  while (movesLeft > 0 && levelGoalMet() && !gameOver) {
    let cells = board.findHint();
    if (!cells) {
      board.reshuffle();
      render();
      await autoMovePause(AUTO_MOVE_MS);
      cells = board.findHint();
      if (!cells) break;
    }
    const ax = cells[0].x, ay = cells[0].y, bx = cells[1].x, by = cells[1].y;
    if (isImmovable(board.get(ax, ay)) || isImmovable(board.get(bx, by))) break;
    if (!board.trySwap(ax, ay, bx, by)) break;

    const moveStart = performance.now();
    movesLeft--;
    movesEl.textContent = movesLeft;
    boardAnimating = true;
    await animateSwap(ax, ay, bx, by, AUTO_SWAP_SPEED);
    await resolveCascades(true);
    addCoins(autoCoinPerMove);
    const wait = AUTO_MOVE_MS - (performance.now() - moveStart);
    if (wait > 0) await autoMovePause(wait);
  }

  autoFinishing = false;
  if (!gameOver && levelGoalMet()) winLevel();
}

// Win or lose once a cascade settles (and from tick when idle).
function checkLevelEnd() {
  if (cascadePromise || boardAnimating || passCelebrationPending) return;
  if (levelGoalMet()) {
    if (autoFinishing) return;
    if (!levelGoalCelebrated) {
      levelGoalCelebrated = true;
      passLevelSequence();
    }
    return;
  }
  if (movesLeft <= 0) failOutOfMoves();
}

function failOutOfMoves() {
  clearCoinRain();
  gameOver = true;
  won = false;
  loseHeart();
  renderHearts();
  const lifeMsg = hearts > 0
    ? "Lost a life — tap to retry"
    : "Out of lives — tap for the menu (refills in " + fmtTime(msToNextHeart()) + ")";
  if (currentLevelCfg && currentLevelCfg.objectives && currentLevelCfg.objectives.length > 0) {
    ovBig.textContent = "Out of moves!";
    ovSub.textContent = currentLevelCfg.objectives.map(objectiveHudLine).join(" · ") + " — " + lifeMsg;
  } else {
    ovBig.textContent = "Out of moves!  " + score + " / " + levelTarget;
    ovSub.textContent = lifeMsg;
  }
  overlay.classList.add("show");
}

function pixelToCell(clientX, clientY) {
  const p = localPos({ clientX, clientY });
  const gx = Math.floor(p.x / CELL);
  const gyFromTop = Math.floor(p.y / CELL);
  const gy = HEIGHT - 1 - gyFromTop;
  if (gx < 0 || gx >= WIDTH || gy < 0 || gy >= HEIGHT) return null;
  if (board && isVoidCell(board, gx, gy)) return null;
  return { gx, gy };
}

// ---- Drag input -----------------------------------------------------------
// Grab a candy and drag it toward an adjacent cell to swap (like Candy Crush).
let dragging = false, dragFromX = -1, dragFromY = -1;
let dragStart = { x: 0, y: 0 }, dragCur = { x: 0, y: 0 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const localPos = (e) => {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * ((WIDTH * CELL) / r.width),
    y: (e.clientY - r.top) * ((HEIGHT * CELL) / r.height)
  };
};

// Which adjacent cell the current drag points at — or null if under threshold.
function dragDirection() {
  const dx = dragCur.x - dragStart.x, dy = dragCur.y - dragStart.y;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx < CELL * 0.33 && ady < CELL * 0.33) return null;
  if (adx > ady) return { dx: dx > 0 ? 1 : -1, dy: 0 };
  return { dx: 0, dy: dy > 0 ? -1 : 1 }; // screen-down = lower grid row
}

// Live preview while dragging: the grabbed candy follows the cursor (clamped to
// one cell along the chosen axis) and the neighbor slides the opposite way.
function renderDrag() {
  const dir = dragDirection();
  let dxp = dragCur.x - dragStart.x, dyp = dragCur.y - dragStart.y;
  let nx = -1, ny = -1;
  if (dir) {
    if (dir.dx !== 0) { dyp = 0; dxp = clamp(dxp, -CELL, CELL); }
    else { dxp = 0; dyp = clamp(dyp, -CELL, CELL); }
    nx = dragFromX + dir.dx; ny = dragFromY + dir.dy;
    if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) { nx = -1; }
  } else {
    dxp = clamp(dxp, -CELL * 0.5, CELL * 0.5);
    dyp = clamp(dyp, -CELL * 0.5, CELL * 0.5);
  }

  clear();
  for (let x = 0; x < WIDTH; x++)
    for (let y = 0; y < HEIGHT; y++) {
      if ((x === dragFromX && y === dragFromY) || (x === nx && y === ny)) {
        drawBoardCell(x, y, true);
      } else {
        drawBoardCell(x, y);
      }
    }
  
  if (nx !== -1 && ny !== -1) {
    drawCell(nx, ny, board.get(nx, ny), 1, 1, -dxp, -dyp);
  }
  drawCell(dragFromX, dragFromY, board.get(dragFromX, dragFromY), 1.12, 1, dxp, dyp);
}

// Pointer events (mouse + touch + pen). touch-action:none on #game stops scroll
// from stealing drags on mobile.
// Commit a swap that forms a match: animate it and kick off the cascade.
// Returns true if it was a real match (and is now resolving), false otherwise.
function commitDragSwap(fromX, fromY, tx, ty) {
  if (!board.trySwap(fromX, fromY, tx, ty)) return false;
  movesLeft--;
  movesEl.textContent = movesLeft;
  boardAnimating = true;
  cascadePromise = animateSwap(fromX, fromY, tx, ty)
    .then(() => {
      boardAnimating = false;
      return resolveCascades();
    })
    .finally(() => { cascadePromise = null; });
  return true;
}

function finishDrag() {
  if (!dragging) return;
  noteActivity();
  dragging = false;
  const dir = dragDirection();
  const fromX = dragFromX, fromY = dragFromY;
  dragFromX = dragFromY = -1;

  if (!dir) { render(); return; }
  const tx = fromX + dir.dx, ty = fromY + dir.dy;
  if (tx < 0 || tx >= WIDTH || ty < 0 || ty >= HEIGHT) { render(); return; }

  if (movesLeft <= 0) { render(); return; }
  if (cascadePromise || !canPlayerMove()) { render(); return; }

  if (!commitDragSwap(fromX, fromY, tx, ty)) {
    const wiggle = [];
    if (isImmovable(board.get(fromX, fromY))) wiggle.push({ x: fromX, y: fromY });
    if (isImmovable(board.get(tx, ty))) wiggle.push({ x: tx, ty });
    const done = () => { render(); };
    if (wiggle.length) animateIceWiggle(wiggle).then(done);
    else animateShake(fromX, fromY, tx, ty).then(done);
  }
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  if (cascadePromise || !canPlayerMove()) return;
  const cell = pixelToCell(e.clientX, e.clientY);
  if (!cell) return;
  e.preventDefault();
  noteActivity();
  if (isImmovable(board.get(cell.gx, cell.gy))) {
    boardAnimating = true;
    animateIceWiggle({ x: cell.gx, y: cell.gy }).then(() => {
      boardAnimating = false;
      render();
    
    });
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  dragging = true;
  dragFromX = cell.gx; dragFromY = cell.gy;
  dragStart = localPos(e); dragCur = { ...dragStart };
  renderDrag();
});

canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  e.preventDefault();
  lastActivity = performance.now();
  dragCur = localPos(e);

  // If the drag has already slid far enough to line up a real match, commit it
  // right away — don't wait for the finger to lift before counting the combo.
  const dir = dragDirection();
  if (dir && !cascadePromise && movesLeft > 0 && canPlayerMove()) {
    const moved = dir.dx !== 0
      ? Math.abs(dragCur.x - dragStart.x)
      : Math.abs(dragCur.y - dragStart.y);
    const tx = dragFromX + dir.dx, ty = dragFromY + dir.dy;
    if (moved >= CELL * 0.5 && tx >= 0 && tx < WIDTH && ty >= 0 && ty < HEIGHT) {
      const fromX = dragFromX, fromY = dragFromY;
      if (commitDragSwap(fromX, fromY, tx, ty)) {
        dragging = false;
        dragFromX = dragFromY = -1;
        noteActivity();
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
    }
  }

  renderDrag();
});

canvas.addEventListener("pointerup", (e) => {
  if (!dragging) return;
  e.preventDefault();
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  finishDrag();
});

canvas.addEventListener("pointercancel", (e) => {
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (!dragging) return;
  dragging = false;
  dragFromX = dragFromY = -1;
  render();
});

window.addEventListener("keydown", (e) => {
  noteActivity();
  if ((e.key === "r" || e.key === "R") && inLevel) {
    startLevel(currentLevel); // restart the current level on a fresh board
  }
});

function tick(ts) {
  if (!lastTs) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;

  updateCoinRain(dt);
  updateLevelPassIdle(ts);

  if (!inLevel) { requestAnimationFrame(tick); return; } // idle on the menu/splash

  updateComboBonusHud(ts);
  updateFx(ts, dt);
  pruneSafeAnims(ts);
  if (
    safeAnims.length > 0 &&
    !boardAnimating &&
    !cascadePromise &&
    !dragging &&
    !hint
  ) {
    render();
  }

  if (!gameOver && !boardAnimating && !cascadePromise && !passCelebrationPending) checkLevelEnd();

  // Idle hint: after HINT_IDLE_MS with no input, pulse a valid move. While idle
  // the board is otherwise static, so the hint owns the per-frame redraw here.
  if (hintsEnabled && !gameOver && !boardAnimating && !cascadePromise && !autoFinishing && !passCelebrationPending && !dragging) {
    if (!hint && ts - lastActivity > HINT_IDLE_MS) {
      const cells = board.findHint();
      if (cells) hint = { cells, start: ts };
      else lastActivity = ts; // no move to suggest — wait out another window
    }
    if (hint) {
      if (ts - hint.start >= HINT_DURATION_MS) {
        hint = null;
        lastActivity = ts; // settle, then re-trigger after another idle window
        render();
      } else {
        renderHint(ts);
      }
    }
  }
  requestAnimationFrame(tick);
}

// Goal reached: lock the round, unlock the next level (and persist it).
function winLevel() {
  if (gameOver) return;
  autoFinishing = false;
  gameOver = true;
  won = true;
  hint = null;
  addCoins(levelCoinReward(currentLevel));
  if (currentLevel < MAX_LEVEL) unlockLevelAfterWin(currentLevel);
  refreshMenu();
  showLevelPass();
  spawnCoinRain();
}

const winDim = document.getElementById("win-dim");
const levelPass = document.getElementById("level-pass");
const levelPassPanel = document.querySelector("#level-pass .level-pass-panel");
const btnNextLevel = document.getElementById("btn-next-level");
const btnBackMenu = document.getElementById("btn-back-menu");
let levelPassIdleAt = 0;
let levelPassPulseEnd = 0;

function showLevelPass() {
  const next = currentLevel + 1;
  btnNextLevel.style.display =
    next <= MAX_LEVEL && isLevelUnlocked(next) ? "" : "none";
  btnNextLevel.classList.remove("pulsing");
  levelPassPulseEnd = 0;
  levelPassIdleAt = performance.now();
  levelPass.classList.remove("enter-in");
  winDim.classList.add("show");
  levelPass.classList.add("show");
  void levelPassPanel.offsetWidth;
  levelPass.classList.add("enter-in");
}

function hideLevelPass() {
  winDim.classList.remove("show");
  levelPass.classList.remove("show", "enter-in");
  btnNextLevel.classList.remove("pulsing");
  levelPassPulseEnd = 0;
}

function noteLevelPassActivity() {
  levelPassIdleAt = performance.now();
  btnNextLevel.classList.remove("pulsing");
  levelPassPulseEnd = 0;
}

function updateLevelPassIdle(now) {
  if (!levelPass.classList.contains("show")) return;
  if (btnNextLevel.style.display === "none") return;
  if (levelPassPulseEnd > 0) {
    if (now >= levelPassPulseEnd) {
      btnNextLevel.classList.remove("pulsing");
      levelPassPulseEnd = 0;
      levelPassIdleAt = now;
    }
    return;
  }
  if (now - levelPassIdleAt >= 3000) {
    btnNextLevel.classList.add("pulsing");
    levelPassPulseEnd = now + 3000;
  }
}

levelPass.addEventListener("pointerdown", noteLevelPassActivity);
btnNextLevel.addEventListener("click", () => {
  hideLevelPass();
  const next = currentLevel + 1;
  if (next <= MAX_LEVEL && isLevelUnlocked(next)) startLevel(next);
  else returnToMenu();
});
btnBackMenu.addEventListener("click", () => {
  hideLevelPass();
  returnToMenu();
});

const menuShell = document.getElementById("menu-shell");
const levelMenu = document.getElementById("level-menu");
const gameUi = document.getElementById("game-ui");
const arenasScroll = document.getElementById("arenas-scroll");
let levelButtons = [];

let currentMenuArena = 1;
const arenaPrevBtn = document.getElementById("arena-prev");
const arenaNextBtn = document.getElementById("arena-next");
const menuWalletEl = document.getElementById("menu-wallet");

// Background Image Manager
let currentBgIndex = 1;
let currentBgType = "menu";
let bgOverlay = null;

function updateBodyBackground(smooth = true) {
  if (typeof smooth === "object") smooth = false; // Handle matchMedia Event objects
  
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  const folder = isMobile ? "mobile" : "Desktop";
  const bgUrl = `images/backgroundImages/${folder}/${BG_IMAGE}.png`;
  // Trailing color is a fallback layer shown while the image loads — never black.
  const bgStyle = `linear-gradient(rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.45)), url('${bgUrl}') no-repeat center center / cover #eef5fc`;

  if (!bgOverlay) {
    bgOverlay = document.getElementById("bg-overlay");
    if (!bgOverlay) {
      bgOverlay = document.createElement("div");
      bgOverlay.id = "bg-overlay";
      document.body.appendChild(bgOverlay);
    }
  }

  if (!smooth) {
    document.body.style.background = bgStyle;
    document.body.style.backgroundAttachment = "fixed";
    bgOverlay.style.opacity = "0";
    return;
  }

  // Cross-fade background transition
  bgOverlay.style.background = bgStyle;
  bgOverlay.style.backgroundAttachment = "fixed";
  
  requestAnimationFrame(() => {
    bgOverlay.style.opacity = "1";
  });

  setTimeout(() => {
    document.body.style.background = bgStyle;
    document.body.style.backgroundAttachment = "fixed";
    bgOverlay.style.opacity = "0";
  }, 500);
}

function setRandomLevelBackground() {
  // Background no longer changes per level — one fixed backdrop everywhere.
  currentBgType = "level";
  currentBgIndex = 1;
  updateBodyBackground(true);
}

function setRandomMenuBackground() {
  currentBgType = "menu";
  currentBgIndex = 1; // Locked constantly to bg1 for the arena menu background
  updateBodyBackground(true);
}

function updateActiveArenaUI(arena) {
  const levelMenu = document.getElementById("level-menu");
  const menuShell = document.getElementById("menu-shell");
  if (!levelMenu || !menuShell) return;
  for (let a = 1; a <= 5; a++) {
    const className = "active-arena-" + a;
    levelMenu.classList.toggle(className, a === arena);
    menuShell.classList.toggle(className, a === arena);
  }
}

window.matchMedia("(max-width: 768px)").addEventListener("change", () => updateBodyBackground(false));

function scrollToMenuArena(arena, smooth) {
  currentMenuArena = Math.max(1, Math.min(5, arena));
  if (arenasScroll) {
    const panel = arenasScroll.querySelector(
      '.arena-panel[data-arena="' + currentMenuArena + '"]'
    );
    if (panel) panel.scrollIntoView({ inline: "start", behavior: smooth ? "smooth" : "auto" });
  }
  if (arenaPrevBtn) arenaPrevBtn.disabled = currentMenuArena <= 1;
  if (arenaNextBtn) arenaNextBtn.disabled = currentMenuArena >= 5;
  updateActiveArenaUI(currentMenuArena);
}

function buildLevelMenu() {
  if (!arenasScroll) return;
  arenasScroll.innerHTML = "";
  levelButtons = [];
  for (let arena = 1; arena <= 5; arena++) {
    const panel = document.createElement("div");
    panel.className = "arena-panel arena-theme-" + arena;
    panel.dataset.arena = String(arena);

    const header = document.createElement("div");
    header.className = "arena-header";
    const title = document.createElement("p");
    title.className = "arena-title";
    title.textContent = "Arena " + arena;
    const name = document.createElement("h2");
    name.className = "arena-name";
    name.textContent = ARENA_NAMES[arena - 1];
    header.appendChild(title);
    header.appendChild(name);

    const grid = document.createElement("div");
    grid.className = "arena-level-grid";

    for (let slot = 0; slot < 20; slot++) {
      const n = (arena - 1) * 20 + slot + 1;
      const btn = document.createElement("div");
      btn.className = "level-btn" + (isLevelUnlocked(n) ? " active" : " locked");
      btn.id = "btn-level-" + n;
      btn.textContent = String(n);
      grid.appendChild(btn);
      levelButtons.push(btn);
      btn.addEventListener("click", () => {
        regenHearts();
        if (isLevelUnlocked(n) && hearts > 0) startLevel(n);
        else renderHearts();
      });
    }

    panel.appendChild(header);
    panel.appendChild(grid);
    arenasScroll.appendChild(panel);
  }
  scrollToMenuArena(menuFocusArena(), false);
}
buildLevelMenu();
const playHearts = document.getElementById("play-hearts");
const menuBtn = document.getElementById("menu-btn");

if (arenaPrevBtn) {
  arenaPrevBtn.addEventListener("click", () => scrollToMenuArena(currentMenuArena - 1, true));
}
if (arenaNextBtn) {
  arenaNextBtn.addEventListener("click", () => scrollToMenuArena(currentMenuArena + 1, true));
}
if (arenasScroll) {
  arenasScroll.addEventListener("scroll", () => {
    const w = arenasScroll.offsetWidth;
    if (w <= 0) return;
    const idx = Math.round(arenasScroll.scrollLeft / w);
    const arena = Math.max(1, Math.min(5, idx + 1));
    if (arena !== currentMenuArena) {
      currentMenuArena = arena;
      if (arenaPrevBtn) arenaPrevBtn.disabled = currentMenuArena <= 1;
      if (arenaNextBtn) arenaNextBtn.disabled = currentMenuArena >= 5;
      updateActiveArenaUI(currentMenuArena);
    }
  }, { passive: true });
}

// Five ♥ glyphs, filled up to the current heart count.
function heartsHtml() {
  let s = "";
  for (let i = 0; i < MAX_HEARTS; i++)
    s += '<span class="' + (i < hearts ? "heart-full" : "heart-empty") + '">♥</span>';
  return s;
}
// Update the menu bar (with a regen countdown) and the in-game HUD lives.
function renderHearts() {
  const html = heartsHtml();
  const regen = hearts < MAX_HEARTS
    ? '<span class="menu-regen"> · ' + fmtTime(msToNextHeart()) + "</span>"
    : "";
  if (menuWalletEl) {
    menuWalletEl.innerHTML =
      '<div class="wallet-hearts"><span>' + html + regen + "</span></div>" +
      '<div class="wallet-divider"></div>' +
      '<div class="menu-coins">' + coinsDisplayHtml() + "</div>";
  }
  playHearts.innerHTML = html;
  const playCoins = document.getElementById("play-coins");
  if (playCoins) playCoins.innerHTML = coinsDisplayHtml();
}

// Paint the menu: sequential progress + first level of each arena always open.
function refreshMenu() {
  levelButtons.forEach((btn, i) => {
    const unlocked = isLevelUnlocked(i + 1);
    btn.classList.toggle("active", unlocked);
    btn.classList.toggle("locked", !unlocked);
  });
  renderHearts();
  scrollToMenuArena(menuFocusArena(), true);
}



// Begin (or restart) a level: difficulty, grid size, fresh seed, board. Costs
// nothing up front — but with no lives left you can't play, so bounce to menu.
function startLevel(level) {
  autoFinishing = false;
  hideLevelPass();
  clearCoinRain();
  regenHearts();
  if (hearts <= 0) { returnToMenu(); return; }

  const cfg = levelConfig(level);
  currentLevel = level;
  currentLevelCfg = cfg;
  setRandomLevelBackground();
  WIDTH = cfg.gridW;
  HEIGHT = cfg.gridH;
  levelTarget = cfg.target || 0;
  levelMoves = cfg.moves;
  hintsEnabled = cfg.hints;
  seed = (seed * 1664525 + 1013904223) >>> 0;

  menuShell.classList.remove("show");
  levelMenu.classList.remove("show-grid");
  gameUi.style.display = "flex";
  resizeBoard();
  inLevel = true;
  newGame();
}

function clearBoardFx() {
  particles = [];
  safeAnims = [];
  safeExplosions = [];
  idolExplosions = [];
  safeBlastCenters = [];
  safeBlockers.clear();
  idolAnims = [];
  idolBlockers.clear();
  comboPopup = null;
  passLevelPopup = null;
  if (fx && fxCtx) fxCtx.clearRect(0, 0, fx.width, fx.height);
}

function returnToMenu() {
  hideLevelPass();
  clearCoinRain();
  clearBoardFx();
  resolving = false;
  boardAnimating = false;
  cascadePromise = null;
  hint = null;
  inLevel = false;
  gameOver = false;
  gameUi.style.display = "none";
  menuShell.classList.add("show");
  levelMenu.style.removeProperty("display");
  levelMenu.classList.add("show-grid");
  
  setRandomMenuBackground();
  updateActiveArenaUI(currentMenuArena);

  refreshMenu();
}

menuBtn.addEventListener("click", returnToMenu);

// Loss overlay only — wins use the level-pass buttons.
function onOverlayTap() {
  if (!gameOver || won) return;
  startLevel(currentLevel);
}
overlay.addEventListener("pointerup", (e) => {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  onOverlayTap();
});

// Lives persist across sessions and refill in real time; tick the regen + UI
// once a second so the menu countdown stays live and hearts reappear on time.
loadHearts();
loadCoins();
regenHearts();
renderHearts();
setInterval(() => { regenHearts(); renderHearts(); }, 1000);

setRandomMenuBackground();
updateActiveArenaUI(menuFocusArena());
refreshMenu();
menuShell.classList.add("show");
levelMenu.classList.add("show-grid");

// One render loop for the whole app; it no-ops until a level is in progress.
requestAnimationFrame(tick);

window.MAX_LEVEL = MAX_LEVEL;
window.distributeChains = distributeChains;
window.distributeIdols = distributeIdols;
window.distributeSafes = distributeSafes;
window.chainPlacementForArena = chainPlacementForArena;
window.chainPlacementForArena2 = chainPlacementForArena2;
window.idolPlacementForArena = chainPlacementForArena;
window.idolPlacementForArena2 = chainPlacementForArena2;
window.buildVoidCells = buildVoidCells;
LEVEL_DEFINITIONS = window.buildAllLevels();

