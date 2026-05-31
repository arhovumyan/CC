# Match Duel — Path A single-player prototype

An intentionally ugly, single-player match-3 to answer ONE question:
**is the core loop fun enough to keep replaying?** Nothing else matters yet.

## Setup (~60 seconds)
1. Unity 6, create a new **2D (Built-in / URP both fine)** project.
2. Put the files in this structure:
   ```
   Assets/Scripts/
     Core/    SeededRandom.cs   MatchFinder.cs   Board.cs
     Game/    GameManager.cs
   ```
   (Folder names are cosmetic — Unity finds scripts anywhere under Assets. The
   split exists to enforce the rule below.)
3. New empty scene → create an empty GameObject named **Game** → drag
   **GameManager.cs** onto it.
4. Press **Play**. Click a tile, then click an adjacent tile to swap.
   - Valid swap (creates a match) → it clears, cascades, scores.
   - Invalid swap → it snaps back.
   - 90-second timer, then "Press R to play again".

No sprites to import, no Canvas to build, no camera to place — GameManager
generates the square sprite and configures the camera at runtime.

## The one architectural rule
`Core/` is **pure C# with zero UnityEngine references.** All game rules
(matching, gravity, cascades, valid-move detection) live there and could run in
a plain console. `GameManager` only *reads* the board and draws squares. The
moment a rule leaks into a GameObject, the codebase rots — don't let it.

## Knobs to tune (top of GameManager, in the Inspector)
- `seed` — same seed = identical board every run. This is your foundation for
  fair 1v1 later; it's already deterministic.
- `cascadeDelay` — pause between cascade passes so chains are visible.
- `matchSeconds`, `colorCount`, `width`/`height`.

Spend your time here, not on features.

## Deliberately NOT included (do not add until the loop is fun)
Animations/DOTween, particles, sound, special pieces, a second board, a bot,
attacks/garbage, multiplayer, Firebase, accounts, ads, IAP, menus, art.

## The gate
Play it for real. Pass = "we keep wanting to replay it." Runs-without-errors is
not the bar. If it's boring here, an opponent and art won't save it — retune or
rethink the verb before building anything else.

## Notes on correctness
The match/gravity/cascade logic was hand-traced, not machine-tested (no C#
toolchain was available when it was written). If you hit an edge case, the
likely suspects are `MatchFinder.FindMatches` (run boundaries) and
`Board.ApplyGravity` (column compaction). Both are small and readable.
```
