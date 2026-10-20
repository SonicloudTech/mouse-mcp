using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

// Passive acceptance fixture. This program observes genuine window messages only;
// it has no SDK dependency, mouse/keyboard injection, UI Automation invocation, or focus API.
sealed class InputSurface : Form {
    sealed class Pad : Panel {
        public Pad(string name) {
            AccessibleName = name;
            AccessibleRole = AccessibleRole.Pane;
            TabStop = true;
            SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick, true);
            DoubleBuffered = true;
        }
    }

    readonly string output;
    readonly string eventsPath;
    readonly Label clickStatus = new Label();
    readonly Label wheelStatus = new Label();
    readonly Label dragStatus = new Label();
    readonly Label moveStatus = new Label();
    readonly TextBox keyboardInput = new TextBox();
    int keyDowns, keyUps;
    readonly Pad clickPad = new Pad("Click pad");
    readonly Pad wheelPad = new Pad("Wheel pad");
    readonly Pad dragPad = new Pad("Drag pad");
    readonly Rectangle dragStart = new Rectangle(45, 38, 240, 125);
    readonly Rectangle dragEnd = new Rectangle(625, 38, 240, 125);
    int leftClicks, rightClicks, middleClicks, doubleClicks, downs, ups, moves;
    int wheelDelta, wheelEvents, dragSuccesses, dragAttempts;
    bool dragHeld;
    Point dragOrigin, dragLast;
    string lastDrag = "none";
    int moveWrites;
    bool shown;

    InputSurface(string directory, int autoCloseSeconds) {
        output = Path.GetFullPath(directory);
        Directory.CreateDirectory(output);
        eventsPath = Path.Combine(output, "events.jsonl");
        if (File.Exists(eventsPath) || File.Exists(Path.Combine(output, "state.json")))
            throw new InvalidOperationException("Use a fresh evidence directory; existing evidence will not be overwritten.");
        Text = "uMouse hardware acceptance";
        Name = "HardwareInputAcceptance";
        AccessibleName = Text;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(80, 80);
        ClientSize = new Size(960, 680);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Color.WhiteSmoke;
        Font = new Font("Segoe UI", 11);
        var title = new Label { Text = "Passive local input test - no network, SDK or input simulation", Bounds = new Rectangle(20, 15, 920, 30) };
        var exit = new Label { Text = "Keyboard input (no auto-send):", Bounds = new Rectangle(20, 46, 285, 25) };
        Controls.Add(title); Controls.Add(exit);
        keyboardInput.Bounds = new Rectangle(310, 43, 625, 30); keyboardInput.AccessibleName = "Keyboard input"; keyboardInput.TabIndex = 0;
        Controls.Add(keyboardInput); KeyPreview = true;
        KeyDown += delegate(object sender, KeyEventArgs e) { keyDowns++; Log("key_down", ",\"key\":" + Quote(e.KeyCode.ToString()) + ",\"modifiers\":" + Quote(e.Modifiers.ToString())); if (shown) WriteState(); };
        KeyUp += delegate(object sender, KeyEventArgs e) { keyUps++; Log("key_up", ",\"key\":" + Quote(e.KeyCode.ToString()) + ",\"modifiers\":" + Quote(e.Modifiers.ToString())); if (shown) WriteState(); };
        keyboardInput.TextChanged += delegate { Log("text_changed", ",\"text\":" + Quote(keyboardInput.Text)); if (shown) WriteState(); };
        AddStatus(clickStatus, "Click counters", 83);
        AddStatus(wheelStatus, "Wheel counters", 115);
        AddStatus(dragStatus, "Drag counters", 147);
        AddStatus(moveStatus, "Move counters", 179);
        clickPad.Bounds = new Rectangle(25, 225, 440, 190);
        clickPad.BackColor = Color.FromArgb(219, 238, 255);
        wheelPad.Bounds = new Rectangle(495, 225, 440, 190);
        wheelPad.BackColor = Color.FromArgb(233, 244, 215);
        dragPad.Bounds = new Rectangle(25, 440, 910, 210);
        dragPad.BackColor = Color.FromArgb(241, 232, 250);
        clickPad.Paint += delegate(object sender, PaintEventArgs e) { DrawCentered(e.Graphics, clickPad.ClientRectangle, "CLICK PAD\nLeft / double / right / middle"); };
        wheelPad.Paint += delegate(object sender, PaintEventArgs e) { DrawCentered(e.Graphics, wheelPad.ClientRectangle, "WHEEL PAD\nHover here and scroll"); };
        dragPad.Paint += delegate(object sender, PaintEventArgs e) {
            e.Graphics.FillRectangle(Brushes.LightBlue, dragStart);
            e.Graphics.FillRectangle(Brushes.LightGreen, dragEnd);
            DrawCentered(e.Graphics, dragStart, "DRAG START");
            DrawCentered(e.Graphics, dragEnd, "DROP HERE");
            if (dragHeld) e.Graphics.DrawLine(Pens.DarkViolet, dragOrigin, dragLast);
        };
        foreach (Pad pad in new[] {clickPad, wheelPad, dragPad}) {
            Controls.Add(pad);
            pad.MouseDown += delegate(object sender, MouseEventArgs e) {
                downs++;
                if (pad == dragPad && e.Button == MouseButtons.Left && dragStart.Contains(e.Location)) {
                    dragHeld = true; dragOrigin = e.Location; dragLast = e.Location; dragAttempts++;
                    // WinForms capture routes an actual physical release back to this pad.
                    pad.Capture = true;
                }
                LogMouse("down", pad, e); UpdateStatus();
            };
            pad.MouseUp += delegate(object sender, MouseEventArgs e) {
                ups++;
                if (pad == dragPad && e.Button == MouseButtons.Left && dragHeld) {
                    lastDrag = dragEnd.Contains(e.Location) ? "success" : "miss";
                    if (lastDrag == "success") dragSuccesses++;
                    dragHeld = false; pad.Capture = false;
                    LogMouse("drag_" + lastDrag, pad, e);
                }
                LogMouse("up", pad, e); UpdateStatus(); pad.Invalidate();
            };
            pad.MouseClick += delegate(object sender, MouseEventArgs e) {
                if (e.Button == MouseButtons.Left) leftClicks++;
                if (e.Button == MouseButtons.Right) rightClicks++;
                if (e.Button == MouseButtons.Middle) middleClicks++;
                LogMouse("click", pad, e); UpdateStatus();
            };
            pad.MouseDoubleClick += delegate(object sender, MouseEventArgs e) {
                doubleClicks++; LogMouse("double_click", pad, e); UpdateStatus();
            };
            pad.MouseMove += delegate(object sender, MouseEventArgs e) {
                moves++; dragLast = e.Location;
                // Count every message but bound disk/UIA churn during physical trajectories.
                if ((moveWrites++ % 8) == 0) { LogMouse("move", pad, e); UpdateStatus(); }
                if (dragHeld) pad.Invalidate();
            };
            pad.MouseWheel += delegate(object sender, MouseEventArgs e) {
                wheelDelta += e.Delta; wheelEvents++;
                LogMouse("wheel", pad, e); UpdateStatus();
                var handled = e as HandledMouseEventArgs;
                if (handled != null) handled.Handled = true;
            };
        }
        MouseWheel += delegate(object sender, MouseEventArgs e) {
            // Windows can route a wheel message to the containing form when its
            // child panel is not focusable. Count that real message as well.
            wheelDelta += e.Delta; wheelEvents++;
            LogMouse("wheel", this, e); UpdateStatus();
        };
        Shown += delegate { shown = true; Log("ready", ""); UpdateStatus(); };
        Move += delegate { if (shown) WriteState(); };
        FormClosed += delegate { Log("closed", ""); };
        var timer = new Timer();
        timer.Interval = Math.Max(1, autoCloseSeconds) * 1000;
        timer.Tick += delegate { timer.Stop(); Log("auto_close", ""); Close(); };
        timer.Start();
        FormClosed += delegate { timer.Dispose(); };
        UpdateStatus();
    }

    void AddStatus(Label label, string name, int y) {
        label.AccessibleName = name;
        label.Bounds = new Rectangle(25, y, 910, 28);
        Controls.Add(label);
    }
    void DrawCentered(Graphics graphics, Rectangle rect, string text) {
        using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            graphics.DrawString(text, Font, Brushes.Black, rect, format);
    }
    static string Quote(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\""; }
    static string PointJson(Point p) { return "{\"x\":" + p.X + ",\"y\":" + p.Y + "}"; }
    static string RectJson(Rectangle r) { return "{\"left\":" + r.Left + ",\"top\":" + r.Top + ",\"right\":" + r.Right + ",\"bottom\":" + r.Bottom + "}"; }
    Point Center(Control control, Rectangle rect) { return control.PointToScreen(new Point(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2)); }
    void LogMouse(string kind, Control pad, MouseEventArgs e) {
        Log(kind, ",\"pad\":" + Quote(pad.AccessibleName) + ",\"button\":" + Quote(e.Button.ToString()) +
            ",\"client\":" + PointJson(e.Location) + ",\"screen\":" + PointJson(pad.PointToScreen(e.Location)) + ",\"delta\":" + e.Delta);
    }
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern int GetMessageTime();
    void Log(string kind, string fields) {
        fields += ",\"qpc\":" + Stopwatch.GetTimestamp() + ",\"qpcFrequency\":" + Stopwatch.Frequency + ",\"messageTime\":" + unchecked((uint)GetMessageTime());
        File.AppendAllText(eventsPath, "{\"utc\":" + Quote(DateTime.UtcNow.ToString("O")) + ",\"kind\":" + Quote(kind) + fields + "}\n", new UTF8Encoding(false));
    }
    void UpdateStatus() {
        clickStatus.Text = "Clicks left " + leftClicks + " right " + rightClicks + " middle " + middleClicks + " double " + doubleClicks + " down " + downs + " up " + ups;
        wheelStatus.Text = "Wheel delta " + wheelDelta + " events " + wheelEvents;
        dragStatus.Text = "Drag successes " + dragSuccesses + " attempts " + dragAttempts + " last " + lastDrag + " held " + dragHeld.ToString().ToLowerInvariant();
        moveStatus.Text = "Move events " + moves;
        // Default WinForms Label accessible name is overridden, so include live values explicitly.
        clickStatus.AccessibleName = clickStatus.Text;
        wheelStatus.AccessibleName = wheelStatus.Text;
        dragStatus.AccessibleName = dragStatus.Text;
        moveStatus.AccessibleName = moveStatus.Text;
        if (shown) WriteState();
    }
    void WriteState() {
        string value = "{\"utc\":" + Quote(DateTime.UtcNow.ToString("O")) + ",\"pid\":" + Process.GetCurrentProcess().Id +
            ",\"windowId\":" + Quote(Handle.ToInt64().ToString()) + ",\"title\":" + Quote(Text) + ",\"windowRect\":" + RectJson(Bounds) +
            ",\"keyboard\":{\"text\":" + Quote(keyboardInput.Text) + ",\"down\":" + keyDowns + ",\"up\":" + keyUps + "}" +
            ",\"targets\":{\"click\":" + PointJson(Center(clickPad, clickPad.ClientRectangle)) +
            ",\"wheel\":" + PointJson(Center(wheelPad, wheelPad.ClientRectangle)) +
            ",\"dragStart\":" + PointJson(Center(dragPad, dragStart)) + ",\"dragEnd\":" + PointJson(Center(dragPad, dragEnd)) + "}" +
            ",\"counters\":{\"left\":" + leftClicks + ",\"right\":" + rightClicks + ",\"middle\":" + middleClicks +
            ",\"double\":" + doubleClicks + ",\"down\":" + downs + ",\"up\":" + ups + ",\"move\":" + moves +
            ",\"wheelDelta\":" + wheelDelta + ",\"wheelEvents\":" + wheelEvents + ",\"dragSuccesses\":" + dragSuccesses +
            ",\"dragAttempts\":" + dragAttempts + ",\"dragHeld\":" + dragHeld.ToString().ToLowerInvariant() + "},\"lastDrag\":" + Quote(lastDrag) + "}\n";
        string path = Path.Combine(output, "state.json");
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, value, new UTF8Encoding(false));
        if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
    }
    [STAThread]
    static void Main(string[] args) {
        if (args.Length < 1) throw new ArgumentException("An unused evidence output directory is required.");
        int duration = args.Length > 1 ? Int32.Parse(args[1]) : 1800;
        if (duration < 30 || duration > 7200) throw new ArgumentException("Auto-close duration must be 30..7200 seconds.");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new InputSurface(args[0], duration));
    }
}
