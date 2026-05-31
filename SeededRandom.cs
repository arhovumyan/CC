// SeededRandom.cs  — place in Assets/Scripts/Core/
// Pure C#, NO UnityEngine dependency. Deterministic: same seed => same sequence
// on every device. Use this for ALL tile generation. Never use UnityEngine.Random.
// (mulberry32 algorithm)

public class SeededRandom
{
    private uint _state;

    public SeededRandom(uint seed)
    {
        _state = seed;
    }

    public uint NextUInt()
    {
        _state += 0x6D2B79F5u;
        uint t = _state;
        t = (t ^ (t >> 15)) * (t | 1u);
        t ^= t + (t ^ (t >> 7)) * (t | 61u);
        return t ^ (t >> 14);
    }

    // Returns an int in [0, maxExclusive)
    public int Next(int maxExclusive)
    {
        return (int)(NextUInt() % (uint)maxExclusive);
    }
}
