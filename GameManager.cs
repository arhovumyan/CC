// GameManager.cs  — place in Assets/Scripts/Game/
// The ONLY Unity-facing file. It reads the Board (pure logic) and draws it.
// It never puts game rules inside GameObjects.
//
// SETUP (≈60 seconds):
//   1. New empty 2D scene.
//   2. Create an empty GameObject, name it "Game".
//   3. Drag this script onto it.
//   4. Press Play. Click a tile, then click an adjacent tile to swap.
//   (No sprites to import, no canvas to build — it's all generated at runtime.)

using System.Collections;
using UnityEngine;

public class GameManager : MonoBehaviour
{
    [Header("Board")]
    public int width = 8;
    public int height = 8;
    public int colorCount = 6;
    public uint seed = 12345;      // same seed => same board, every run
    public float cellSize = 1f;

    [Header("Match")]
    public float matchSeconds = 90f;
    public float cascadeDelay = 0.12f;  // pause between cascade passes so you can SEE chains

    private readonly Color[] _palette = {
        new Color(0.91f, 0.30f, 0.34f), // red
        new Color(0.99f, 0.73f, 0.20f), // orange
        new Color(0.97f, 0.93f, 0.36f), // yellow
        new Color(0.40f, 0.80f, 0.45f), // green
        new Color(0.35f, 0.62f, 0.94f), // blue
        new Color(0.70f, 0.45f, 0.88f), // purple
    };

    private Board _board;
    private SpriteRenderer[,] _tiles;
    private Sprite _square;

    private int _selX = -1, _selY = -1;
    private float _timeLeft;
    private int _score;
    private bool _gameOver;
    private bool _resolving;

    void Start()
    {
        _square = MakeSquareSprite();
        SetupCamera();
        NewGame();
    }

    void NewGame()
    {
        _board = new Board(width, height, colorCount, seed);
        BuildTiles();
        Render();
        _selX = _selY = -1;
        _score = 0;
        _timeLeft = matchSeconds;
        _gameOver = false;
        _resolving = false;
    }

    void Update()
    {
        if (_gameOver)
        {
            if (Input.GetKeyDown(KeyCode.R)) NewGame();
            return;
        }

        _timeLeft -= Time.deltaTime;
        if (_timeLeft <= 0f) { _timeLeft = 0f; _gameOver = true; return; }

        if (!_resolving && Input.GetMouseButtonDown(0))
            HandleClick(Input.mousePosition);
    }

    void HandleClick(Vector3 screenPos)
    {
        Vector3 w = Camera.main.ScreenToWorldPoint(screenPos);
        int gx = Mathf.RoundToInt(w.x / cellSize + (width - 1) / 2f);
        int gy = Mathf.RoundToInt(w.y / cellSize + (height - 1) / 2f);
        if (gx < 0 || gx >= width || gy < 0 || gy >= height) return;

        if (_selX < 0)
        {
            Select(gx, gy);
        }
        else if (_board.IsAdjacent(_selX, _selY, gx, gy))
        {
            int fromX = _selX, fromY = _selY;
            Deselect();
            if (_board.TrySwap(fromX, fromY, gx, gy))
                StartCoroutine(ResolveCascades());
            else
                Render(); // invalid swap was reverted internally
        }
        else
        {
            Deselect();
            Select(gx, gy);
        }
    }

    IEnumerator ResolveCascades()
    {
        _resolving = true;
        int cleared;
        do
        {
            Render();
            yield return new WaitForSeconds(cascadeDelay);
            cleared = _board.ResolveStep();
            if (cleared > 0) _score += cleared * 10;  // simple scoring; chains pay more by volume
        }
        while (cleared > 0);

        Render();
        if (!_board.HasValidMove()) { _board.Reshuffle(); Render(); }
        _resolving = false;
    }

    // ---- Rendering --------------------------------------------------------

    void BuildTiles()
    {
        if (_tiles != null)
            foreach (var t in _tiles) if (t) Destroy(t.gameObject);

        _tiles = new SpriteRenderer[width, height];
        for (int x = 0; x < width; x++)
        for (int y = 0; y < height; y++)
        {
            var go = new GameObject($"Tile_{x}_{y}");
            go.transform.SetParent(transform);
            go.transform.position = CellToWorld(x, y);
            go.transform.localScale = Vector3.one * (cellSize * 0.9f);
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = _square;
            _tiles[x, y] = sr;
        }
    }

    void Render()
    {
        for (int x = 0; x < width; x++)
        for (int y = 0; y < height; y++)
        {
            int c = _board.Get(x, y);
            var sr = _tiles[x, y];
            sr.color = (c < 0) ? new Color(0, 0, 0, 0) : _palette[c % _palette.Length];
            float s = (x == _selX && y == _selY) ? 1.15f : 0.9f;
            sr.transform.localScale = Vector3.one * (cellSize * s);
        }
    }

    void Select(int x, int y) { _selX = x; _selY = y; Render(); }
    void Deselect() { _selX = _selY = -1; }

    Vector3 CellToWorld(int x, int y) =>
        new Vector3((x - (width - 1) / 2f) * cellSize, (y - (height - 1) / 2f) * cellSize, 0f);

    // ---- HUD (OnGUI = zero setup; replace with real UI later) -------------

    void OnGUI()
    {
        GUI.skin.label.fontSize = 22;
        GUI.Label(new Rect(12, 8, 400, 30), $"Score: {_score}");
        GUI.Label(new Rect(12, 38, 400, 30), $"Time: {Mathf.CeilToInt(_timeLeft)}");
        if (_gameOver)
        {
            GUI.skin.label.fontSize = 34;
            GUI.Label(new Rect(0, Screen.height / 2 - 40, Screen.width, 50),
                $"TIME!  Final score: {_score}", Center());
            GUI.skin.label.fontSize = 20;
            GUI.Label(new Rect(0, Screen.height / 2 + 10, Screen.width, 30),
                "Press R to play again", Center());
        }
    }

    GUIStyle Center()
    {
        var s = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter };
        s.fontSize = GUI.skin.label.fontSize;
        return s;
    }

    // ---- One-time setup helpers ------------------------------------------

    Sprite MakeSquareSprite()
    {
        var tex = new Texture2D(1, 1) { filterMode = FilterMode.Point };
        tex.SetPixel(0, 0, Color.white);
        tex.Apply();
        return Sprite.Create(tex, new Rect(0, 0, 1, 1), new Vector2(0.5f, 0.5f), 1f);
    }

    void SetupCamera()
    {
        var cam = Camera.main;
        if (cam == null)
        {
            var go = new GameObject("Main Camera");
            go.tag = "MainCamera";
            cam = go.AddComponent<Camera>();
        }
        cam.orthographic = true;
        cam.orthographicSize = (height * cellSize) / 2f + 1f;
        cam.transform.position = new Vector3(0, 0, -10);
        cam.backgroundColor = new Color(0.12f, 0.12f, 0.15f);
        cam.clearFlags = CameraClearFlags.SolidColor;
    }
}
