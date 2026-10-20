// Independent no-activate voice UI; no SDK or input injection. U/F/C IPC unchanged.
#![allow(non_snake_case, non_camel_case_types)]
#![cfg_attr(not(test), windows_subsystem = "windows")]
mod model;
use model::Model;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::thread;
type HWND = *mut core::ffi::c_void;
type HDC = HWND;
type HINSTANCE = HWND;
type HBRUSH = HWND;
type HFONT = HWND;
type UINT = u32;
type DWORD = u32;
type BOOL = i32;
type LPARAM = isize;
type WPARAM = usize;
type LRESULT = isize;
type COLORREF = u32;
#[repr(C)]
struct WNDCLASSW {
    style: UINT,
    proc: extern "system" fn(HWND, UINT, WPARAM, LPARAM) -> LRESULT,
    cls_extra: i32,
    wnd_extra: i32,
    instance: HINSTANCE,
    icon: HWND,
    cursor: HWND,
    background: HBRUSH,
    menu: *const u16,
    name: *const u16,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
struct POINT {
    x: i32,
    y: i32,
}
#[repr(C)]
struct MONITORINFO {
    size: DWORD,
    monitor: RECT,
    work: RECT,
    flags: DWORD,
}
#[repr(C)]
struct PAINTSTRUCT {
    hdc: HDC,
    erase: BOOL,
    rect: RECT,
    restore: BOOL,
    inc_update: BOOL,
    reserved: [u8; 32],
}
#[repr(C)]
struct MSG {
    hwnd: HWND,
    message: UINT,
    wp: WPARAM,
    lp: LPARAM,
    time: DWORD,
    point: POINT,
    private: DWORD,
}
#[repr(C)]
struct DRAWITEMSTRUCT {
    control_type: UINT,
    control_id: UINT,
    item_id: UINT,
    action: UINT,
    state: UINT,
    hwnd: HWND,
    dc: HDC,
    rect: RECT,
    data: usize,
}
#[repr(C)]
struct MARGINS {
    left: i32,
    right: i32,
    top: i32,
    bottom: i32,
}
const WM_DESTROY: UINT = 2;
const WM_PAINT: UINT = 15;
const WM_CLOSE: UINT = 16;
const WM_ERASEBKGND: UINT = 20;
const WM_DRAWITEM: UINT = 43;
const WM_COMMAND: UINT = 273;
const WM_TIMER: UINT = 275;
const WM_MOUSEACTIVATE: UINT = 33;
const WM_DPICHANGED: UINT = 736;
const WM_DISPLAYCHANGE: UINT = 126;
const WM_UPDATE: UINT = 0x8001;
const WS_POPUP: DWORD = 0x80000000;
const WS_CHILD: DWORD = 0x40000000;
const WS_VISIBLE: DWORD = 0x10000000;
const EX_STYLE: DWORD = 0x08000000 | 0x00000008 | 0x00000080; // NOACTIVATE | TOPMOST | TOOLWINDOW
const FINISH: usize = 1001;
const CANCEL: usize = 1002;
const BG: COLORREF = rgb(23, 27, 36);
const PANEL: COLORREF = rgb(31, 37, 49);
const BORDER: COLORREF = rgb(48, 57, 72);
const FG: COLORREF = rgb(241, 245, 251);
const MUTED: COLORREF = rgb(154, 167, 187);
const ACCENT: COLORREF = rgb(95, 226, 190);
const fn rgb(r: u32, g: u32, b: u32) -> COLORREF {
    r | (g << 8) | (b << 16)
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn scale(v: i32, d: u32) -> i32 {
    ((v as i64 * d as i64 + 48) / 96) as i32
}
#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(c: *const WNDCLASSW) -> u16;
    fn CreateWindowExW(
        ex: DWORD,
        class: *const u16,
        title: *const u16,
        style: DWORD,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: HWND,
        menu: HWND,
        instance: HINSTANCE,
        param: HWND,
    ) -> HWND;
    fn DefWindowProcW(hwnd: HWND, msg: UINT, wp: WPARAM, lp: LPARAM) -> LRESULT;
    fn DestroyWindow(hwnd: HWND) -> BOOL;
    fn PostQuitMessage(code: i32);
    fn ShowWindow(hwnd: HWND, cmd: i32) -> BOOL;
    fn EnableWindow(hwnd: HWND, enabled: BOOL) -> BOOL;
    fn GetMessageW(msg: *mut MSG, hwnd: HWND, min: UINT, max: UINT) -> i32;
    fn TranslateMessage(msg: *const MSG) -> BOOL;
    fn DispatchMessageW(msg: *const MSG) -> LRESULT;
    fn PostMessageW(hwnd: HWND, msg: UINT, wp: WPARAM, lp: LPARAM) -> BOOL;
    fn BeginPaint(hwnd: HWND, ps: *mut PAINTSTRUCT) -> HDC;
    fn EndPaint(hwnd: HWND, ps: *const PAINTSTRUCT) -> BOOL;
    fn InvalidateRect(hwnd: HWND, rect: *const RECT, erase: BOOL) -> BOOL;
    fn SetTimer(hwnd: HWND, id: usize, ms: UINT, callback: HWND) -> usize;
    fn GetForegroundWindow() -> HWND;
    fn MonitorFromWindow(hwnd: HWND, flags: DWORD) -> HWND;
    fn GetMonitorInfoW(monitor: HWND, info: *mut MONITORINFO) -> BOOL;
    fn GetClientRect(hwnd: HWND, rect: *mut RECT) -> BOOL;
    fn GetWindowRect(hwnd: HWND, rect: *mut RECT) -> BOOL;
    fn SetWindowPos(hwnd: HWND, after: HWND, x: i32, y: i32, w: i32, h: i32, flags: UINT) -> BOOL;
    fn MoveWindow(hwnd: HWND, x: i32, y: i32, w: i32, h: i32, repaint: BOOL) -> BOOL;
    fn DrawTextW(dc: HDC, text: *const u16, count: i32, rect: *mut RECT, format: UINT) -> i32;
    fn FillRect(dc: HDC, rect: *const RECT, brush: HBRUSH) -> i32;
    fn GetCursorPos(point: *mut POINT) -> BOOL;
    fn SetProcessDpiAwarenessContext(context: isize) -> BOOL;
    fn GetDpiForWindow(hwnd: HWND) -> UINT;
    fn SetWindowRgn(hwnd: HWND, region: HWND, redraw: BOOL) -> i32;
}
#[link(name = "gdi32")]
extern "system" {
    fn CreateSolidBrush(color: COLORREF) -> HBRUSH;
    fn CreatePen(style: i32, width: i32, color: COLORREF) -> HWND;
    fn SelectObject(dc: HDC, obj: HWND) -> HWND;
    fn DeleteObject(obj: HWND) -> BOOL;
    fn RoundRect(dc: HDC, l: i32, t: i32, r: i32, b: i32, rx: i32, ry: i32) -> BOOL;
    fn MoveToEx(dc: HDC, x: i32, y: i32, old: *mut POINT) -> BOOL;
    fn LineTo(dc: HDC, x: i32, y: i32) -> BOOL;
    fn CreateFontW(
        h: i32,
        w: i32,
        escape: i32,
        orient: i32,
        weight: i32,
        italic: UINT,
        underline: UINT,
        strike: UINT,
        charset: UINT,
        out: UINT,
        clip: UINT,
        quality: UINT,
        pitch: UINT,
        face: *const u16,
    ) -> HFONT;
    fn SetTextColor(dc: HDC, color: COLORREF) -> COLORREF;
    fn SetBkMode(dc: HDC, mode: i32) -> i32;
    fn CreateCompatibleDC(dc: HDC) -> HDC;
    fn DeleteDC(dc: HDC) -> BOOL;
    fn CreateCompatibleBitmap(dc: HDC, w: i32, h: i32) -> HWND;
    fn BitBlt(
        to: HDC,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        from: HDC,
        sx: i32,
        sy: i32,
        op: DWORD,
    ) -> BOOL;
    fn CreateRoundRectRgn(l: i32, t: i32, r: i32, b: i32, w: i32, h: i32) -> HWND;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> HINSTANCE;
    fn GetStdHandle(id: DWORD) -> HWND;
    fn WriteFile(h: HWND, buf: *const u8, len: DWORD, written: *mut DWORD, overlap: HWND) -> BOOL;
}
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: HWND,
        attr: DWORD,
        value: *const core::ffi::c_void,
        size: DWORD,
    ) -> i32;
    fn DwmExtendFrameIntoClientArea(hwnd: HWND, margins: *const MARGINS) -> i32;
}
static MODEL: OnceLock<Mutex<Model>> = OnceLock::new();
static CONTROLS: OnceLock<(usize, usize)> = OnceLock::new();
static OUT: OnceLock<usize> = OnceLock::new();
fn model() -> &'static Mutex<Model> {
    MODEL.get_or_init(|| Mutex::new(Model::default()))
}
fn output(kind: char, session: &str) {
    let line = format!("{kind}\t{session}\n");
    let mut n = 0;
    unsafe {
        WriteFile(
            *OUT.get().unwrap() as HWND,
            line.as_ptr(),
            line.len() as DWORD,
            &mut n,
            std::ptr::null_mut(),
        );
    }
}
fn rect(hwnd: HWND) -> RECT {
    let mut r = RECT::default();
    unsafe {
        GetClientRect(hwnd, &mut r);
    }
    r
}
fn dpi(hwnd: HWND) -> u32 {
    unsafe { GetDpiForWindow(hwnd) }.clamp(96, 480)
}
fn round(dc: HDC, r: RECT, radius: i32, fill: COLORREF, border: COLORREF) {
    unsafe {
        let brush = CreateSolidBrush(fill);
        let pen = CreatePen(0, 1, border);
        let ob = SelectObject(dc, brush);
        let op = SelectObject(dc, pen);
        RoundRect(dc, r.left, r.top, r.right, r.bottom, radius, radius);
        SelectObject(dc, op);
        SelectObject(dc, ob);
        DeleteObject(pen);
        DeleteObject(brush);
    }
}
fn text(
    dc: HDC,
    label: &str,
    r: RECT,
    size: i32,
    weight: i32,
    color: COLORREF,
    d: u32,
    flags: UINT,
) {
    unsafe {
        let font = CreateFontW(
            -scale(size, d),
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            1,
            0,
            0,
            5,
            0,
            wide("Microsoft YaHei UI").as_ptr(),
        );
        let old = SelectObject(dc, font);
        SetTextColor(dc, color);
        SetBkMode(dc, 1);
        // Keep the latest words visible when a long transcript exceeds three
        // lines. Measure with this actual font/DPI instead of slicing UTF-16.
        let mut shown = label.to_string();
        if flags & 0x10 != 0 && r.right > r.left && r.bottom > r.top {
            loop {
                let s = wide(&shown);
                let mut measured = r;
                DrawTextW(
                    dc,
                    s.as_ptr(),
                    (s.len() - 1) as i32,
                    &mut measured,
                    0x400 | 0x10 | 0x800,
                );
                if measured.bottom - measured.top <= r.bottom - r.top {
                    break;
                }
                let tail = shown.strip_prefix('…').unwrap_or(&shown);
                let Some(first) = tail.chars().next() else {
                    break;
                };
                shown = format!("…{}", &tail[first.len_utf8()..]);
            }
        }
        let s = wide(&shown);
        let mut r = r;
        DrawTextW(dc, s.as_ptr(), (s.len() - 1) as i32, &mut r, flags | 0x800);
        SelectObject(dc, old);
        DeleteObject(font);
    }
}
fn lr(l: i32, t: i32, r: i32, b: i32, d: u32) -> RECT {
    RECT {
        left: scale(l, d),
        top: scale(t, d),
        right: scale(r, d),
        bottom: scale(b, d),
    }
}
fn accent(m: &Model) -> COLORREF {
    match m.state.as_str() {
        "finalizing" => rgb(164, 177, 255),
        "error" => rgb(255, 160, 149),
        "busy" => rgb(244, 198, 112),
        _ => ACCENT,
    }
}
fn paint(hwnd: HWND, dc: HDC) {
    let d = dpi(hwnd);
    let r = rect(hwnd);
    let w = (r.right * 96 / d as i32).max(1);
    let m = model().lock().unwrap();
    unsafe {
        let brush = CreateSolidBrush(BG);
        FillRect(dc, &r, brush);
        DeleteObject(brush);
    }
    // Static microphone icon: it does not claim to measure audio amplitude.
    round(
        dc,
        lr(20, 20, 54, 54, d),
        scale(14, d),
        rgb(34, 53, 51),
        rgb(34, 53, 51),
    );
    round(
        dc,
        lr(33, 27, 41, 39, d),
        scale(7, d),
        accent(&m),
        accent(&m),
    );
    unsafe {
        let p = CreatePen(0, scale(2, d).max(1), accent(&m));
        let old = SelectObject(dc, p);
        MoveToEx(dc, scale(29, d), scale(36, d), std::ptr::null_mut());
        LineTo(dc, scale(29, d), scale(39, d));
        LineTo(dc, scale(33, d), scale(43, d));
        LineTo(dc, scale(41, d), scale(43, d));
        LineTo(dc, scale(45, d), scale(39, d));
        LineTo(dc, scale(45, d), scale(36, d));
        MoveToEx(dc, scale(37, d), scale(43, d), std::ptr::null_mut());
        LineTo(dc, scale(37, d), scale(48, d));
        MoveToEx(dc, scale(33, d), scale(48, d), std::ptr::null_mut());
        LineTo(dc, scale(41, d), scale(48, d));
        SelectObject(dc, old);
        DeleteObject(p);
    }
    text(
        dc,
        m.title(),
        lr(66, 16, w - 98, 42, d),
        17,
        600,
        FG,
        d,
        0x20 | 0x8000,
    );
    text(
        dc,
        m.subtitle(),
        lr(66, 43, w - 20, 65, d),
        12,
        400,
        MUTED,
        d,
        0x20 | 0x8000,
    );
    round(
        dc,
        lr(w - 88, 20, w - 20, 49, d),
        scale(12, d),
        PANEL,
        PANEL,
    );
    text(
        dc,
        &m.elapsed(),
        lr(w - 88, 20, w - 20, 49, d),
        13,
        600,
        accent(&m),
        d,
        0x1 | 0x4 | 0x20,
    );
    round(dc, lr(20, 78, w - 20, 154, d), scale(16, d), PANEL, BORDER);
    text(
        dc,
        &m.preview_text(),
        lr(34, 89, w - 34, 144, d),
        14,
        400,
        if m.preview.is_empty() { MUTED } else { FG },
        d,
        0x10 | 0x8000,
    );
    let foot = if m.mode == "ptt" {
        "松开语音键后，输入到当前光标"
    } else {
        "语音问答"
    };
    let right = if m.mode == "ptt" { w - 104 } else { w - 200 };
    text(
        dc,
        foot,
        lr(22, 174, right, 207, d),
        11,
        400,
        MUTED,
        d,
        0x4 | 0x20 | 0x8000,
    );
}
fn draw_button(item: &DRAWITEMSTRUCT) {
    let d = dpi(item.hwnd);
    let r = item.rect;
    let primary = item.control_id as usize == FINISH;
    let disabled = item.state & 4 != 0;
    let pressed = item.state & 1 != 0;
    let mut point = POINT { x: 0, y: 0 };
    let mut screen = RECT::default();
    let hover =
        unsafe { GetCursorPos(&mut point) != 0 && GetWindowRect(item.hwnd, &mut screen) != 0 }
            && point.x >= screen.left
            && point.x < screen.right
            && point.y >= screen.top
            && point.y < screen.bottom;
    let color = if disabled {
        rgb(39, 47, 59)
    } else if primary {
        if pressed {
            rgb(63, 186, 155)
        } else if hover {
            rgb(127, 239, 207)
        } else {
            ACCENT
        }
    } else if pressed {
        rgb(48, 57, 72)
    } else if hover {
        rgb(50, 61, 77)
    } else {
        rgb(38, 46, 59)
    };
    unsafe {
        let b = CreateSolidBrush(BG);
        FillRect(item.dc, &r, b);
        DeleteObject(b);
    }
    round(
        item.dc,
        r,
        scale(12, d),
        color,
        if primary { color } else { BORDER },
    );
    text(
        item.dc,
        if primary { "说完了" } else { "取消" },
        r,
        12,
        if primary { 600 } else { 400 },
        if disabled {
            MUTED
        } else if primary {
            BG
        } else {
            FG
        },
        d,
        0x1 | 0x4 | 0x20,
    );
}
fn update_controls(hwnd: HWND) {
    let Some(&(finish, cancel)) = CONTROLS.get() else {
        return;
    };
    let (ptt, can_finish, can_cancel) = {
        let m = model().lock().unwrap();
        (m.mode == "ptt", m.can_finish(), m.can_cancel())
    };
    let d = dpi(hwnd);
    let w = rect(hwnd).right * 96 / d as i32;
    unsafe {
        ShowWindow(finish as HWND, if ptt { 0 } else { 4 });
        EnableWindow(finish as HWND, can_finish as BOOL);
        EnableWindow(cancel as HWND, can_cancel as BOOL);
        MoveWindow(
            finish as HWND,
            scale(w - 112, d),
            scale(172, d),
            scale(92, d),
            scale(32, d),
            1,
        );
        MoveWindow(
            cancel as HWND,
            scale(if ptt { w - 88 } else { w - 188 }, d),
            scale(172, d),
            scale(68, d),
            scale(32, d),
            1,
        );
        InvalidateRect(hwnd, std::ptr::null(), 0);
        InvalidateRect(finish as HWND, std::ptr::null(), 0);
        InvalidateRect(cancel as HWND, std::ptr::null(), 0);
    }
}
fn appearance(hwnd: HWND) {
    unsafe {
        let preference = 2u32;
        let policy = 2u32;
        let border = BORDER;
        DwmSetWindowAttribute(hwnd, 2, &policy as *const _ as _, 4);
        DwmExtendFrameIntoClientArea(
            hwnd,
            &MARGINS {
                left: 1,
                right: 1,
                top: 1,
                bottom: 1,
            },
        );
        DwmSetWindowAttribute(hwnd, 34, &border as *const _ as _, 4);
        if DwmSetWindowAttribute(hwnd, 33, &preference as *const _ as _, 4) < 0 {
            let r = rect(hwnd);
            let region = CreateRoundRectRgn(
                0,
                0,
                r.right + 1,
                r.bottom + 1,
                scale(20, dpi(hwnd)),
                scale(20, dpi(hwnd)),
            );
            if !region.is_null() && SetWindowRgn(hwnd, region, 1) == 0 {
                DeleteObject(region);
            }
        }
    }
}
fn position(hwnd: HWND, monitor: HWND) {
    unsafe {
        let mut info: MONITORINFO = std::mem::zeroed();
        info.size = std::mem::size_of::<MONITORINFO>() as DWORD;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return;
        }
        let r = info.work;
        let [x, y, w, h] = model::placement([r.left, r.top, r.right, r.bottom], dpi(hwnd));
        SetWindowPos(hwnd, std::ptr::null_mut(), x, y, w, h, 0x10 | 0x4);
        appearance(hwnd);
        update_controls(hwnd);
    }
}
extern "system" fn wnd_proc(hwnd: HWND, msg: UINT, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_MOUSEACTIVATE => 3,
        WM_ERASEBKGND => 1,
        WM_UPDATE => {
            update_controls(hwnd);
            0
        }
        WM_TIMER => {
            unsafe {
                InvalidateRect(hwnd, std::ptr::null(), 0);
                if let Some(&(f, c)) = CONTROLS.get() {
                    InvalidateRect(f as HWND, std::ptr::null(), 0);
                    InvalidateRect(c as HWND, std::ptr::null(), 0);
                }
            }
            0
        }
        WM_DPICHANGED | WM_DISPLAYCHANGE => {
            position(hwnd, unsafe { MonitorFromWindow(hwnd, 2) });
            0
        }
        WM_COMMAND if wp >> 16 == 0 => {
            let id = wp & 0xffff;
            let request = {
                let mut m = model().lock().unwrap();
                let k = if id == FINISH && m.can_finish() {
                    Some('F')
                } else if id == CANCEL && m.can_cancel() {
                    Some('C')
                } else {
                    None
                };
                k.map(|kind| {
                    m.pending = Some(kind);
                    (kind, m.session.clone())
                })
            };
            if let Some((kind, session)) = request {
                output(kind, &session);
                update_controls(hwnd);
            }
            0
        }
        WM_DRAWITEM if lp != 0 => {
            let item = unsafe { &*(lp as *const DRAWITEMSTRUCT) };
            if matches!(item.control_id as usize, FINISH | CANCEL) {
                draw_button(item);
                1
            } else {
                0
            }
        }
        WM_PAINT => {
            unsafe {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let screen = BeginPaint(hwnd, &mut ps);
                let r = rect(hwnd);
                let dc = CreateCompatibleDC(screen);
                let bitmap = CreateCompatibleBitmap(screen, r.right.max(1), r.bottom.max(1));
                if !dc.is_null() && !bitmap.is_null() {
                    let old = SelectObject(dc, bitmap);
                    paint(hwnd, dc);
                    BitBlt(screen, 0, 0, r.right, r.bottom, dc, 0, 0, 0x00CC0020);
                    SelectObject(dc, old);
                } else {
                    paint(hwnd, screen);
                }
                if !bitmap.is_null() {
                    DeleteObject(bitmap);
                }
                if !dc.is_null() {
                    DeleteDC(dc);
                }
                EndPaint(hwnd, &ps);
            }
            0
        }
        WM_CLOSE => {
            unsafe {
                DestroyWindow(hwnd);
            }
            0
        }
        WM_DESTROY => {
            unsafe {
                PostQuitMessage(0);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
    }
}
fn main() {
    unsafe {
        SetProcessDpiAwarenessContext(-4);
    }
    OUT.set(unsafe { GetStdHandle(0xfffffff5) } as usize).ok();
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class = wide("umouse-voice-ui");
    let wc = WNDCLASSW {
        style: 0,
        proc: wnd_proc,
        cls_extra: 0,
        wnd_extra: 0,
        instance,
        icon: std::ptr::null_mut(),
        cursor: std::ptr::null_mut(),
        background: std::ptr::null_mut(),
        menu: std::ptr::null(),
        name: class.as_ptr(),
    };
    if unsafe { RegisterClassW(&wc) } == 0 {
        std::process::exit(1);
    }
    let monitor = unsafe { MonitorFromWindow(GetForegroundWindow(), 2) };
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.size = std::mem::size_of::<MONITORINFO>() as DWORD;
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        std::process::exit(1);
    }
    let [x, y, w, h] = model::placement(
        [
            info.work.left,
            info.work.top,
            info.work.right,
            info.work.bottom,
        ],
        96,
    );
    let hwnd = unsafe {
        CreateWindowExW(
            EX_STYLE,
            class.as_ptr(),
            wide("uMouse 语音输入").as_ptr(),
            WS_POPUP,
            x,
            y,
            w,
            h,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null_mut(),
        )
    };
    if hwnd.is_null() {
        std::process::exit(1);
    }
    let button = |name: &str, id: usize| unsafe {
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide(name).as_ptr(),
            WS_CHILD | WS_VISIBLE | 11,
            0,
            0,
            1,
            1,
            hwnd,
            id as HWND,
            instance,
            std::ptr::null_mut(),
        )
    };
    let finish = button("说完了", FINISH);
    let cancel = button("取消", CANCEL);
    if finish.is_null() || cancel.is_null() {
        unsafe {
            DestroyWindow(hwnd);
        }
        std::process::exit(1);
    }
    CONTROLS.set((finish as usize, cancel as usize)).ok();
    position(hwnd, monitor);
    unsafe {
        ShowWindow(hwnd, 4);
        SetTimer(hwnd, 1, 200, std::ptr::null_mut());
    }
    let id = hwnd as usize;
    thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        let mut chunk = [0u8; 2048];
        let mut line = Vec::with_capacity(4096);
        let mut overflow = false;
        loop {
            let n = match input.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for &b in &chunk[..n] {
                if b == b'\n' {
                    if !overflow {
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        if let Ok(s) = std::str::from_utf8(&line) {
                            if model().lock().unwrap().apply(s) {
                                unsafe {
                                    PostMessageW(id as HWND, WM_UPDATE, 0, 0);
                                }
                            }
                        }
                    }
                    line.clear();
                    overflow = false;
                } else if !overflow {
                    if line.len() < 65536 {
                        line.push(b);
                    } else {
                        line.clear();
                        overflow = true;
                    }
                }
            }
        }
        unsafe {
            PostMessageW(id as HWND, WM_CLOSE, 0, 0);
        }
    });
    let mut message: MSG = unsafe { std::mem::zeroed() };
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}
