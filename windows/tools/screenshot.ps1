# Saves a PNG of the whole virtual desktop (every monitor). Used by CI and the e2e tests.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/screenshot.ps1 -Path out.png
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class BSideDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][BSideDpi]::SetProcessDPIAware()

$dir = Split-Path -Parent $Path
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
Write-Output ("screenshot {0} ({1}x{2})" -f $Path, $bounds.Width, $bounds.Height)
