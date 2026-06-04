/* Level types, objectives, and 100-level definitions (Candy Crush-style). */
(function (G) {
  "use strict";

  const COLOR_NAMES = ["red", "green", "yellow", "blue", "purple"];

  function pillowOpacity(layers) {
    if (layers >= 3) return 0.7;
    if (layers === 2) return 0.5;
    return 0.2;
  }

  function playableCells(w, h, voidCells) {
    const keys = [];
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++)
        if (!voidCells.has(x + "," + y)) keys.push(x + "," + y);
    return keys;
  }

  function generatePillowLayout(w, h, count, style, voidCells, rng) {
    const pool = playableCells(w, h, voidCells);
    const picks = [];
    const corner = (x, y) =>
      (x <= 1 || x >= w - 2) && (y <= 1 || y >= h - 2);
    const bottom = (x, y) => y <= 1;
    const filtered =
      style === "corners" ? pool.filter((k) => { const [x, y] = k.split(",").map(Number); return corner(x, y); })
      : style === "bottom" ? pool.filter((k) => { const [x, y] = k.split(",").map(Number); return bottom(x, y); })
      : pool;
    for (let i = filtered.length - 1; i > 0; i--) {
      const j = rng.next(i + 1);
      const t = filtered[i]; filtered[i] = filtered[j]; filtered[j] = t;
    }
    for (let i = 0; i < Math.min(count, filtered.length); i++) {
      const [x, y] = filtered[i].split(",").map(Number);
      const tier = rng.next(100);
      const layers = tier < 40 ? 1 : tier < 75 ? 2 : 3;
      picks.push({ x, y, layers });
    }
    return picks;
  }

  function generatePathCells(w, h, voidCells) {
    const cells = [];
    const maxY = Math.max(0, Math.ceil(h * 0.78) - 1);
    let x = 0;
    let y = 0;
    const seen = new Set();
    while (cells.length < w + maxY + 2) {
      const k = x + "," + y;
      if (!voidCells.has(k) && !seen.has(k) && y <= maxY) {
        cells.push(k);
        seen.add(k);
      }
      if (x < w - 1) x++;
      else if (y < maxY) y++;
      else break;
    }
    if (cells.length < 3) {
      for (let ix = 0; ix < w && cells.length < 5; ix++) {
        const k = ix + ",0";
        if (!voidCells.has(k)) cells.push(k);
      }
    }
    return cells;
  }

  function generateExitCells(w, h, voidCells, count, rng) {
    const exits = new Set();
    const bottom = [];
    for (let x = 0; x < w; x++) {
      const k = x + ",0";
      if (!voidCells.has(k)) bottom.push(k);
    }
    for (let i = bottom.length - 1; i > 0; i--) {
      const j = rng.next(i + 1);
      const t = bottom[i]; bottom[i] = bottom[j]; bottom[j] = t;
    }
    for (let i = 0; i < Math.min(count, bottom.length); i++) exits.add(bottom[i]);
    return exits;
  }

  function assignLevelDefinition(n, arena, slot, p, finale, w, h, voidCells, open) {
    const rng = { next: (m) => ((n * 7919 + slot * 997 + arena * 101) % m) };
    const objectives = [];
    let chains = { c1: 0, c2: 0, c3: 0, c4: 0 };
    let chainPlacement = null;
    let pillows = [];
    let drops = null;
    let path = null;
    let lines = [3, 6];
    let levelType = "score";

    if (arena === 1) {
      if (slot <= 6) {
        levelType = "score";
        objectives.push({ type: "score", target: Math.round(600 + n * 85 + (finale ? 400 : 0)) });
      } else if (slot <= 12) {
        levelType = "pillows";
        objectives.push({ type: "pillows" });
        const cnt = 4 + Math.floor(p * 10) + (finale ? 4 : 0);
        pillows = generatePillowLayout(w, h, cnt, slot <= 9 ? "corners" : "bottom", voidCells, rng);
      } else if (slot < 20) {
        levelType = "order";
        const color = (slot - 13) % 5;
        objectives.push({
          type: "collect",
          color,
          amount: 12 + Math.floor(p * 22),
          label: COLOR_NAMES[color],
        });
      } else {
        levelType = "mixed";
        objectives.push({ type: "score", target: Math.round(2800) });
        objectives.push({ type: "pillows" });
        pillows = generatePillowLayout(w, h, 10 + Math.floor(p * 6), "spread", voidCells, rng);
      }
      lines = [3, 5 + Math.floor(p * 5)];
    } else if (arena === 2) {
      const chainTotal = Math.min(
        Math.floor(open * 0.3),
        2 + Math.floor(p * 12) + (finale ? 5 : 0)
      );
      chains = G.distributeChains(chainTotal, arena, finale, p);
      chainPlacement = G.chainPlacementForArena(2, slot, finale);

      if (slot <= 5) {
        levelType = "idols";
        objectives.push({ type: "idols" });
      } else if (slot <= 10) {
        levelType = "pillows";
        objectives.push({ type: "pillows" });
        objectives.push({ type: "idols" });
        pillows = generatePillowLayout(w, h, 5 + Math.floor(p * 8), "corners", voidCells, rng);
      } else if (slot <= 15) {
        levelType = "order";
        objectives.push({ type: "idols", amount: chainTotal });
        const col = slot % 5;
        objectives.push({
          type: "collect",
          color: col,
          amount: 18 + Math.floor(p * 20),
          label: COLOR_NAMES[col],
        });
      } else if (slot < 20) {
        levelType = "order";
        objectives.push({ type: "idols" });
        objectives.push({ type: "stripes", amount: 2 + Math.floor(p * 3) });
      } else {
        levelType = "mixed";
        objectives.push({ type: "pillows" });
        objectives.push({ type: "idols" });
        objectives.push({ type: "combos", amount: 3 });
        pillows = generatePillowLayout(w, h, 12, "bottom", voidCells, rng);
      }
      lines = [1, 2 + Math.floor(p * 2)];
    } else if (arena === 3) {
      chainPlacement = G.chainPlacementForArena(3, slot, finale);
      const chainTotal = Math.min(
        Math.floor(open * 0.82),
        Math.floor(open * (0.48 + p * 0.32)) + (finale ? 10 : 2)
      );
      chains = G.distributeChains(Math.max(10, chainTotal), arena, finale, p);

      if (slot <= 4) {
        levelType = "idols";
        objectives.push({ type: "idols" });
      } else if (slot <= 8) {
        levelType = "idols";
        objectives.push({ type: "idols" });
        const dropN = 1 + Math.floor(p * 2);
        objectives.push({ type: "drops", amount: dropN });
        drops = { count: dropN, exits: generateExitCells(w, h, voidCells, dropN + 1, rng) };
      } else if (slot <= 12) {
        levelType = "mixed";
        objectives.push({ type: "idols" });
        objectives.push({ type: "stripes", amount: 2 + Math.floor(p * 2) });
      } else if (slot <= 16) {
        levelType = "path";
        path = { cells: generatePathCells(w, h, voidCells), block: 0.5 + p * 0.25 };
        objectives.push({ type: "path" });
        objectives.push({ type: "idols" });
      } else if (slot < 20) {
        levelType = "mixed";
        objectives.push({ type: "idols" });
        objectives.push({ type: "combos", amount: 2 + Math.floor(p * 2) });
        const col = slot % 5;
        objectives.push({
          type: "collect",
          color: col,
          amount: 20 + Math.floor(p * 18),
          label: COLOR_NAMES[col],
        });
      } else {
        levelType = "mixed";
        objectives.push({ type: "idols" });
        objectives.push({ type: "drops", amount: 3 });
        objectives.push({ type: "combos", amount: 3 });
        drops = { count: 3, exits: generateExitCells(w, h, voidCells, 4, rng) };
      }
      lines = [1, 2 + Math.floor(p * 2)];
    } else if (arena === 4) {
      chainPlacement = G.chainPlacementForArena(4, slot, finale);
      const chainTotal = Math.min(
        Math.floor(open * (0.55 + p * 0.2)),
        10 + Math.floor(p * 14) + (finale ? 8 : 0)
      );
      chains = G.distributeChains(chainTotal, arena, finale, p);

      if (slot <= 5) {
        levelType = "mixed";
        objectives.push({ type: "pillows" });
        objectives.push({ type: "idols" });
        pillows = generatePillowLayout(w, h, 8 + Math.floor(p * 6), "corners", voidCells, rng);
      } else if (slot <= 10) {
        levelType = "mixed";
        objectives.push({ type: "drops", amount: 2 + Math.floor(p * 2) });
        objectives.push({ type: "idols" });
        drops = { count: 2 + Math.floor(p * 2), exits: generateExitCells(w, h, voidCells, 4, rng) };
      } else if (slot <= 15) {
        levelType = "order";
        objectives.push({
          type: "collect",
          color: rng.next(5),
          amount: 30 + Math.floor(p * 18),
          label: COLOR_NAMES[rng.next(5)],
        });
        objectives.push({ type: "idols" });
        objectives.push({ type: "combos", amount: 2 + Math.floor(p * 2) });
      } else if (slot < 20) {
        levelType = "path";
        path = { cells: generatePathCells(w, h, voidCells), block: 0.7 };
        objectives.push({ type: "path" });
        objectives.push({ type: "pillows" });
        pillows = generatePillowLayout(w, h, 6 + Math.floor(p * 5), "spread", voidCells, rng);
      } else {
        levelType = "mixed";
        objectives.push({ type: "pillows" });
        objectives.push({ type: "drops", amount: 3 });
        objectives.push({ type: "idols" });
        objectives.push({ type: "combos", amount: 4 });
        pillows = generatePillowLayout(w, h, 10, "corners", voidCells, rng);
        drops = { count: 3, exits: generateExitCells(w, h, voidCells, 4, rng) };
      }
      lines = [2, 3 + Math.floor(p * 3)];
    } else {
      chainPlacement = G.chainPlacementForArena(5, slot, finale);
      const chainTotal = Math.min(
        Math.floor(open * (0.62 + p * 0.22)),
        12 + Math.floor(p * 16) + (finale ? 10 : 0)
      );
      chains = G.distributeChains(chainTotal, arena, finale, p);

      if (slot <= 4) {
        levelType = "mixed";
        objectives.push({ type: "score", target: Math.round(5000 + p * 3000) });
        objectives.push({ type: "idols" });
      } else if (slot <= 9) {
        levelType = "mixed";
        objectives.push({ type: "pillows" });
        objectives.push({ type: "idols" });
        objectives.push({ type: "stripes", amount: 3 + Math.floor(p * 2) });
        pillows = generatePillowLayout(w, h, 10 + Math.floor(p * 4), "spread", voidCells, rng);
      } else if (slot <= 14) {
        levelType = "mixed";
        objectives.push({ type: "drops", amount: 3 + Math.floor(p * 2) });
        objectives.push({ type: "idols" });
        objectives.push({ type: "combos", amount: 3 + Math.floor(p * 2) });
        drops = { count: 3, exits: generateExitCells(w, h, voidCells, 5, rng) };
      } else if (slot < 20) {
        levelType = "mixed";
        objectives.push({ type: "path" });
        objectives.push({ type: "idols" });
        objectives.push({
          type: "collect",
          color: rng.next(5),
          amount: 35 + Math.floor(p * 20),
          label: COLOR_NAMES[rng.next(5)],
        });
        path = { cells: generatePathCells(w, h, voidCells), block: 0.85 };
      } else {
        levelType = "mixed";
        objectives.push({ type: "score", target: Math.round(9000) });
        objectives.push({ type: "pillows" });
        objectives.push({ type: "drops", amount: 4 });
        objectives.push({ type: "idols" });
        objectives.push({ type: "combos", amount: 5 });
        objectives.push({ type: "stripes", amount: 4 });
        pillows = generatePillowLayout(w, h, 14, "spread", voidCells, rng);
        drops = { count: 4, exits: generateExitCells(w, h, voidCells, 5, rng) };
        path = { cells: generatePathCells(w, h, voidCells), block: 0.9 };
      }
      lines = [1, 2 + Math.floor(p * 2)];
    }

    return {
      level: n,
      arena,
      slot,
      finale,
      w,
      h,
      voidCells,
      voidCount: voidCells.size,
      objectives,
      levelType,
      chains,
      idols: chains,
      chainPlacement,
      idolPlacement: chainPlacement,
      pillows,
      drops,
      path,
      lines,
      target: objectives.find((o) => o.type === "score")?.target || 0,
    };
  }

  function movesForObjectives(cfg) {
    let moves = 14;
    for (const obj of cfg.objectives) {
      if (obj.type === "score") moves = Math.max(moves, Math.ceil(obj.target / 42) + 4);
      if (obj.type === "pillows") moves += 4 + Math.floor((cfg.pillows?.length || 6) * 0.6);
      if (obj.type === "idols") {
        const idols = cfg.idols || cfg.chains || {};
        const t =
          (idols.c1 || 0) +
          (idols.c2 || 0) +
          (idols.c3 || 0) +
          (idols.c4 || 0);
        const weighted =
          (idols.c1 || 0) +
          (idols.c2 || 0) * 1.35 +
          (idols.c3 || 0) * 1.75 +
          (idols.c4 || 0) * 2.35;
        moves += Math.ceil(Math.max(t * 1.05, weighted)) + 3;
      }
      if (obj.type === "drops") moves += 5 + (obj.amount || 1) * 4;
      if (obj.type === "collect") moves += 4 + Math.ceil((obj.amount || 10) / 8);
      if (obj.type === "stripes") moves += 3 + (obj.amount || 1) * 2;
      if (obj.type === "combos") moves += 4 + (obj.amount || 1) * 3;
      if (obj.type === "path") moves += 8 + Math.floor((cfg.path?.cells?.length || 8) * 0.35);
    }
    moves = Math.ceil(moves * (1 + cfg.voidCount / Math.max(1, cfg.w * cfg.h) * 0.08));
    if (cfg.finale) moves -= 2;
    return Math.max(9, Math.min(moves, 42));
  }

  G.COLOR_NAMES = COLOR_NAMES;
  G.pillowOpacity = pillowOpacity;
  G.assignLevelDefinition = assignLevelDefinition;
  G.movesForObjectives = movesForObjectives;
  G.buildAllLevels = function buildAllLevels() {
    const out = [];
    for (let n = 1; n <= G.MAX_LEVEL; n++) {
      const arena = Math.ceil(n / 20);
      const slot = ((n - 1) % 20) + 1;
      const p = (slot - 1) / 19;
      const finale = slot === 20;
      let w, h;
      if (arena === 1) {
        w = h = 6 + Math.min(2, Math.floor(p * 2.5));
        if (finale) w = h = 8;
      } else if (arena === 2) {
        w = h = 7 + Math.min(2, Math.floor(p * 2.5));
        if (finale) w = h = 9;
      } else if (arena === 3) {
        w = h = 8 + Math.min(2, Math.floor(p * 2.5));
        if (finale) w = h = 10;
      } else if (arena === 4) {
        w = h = 9 + Math.min(2, Math.floor(p * 2));
        if (finale) { w = 11; h = 10; }
      } else {
        w = h = 10 + Math.min(2, Math.floor(p * 2));
        if (finale) { w = 12; h = 11; }
      }
      let holes = "none";
      if (arena === 4) {
        const pats = ["corners", "trenches", "pillars", "split", "island", "ring"];
        holes = slot <= 2 ? (slot === 1 ? "corners" : "none") : pats[(slot - 3) % pats.length];
        if (finale) holes = "split";
      } else if (arena === 5) {
        const pats = ["split", "island", "trenches", "pillars", "ring", "corners"];
        holes = slot <= 2 ? "corners" : pats[Math.floor(p * pats.length)];
        if (finale) holes = "trenches";
      }
      const voidCells = G.buildVoidCells(holes, w, h);
      const open = w * h - voidCells.size;
      const def = assignLevelDefinition(n, arena, slot, p, finale, w, h, voidCells, open);
      def.moves = movesForObjectives(def);
      def.hints = arena === 1 && n <= 10;
      out.push(def);
    }
    return out;
  };
})(typeof window !== "undefined" ? window : globalThis);
