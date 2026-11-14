# Independent look at one native window, so the e2e tests do not take the app's word for it.
# Prints one JSON object: class, parent class, ancestor class, child/topmost flags, visibility, rect.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe-window.ps1 -Hwnd 123456
param([Parameter(Mandatory = $true)][string]$Hwnd)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BSideProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  public static string Cls(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    var sb = new StringBuilder(256);
    GetClassNameW(h, sb, 256);
    return sb.ToString();
  }
}
"@

$h = [IntPtr][Int64]$Hwnd
if (-not [BSideProbe]::IsWindow($h)) {
  Write-Output (@{ exists = $false; hwnd = $Hwnd } | ConvertTo-Json -Compress)
  exit 0
}
$r = New-Object BSideProbe+RECT
[void][BSideProbe]::GetWindowRect($h, [ref]$r)
$style = [Int64][BSideProbe]::GetWindowLongPtr($h, -16)
$exstyle = [Int64][BSideProbe]::GetWindowLongPtr($h, -20)
$parent = [BSideProbe]::GetParent($h)
$ancestor = [BSideProbe]::GetAncestor($h, 1)
$out = [ordered]@{
  exists        = $true
  hwnd          = $Hwnd
  class         = [BSideProbe]::Cls($h)
  parentClass   = [BSideProbe]::Cls($parent)
  ancestorClass = [BSideProbe]::Cls($ancestor)
  isChild       = (($style -band 0x40000000) -ne 0)
  topmost       = (($exstyle -band 0x8) -ne 0)
  visible       = [BSideProbe]::IsWindowVisible($h)
  rect          = [ordered]@{ left = $r.Left; top = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
}
Write-Output ($out | ConvertTo-Json -Compress -Depth 4)
