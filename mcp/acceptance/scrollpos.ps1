# Prints the vertical scroll position of the EDIT child in the UIMOUSE-TEST window.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ScrollProbe {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetScrollPos(IntPtr hWnd, int nBar);
  static IntPtr found = IntPtr.Zero;
  public static int Pos() {
    found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString().Trim() == "UIMOUSE-TEST") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) throw new Exception("form not found");
    IntPtr edit = IntPtr.Zero;
    EnumChildWindows(found, (c, l) => {
      var cn = new StringBuilder(256);
      GetClassName(c, cn, 256);
      if (cn.ToString().Contains(".EDIT.")) { edit = c; return false; }
      return true;
    }, IntPtr.Zero);
    if (edit == IntPtr.Zero) throw new Exception("edit not found");
    return GetScrollPos(edit, 1);
  }
}
'@
Write-Output ([ScrollProbe]::Pos())
