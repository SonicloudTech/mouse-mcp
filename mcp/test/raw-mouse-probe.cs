using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Passive observation only: no SDK, no HID open/read/write, no injected input,
// no activation or changes to legacy delivery. Keyboard evidence is opt-in and restricted to a fixture PID.
sealed class RawMouseProbe : NativeWindow, IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct DeviceRegistration { public ushort page, usage; public uint flags; public IntPtr target; }
    [StructLayout(LayoutKind.Sequential)] struct DeviceList { public IntPtr device; public uint type; }
    [StructLayout(LayoutKind.Sequential)] struct Header { public uint type, size; public IntPtr device, wParam; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] struct Mouse {
        [FieldOffset(0)] public ushort flags;
        [FieldOffset(4)] public ushort buttonFlags;
        [FieldOffset(6)] public ushort buttonData;
        [FieldOffset(8)] public uint rawButtons;
        [FieldOffset(12)] public int dx;
        [FieldOffset(16)] public int dy;
        [FieldOffset(20)] public uint extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort makeCode, flags, reserved, vkey; public uint message, extra; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterRawInputDevices(DeviceRegistration[] devices, uint count, uint size);
    [DllImport("user32.dll", SetLastError = true)] static extern uint GetRawInputData(IntPtr raw, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll", SetLastError = true)] static extern uint GetRawInputDeviceList([In, Out] DeviceList[] devices, ref uint count, uint size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, StringBuilder data, ref uint size);
    [DllImport("user32.dll")] static extern int GetMessageTime();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetPhysicalCursorPos(out Point point);
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();

    readonly string directory;
    readonly BlockingCollection<Dictionary<string, object>> pending = new BlockingCollection<Dictionary<string, object>>(8192);
    readonly Dictionary<IntPtr, string> deviceNames = new Dictionary<IntPtr, string>();
    readonly Thread writer;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly long started = Stopwatch.GetTimestamp();
    readonly int seconds;
    readonly int keyboardTargetPid;
    readonly Process keyboardTarget;
    long keyboardCount;
    long sequence, rawCount, snapshotCount, dropped;
    volatile Exception writerError;
    bool disposed;
    uint lastButtons = UInt32.MaxValue;
    readonly ApplicationContext context;

    RawMouseProbe(string output, int duration, ApplicationContext application, int targetPid) {
        if (IntPtr.Size != 8 || Marshal.SizeOf(typeof(Header)) != 24 || Marshal.SizeOf(typeof(Mouse)) != 24)
            throw new InvalidOperationException("This probe requires the audited x64 RAWINPUT layout.");
        directory = Path.GetFullPath(output); seconds = duration; context = application; keyboardTargetPid = targetPid;
        if (targetPid > 0) keyboardTarget = Process.GetProcessById(targetPid);
        Directory.CreateDirectory(directory);
        string events = Path.Combine(directory, "raw-events.jsonl");
        if (File.Exists(events) || File.Exists(Path.Combine(directory, "probe-state.json")))
            throw new InvalidOperationException("Use a fresh evidence directory; old evidence is never overwritten.");
        // Reserve the evidence path synchronously so another probe cannot overwrite this run.
        var stream = new FileStream(events, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        writer = new Thread(delegate() { WriteLoop(stream); });
        writer.IsBackground = true; writer.Name = "RawMouseEvidenceWriter"; writer.Start();
        var parameters = new CreateParams();
        parameters.Caption = "uMouse passive Raw Input probe";
        parameters.Parent = new IntPtr(-3); // HWND_MESSAGE: never shown or activated.
        CreateHandle(parameters);
        var registration = new DeviceRegistration { page = 1, usage = 2, flags = 0x2100, target = Handle };
        var registrations = new List<DeviceRegistration> { registration };
        if (targetPid > 0) registrations.Add(new DeviceRegistration { page = 1, usage = 6, flags = 0x2100, target = Handle });
        if (!RegisterRawInputDevices(registrations.ToArray(), (uint)registrations.Count, (uint)Marshal.SizeOf(typeof(DeviceRegistration))))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "RegisterRawInputDevices");
        var ready = Record("ready");
        ready["pid"] = Process.GetCurrentProcess().Id; ready["keyboardTargetPid"] = keyboardTargetPid;
        ready["window"] = Handle.ToInt64(); ready["qpcFrequency"] = Stopwatch.Frequency;
        ready["usagePage"] = 1; ready["usage"] = 2; ready["registrationFlags"] = 0x2100;
        ready["queueCapacity"] = 8192; ready["autoCloseSeconds"] = seconds;
        ready["headerBytes"] = Marshal.SizeOf(typeof(Header)); ready["mouseBytes"] = Marshal.SizeOf(typeof(Mouse));
        Enqueue(ready); EnumerateMice(); WriteState("running");
        timer.Interval = 100;
        timer.Tick += delegate {
            Snapshot(false);
            if ((keyboardTarget != null && keyboardTarget.HasExited) || writerError != null || File.Exists(Path.Combine(directory, "stop.request")) ||
                (Stopwatch.GetTimestamp() - started) / (double)Stopwatch.Frequency >= seconds) context.ExitThread();
        };
        timer.Start(); Snapshot(true);
    }
    Dictionary<string, object> Record(string kind) {
        return new Dictionary<string, object> {
            { "sequence", ++sequence }, { "utc", DateTime.UtcNow.ToString("O") },
            { "qpc", Stopwatch.GetTimestamp() }, { "tickCount64", GetTickCount64() }, { "kind", kind }
        };
    }
    void Enqueue(Dictionary<string, object> value) { if (!pending.TryAdd(value)) dropped++; }
    void WriteLoop(FileStream stream) {
        try {
            using (var output = new StreamWriter(stream, new UTF8Encoding(false))) {
                output.AutoFlush = true;
                var json = new JavaScriptSerializer();
                foreach (var record in pending.GetConsumingEnumerable()) output.WriteLine(json.Serialize(record));
            }
        } catch (Exception error) { writerError = error; }
    }
    string DeviceName(IntPtr device) {
        string existing;
        if (deviceNames.TryGetValue(device, out existing)) return existing;
        uint size = 0;
        uint result = GetRawInputDeviceInfo(device, 0x20000007, null, ref size); // RIDI_DEVICENAME
        if (result == UInt32.MaxValue || size == 0) return "unavailable:" + Marshal.GetLastWin32Error();
        var text = new StringBuilder((int)size + 1);
        result = GetRawInputDeviceInfo(device, 0x20000007, text, ref size);
        if (result == UInt32.MaxValue) return "unavailable:" + Marshal.GetLastWin32Error();
        existing = text.ToString(); deviceNames[device] = existing; return existing;
    }
    void EnumerateMice() {
        uint count = 0, size = (uint)Marshal.SizeOf(typeof(DeviceList));
        if (GetRawInputDeviceList(null, ref count, size) == UInt32.MaxValue) { LogError("device_list_count"); return; }
        var devices = new DeviceList[count];
        uint found = GetRawInputDeviceList(devices, ref count, size);
        if (found == UInt32.MaxValue) { LogError("device_list"); return; }
        for (int i = 0; i < found; i++) if (devices[i].type == 0 || (keyboardTargetPid > 0 && devices[i].type == 1)) {
            var entry = Record(devices[i].type == 0 ? "mouse_device" : "keyboard_device"); entry["device"] = devices[i].device.ToInt64();
            entry["devicePath"] = DeviceName(devices[i].device); Enqueue(entry);
        }
    }
    void LogError(string operation) {
        var entry = Record("win32_error"); entry["operation"] = operation;
        entry["win32Error"] = Marshal.GetLastWin32Error(); Enqueue(entry);
    }
    static uint Buttons() {
        uint value = 0;
        int[] keys = { 1, 2, 4, 5, 6 }; // Only mouse VKs. No keyboard contents read.
        for (int i = 0; i < keys.Length; i++) if ((GetAsyncKeyState(keys[i]) & 0x8000) != 0) value |= (uint)(1 << i);
        return value;
    }
    void Snapshot(bool force) {
        uint state = Buttons();
        if (!force && state == lastButtons) return;
        lastButtons = state;
        var entry = Record("async_mouse_state_snapshot"); entry["buttons"] = state;
        Point point; if (GetPhysicalCursorPos(out point)) {
            entry["cursorX"] = point.x; entry["cursorY"] = point.y; entry["cursorSpace"] = "physical-desktop-pixels";
        }
        entry["note"] = "polled state, not a button transition or HID report";
        snapshotCount++; Enqueue(entry);
    }
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x00FF) { // WM_INPUT
            var entry = Record("raw_mouse"); // Capture receipt time before data lookup or serialization.
            entry["messageTime"] = unchecked((uint)GetMessageTime());
            entry["wParam"] = message.WParam.ToInt64();
            uint bytes = 0, headerSize = (uint)Marshal.SizeOf(typeof(Header));
            if (GetRawInputData(message.LParam, 0x10000003, IntPtr.Zero, ref bytes, headerSize) == UInt32.MaxValue) LogError("raw_input_size");
            else if (bytes >= headerSize + 16 && bytes <= 65536) {
                IntPtr data = Marshal.AllocHGlobal((int)bytes);
                try {
                    uint read = GetRawInputData(message.LParam, 0x10000003, data, ref bytes, headerSize);
                    if (read == UInt32.MaxValue) LogError("raw_input_data");
                    else if (read >= headerSize + 16) {
                        var header = (Header)Marshal.PtrToStructure(data, typeof(Header));
                        if (header.type == 0 && read >= headerSize + 24) {
                            var mouse = (Mouse)Marshal.PtrToStructure(IntPtr.Add(data, (int)headerSize), typeof(Mouse));
                            entry["device"] = header.device.ToInt64(); entry["devicePath"] = DeviceName(header.device);
                            entry["rawInputBytes"] = read; entry["mouseFlags"] = mouse.flags;
                            entry["buttonFlags"] = mouse.buttonFlags; entry["buttonData"] = mouse.buttonData;
                            entry["wheelDataSigned"] = unchecked((short)mouse.buttonData); entry["rawButtonsReserved"] = mouse.rawButtons;
                            entry["dx"] = mouse.dx; entry["dy"] = mouse.dy; entry["extraInformation"] = mouse.extra;
                            rawCount++; Enqueue(entry); Snapshot(false);
                        } else if (header.type == 1 && keyboardTarget != null && !keyboardTarget.HasExited) {
                            uint foregroundPid; GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
                            if (foregroundPid == keyboardTargetPid) {
                                var keyboard = (Keyboard)Marshal.PtrToStructure(IntPtr.Add(data, (int)headerSize), typeof(Keyboard));
                                entry["kind"] = "raw_keyboard"; entry["device"] = header.device.ToInt64(); entry["devicePath"] = DeviceName(header.device);
                                entry["makeCode"] = keyboard.makeCode; entry["flags"] = keyboard.flags; entry["vkey"] = keyboard.vkey;
                                entry["message"] = keyboard.message; entry["foregroundPid"] = foregroundPid;
                                keyboardCount++; Enqueue(entry);
                            }
                        }
                    }
                } finally { Marshal.FreeHGlobal(data); }
            }
        } else if (message.Msg == 0x00FE) {
            var entry = Record("raw_device_change"); entry["messageTime"] = unchecked((uint)GetMessageTime());
            entry["change"] = message.WParam.ToInt64(); entry["device"] = message.LParam.ToInt64();
            entry["devicePath"] = DeviceName(message.LParam); Enqueue(entry);
            deviceNames.Remove(message.LParam);
        }
        base.WndProc(ref message); // Preserve normal message cleanup/delivery; never swallow input.
    }
    void WriteState(string status) {
        var value = new Dictionary<string, object> {
            { "utc", DateTime.UtcNow.ToString("O") }, { "pid", Process.GetCurrentProcess().Id }, { "status", status },
            { "window", Handle.ToInt64() }, { "qpcFrequency", Stopwatch.Frequency }, { "rawMouseEvents", rawCount },
            { "rawKeyboardEvents", keyboardCount }, { "stateSnapshots", snapshotCount }, { "droppedRecords", dropped }, { "writerError", writerError == null ? null : writerError.Message }
        };
        string destination = Path.Combine(directory, "probe-state.json");
        string temporary = destination + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(value), new UTF8Encoding(false));
        if (File.Exists(destination)) File.Replace(temporary, destination, null);
        else File.Move(temporary, destination);
    }
    public void Dispose() {
        if (disposed) return; disposed = true;
        timer.Stop(); timer.Dispose();
        RegisterRawInputDevices(new[] { new DeviceRegistration { page = 1, usage = 2, flags = 1, target = IntPtr.Zero } }, 1, (uint)Marshal.SizeOf(typeof(DeviceRegistration)));
        if (keyboardTarget != null) { RegisterRawInputDevices(new[] { new DeviceRegistration { page = 1, usage = 6, flags = 1, target = IntPtr.Zero } }, 1, (uint)Marshal.SizeOf(typeof(DeviceRegistration))); keyboardTarget.Dispose(); }
        var final = Record("capture_stopped"); final["rawKeyboardEvents"] = keyboardCount; final["rawMouseEvents"] = rawCount; final["stateSnapshots"] = snapshotCount;
        final["droppedRecords"] = dropped; Enqueue(final);
        pending.CompleteAdding();
        bool drained = writer.Join(5000);
        WriteState(!drained ? "writer_not_drained" : writerError == null ? "closed" : "writer_failed");
        DestroyHandle();
    }
    [STAThread] static int Main(string[] args) {
        if (args.Length != 2 && args.Length != 3) return 2;
        try {
            int duration = Int32.Parse(args[1]); if (duration < 5 || duration > 7200) throw new ArgumentException("Duration must be 5..7200 seconds.");
            using (var context = new ApplicationContext())
            using (var probe = new RawMouseProbe(args[0], duration, context, args.Length == 3 ? Int32.Parse(args[2]) : 0)) Application.Run(context);
            return 0;
        } catch (Exception error) {
            Directory.CreateDirectory(args[0]); File.WriteAllText(Path.Combine(args[0], "probe-fatal.txt"), error.ToString()); return 1;
        }
    }
}
