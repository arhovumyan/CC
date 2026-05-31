// Board.cs  — place in Assets/Scripts/Core/
// Pure C#, NO UnityEngine dependency. THE SINGLE SOURCE OF TRUTH for game state.
// Convention: grid[x, y], y = 0 is the BOTTOM row, y = height-1 is the TOP.
// Tiles fall toward y = 0. New tiles spawn at the top.
//
// You can run/verify this whole class in a console with no Unity scene.

using System.Collections.Generic;

public class Board
{
    public readonly int Width;
    public readonly int Height;
    public readonly int ColorCount;

    private readonly int[,] _grid;
    private readonly SeededRandom _rng;

    public Board(int width, int height, int colorCount, uint seed)
    {
        Width = width;
        Height = height;
        ColorCount = colorCount;
        _grid = new int[width, height];
        _rng = new SeededRandom(seed);

        FillNoMatches();

        // Extremely rare at 8x8x6, but guarantee the player has a move to make.
        int safety = 0;
        while (!HasValidMove() && safety++ < 50)
            FillNoMatches();
    }

    public int Get(int x, int y) => _grid[x, y];

    // ---- Generation -------------------------------------------------------

    // Fills the board so that NO 3-in-a-row exists at start (by avoiding the
    // colors that would complete a run), using the seeded RNG.
    private void FillNoMatches()
    {
        for (int x = 0; x < Width; x++)
        {
            for (int y = 0; y < Height; y++)
            {
                int color;
                do
                {
                    color = _rng.Next(ColorCount);
                }
                while (
                    (x >= 2 && _grid[x - 1, y] == color && _grid[x - 2, y] == color) ||
                    (y >= 2 && _grid[x, y - 1] == color && _grid[x, y - 2] == color)
                );
                _grid[x, y] = color;
            }
        }
    }

    // ---- Player actions ---------------------------------------------------

    public bool IsAdjacent(int ax, int ay, int bx, int by)
    {
        int dx = ax - bx; if (dx < 0) dx = -dx;
        int dy = ay - by; if (dy < 0) dy = -dy;
        return dx + dy == 1;
    }

    // Swaps two adjacent tiles. If the swap creates at least one match it stays
    // (returns true). Otherwise it is reverted (returns false) — classic match-3 rule.
    public bool TrySwap(int ax, int ay, int bx, int by)
    {
        if (!IsAdjacent(ax, ay, bx, by)) return false;

        Swap(ax, ay, bx, by);
        if (MatchFinder.FindMatches(_grid, Width, Height).Count > 0)
            return true;

        Swap(ax, ay, bx, by); // revert
        return false;
    }

    private void Swap(int ax, int ay, int bx, int by)
    {
        int tmp = _grid[ax, ay];
        _grid[ax, ay] = _grid[bx, by];
        _grid[bx, by] = tmp;
    }

    // ---- Resolution loop --------------------------------------------------

    // Performs ONE pass: clears current matches, applies gravity, refills.
    // Returns the number of tiles cleared this pass (0 means the board is settled).
    // Call repeatedly until it returns 0 to fully resolve cascades.
    public int ResolveStep()
    {
        var matched = MatchFinder.FindMatches(_grid, Width, Height);
        if (matched.Count == 0) return 0;

        foreach (var (x, y) in matched)
            _grid[x, y] = MatchFinder.Empty;

        ApplyGravity();
        Refill();
        return matched.Count;
    }

    private void ApplyGravity()
    {
        for (int x = 0; x < Width; x++)
        {
            int writeY = 0;
            for (int y = 0; y < Height; y++)
            {
                if (_grid[x, y] != MatchFinder.Empty)
                {
                    _grid[x, writeY] = _grid[x, y];
                    if (writeY != y) _grid[x, y] = MatchFinder.Empty;
                    writeY++;
                }
            }
            // remaining cells above writeY are already Empty
        }
    }

    private void Refill()
    {
        for (int x = 0; x < Width; x++)
            for (int y = 0; y < Height; y++)
                if (_grid[x, y] == MatchFinder.Empty)
                    _grid[x, y] = _rng.Next(ColorCount);
    }

    // ---- Solver -----------------------------------------------------------

    // True if any single adjacent swap would create a match.
    public bool HasValidMove()
    {
        for (int x = 0; x < Width; x++)
        {
            for (int y = 0; y < Height; y++)
            {
                if (x + 1 < Width && WouldMatch(x, y, x + 1, y)) return true;
                if (y + 1 < Height && WouldMatch(x, y, x, y + 1)) return true;
            }
        }
        return false;
    }

    private bool WouldMatch(int ax, int ay, int bx, int by)
    {
        Swap(ax, ay, bx, by);
        bool ok = MatchFinder.FindMatches(_grid, Width, Height).Count > 0;
        Swap(ax, ay, bx, by); // restore
        return ok;
    }

    // Regenerate the board if the player is stuck. Keeps the RNG stream going,
    // so it stays deterministic.
    public void Reshuffle()
    {
        int safety = 0;
        do { FillNoMatches(); }
        while (
            (MatchFinder.FindMatches(_grid, Width, Height).Count > 0 || !HasValidMove())
            && safety++ < 50
        );
    }
}
