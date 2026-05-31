// MatchFinder.cs  — place in Assets/Scripts/Core/
// Pure C#, NO UnityEngine dependency. Finds all cells that are part of a
// horizontal or vertical run of 3+ identical tiles.

using System.Collections.Generic;

public static class MatchFinder
{
    public const int Empty = -1;

    // Returns the set of (x,y) cells that are part of any 3+ match.
    public static HashSet<(int x, int y)> FindMatches(int[,] grid, int width, int height)
    {
        var matched = new HashSet<(int x, int y)>();

        // Horizontal runs
        for (int y = 0; y < height; y++)
        {
            int runStart = 0;
            for (int x = 1; x <= width; x++)
            {
                bool same = x < width && grid[x, y] != Empty && grid[x, y] == grid[runStart, y];
                if (!same)
                {
                    if (x - runStart >= 3 && grid[runStart, y] != Empty)
                        for (int k = runStart; k < x; k++) matched.Add((k, y));
                    runStart = x;
                }
            }
        }

        // Vertical runs
        for (int x = 0; x < width; x++)
        {
            int runStart = 0;
            for (int y = 1; y <= height; y++)
            {
                bool same = y < height && grid[x, y] != Empty && grid[x, y] == grid[x, runStart];
                if (!same)
                {
                    if (y - runStart >= 3 && grid[x, runStart] != Empty)
                        for (int k = runStart; k < y; k++) matched.Add((x, k));
                    runStart = y;
                }
            }
        }

        return matched;
    }
}
