# Generates a dedicated Windows file-association icon for PSForge.
# Usage: .\tools\generate-file-association-icon.ps1
# Output: src-tauri\icons\file-association.ico

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$size = 256
$outPath = Join-Path (Join-Path $PSScriptRoot "..\src-tauri\icons") "file-association.ico"

function New-Brush([byte]$r, [byte]$g, [byte]$b, [byte]$a = 255) {
    New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($a, $r, $g, $b))
}

function New-Pen([byte]$r, [byte]$g, [byte]$b, [float]$w, [byte]$a = 255) {
    New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($a, $r, $g, $b), $w)
}

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, ($r*2), ($r*2), 180, 90)
    $p.AddArc(($x+$w-$r*2), $y, ($r*2), ($r*2), 270, 90)
    $p.AddArc(($x+$w-$r*2), ($y+$h-$r*2), ($r*2), ($r*2), 0, 90)
    $p.AddArc($x, ($y+$h-$r*2), ($r*2), ($r*2), 90, 90)
    $p.CloseFigure()
    return $p
}

function Write-SinglePngIco([byte[]]$pngBytes, [string]$path) {
    # ICONDIR header
    [byte[]]$iconDir = 0,0, 1,0, 1,0

    # ICONDIRENTRY for a single 256x256 PNG image.
    [byte[]]$entry = New-Object byte[] 16
    $entry[0] = 0   # width 0 => 256
    $entry[1] = 0   # height 0 => 256
    $entry[2] = 0   # palette count
    $entry[3] = 0   # reserved

    $planes = [BitConverter]::GetBytes([UInt16]1)
    $bits = [BitConverter]::GetBytes([UInt16]32)
    $len = [BitConverter]::GetBytes([UInt32]$pngBytes.Length)
    $offset = [BitConverter]::GetBytes([UInt32]22) # 6 + 16

    [Array]::Copy($planes, 0, $entry, 4, 2)
    [Array]::Copy($bits, 0, $entry, 6, 2)
    [Array]::Copy($len, 0, $entry, 8, 4)
    [Array]::Copy($offset, 0, $entry, 12, 4)

    $stream = New-Object System.IO.MemoryStream
    try {
        $stream.Write($iconDir, 0, $iconDir.Length)
        $stream.Write($entry, 0, $entry.Length)
        $stream.Write($pngBytes, 0, $pngBytes.Length)
        [System.IO.File]::WriteAllBytes($path, $stream.ToArray())
    }
    finally {
        $stream.Dispose()
    }
}

$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    # Document body
    $docX = 28; $docY = 16; $docW = 200; $docH = 224; $docRadius = 20
    $docPath = New-RoundedPath $docX $docY $docW $docH $docRadius
    $docBrush = New-Brush 245 248 252 255
    $docPen = New-Pen 194 203 215 4 255
    $g.FillPath($docBrush, $docPath)
    $g.DrawPath($docPen, $docPath)
    $docBrush.Dispose(); $docPen.Dispose(); $docPath.Dispose()

    # Folded corner
    $fold = [System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(176, 16),
        [System.Drawing.Point]::new(228, 16),
        [System.Drawing.Point]::new(228, 68)
    )
    $foldBrush = New-Brush 222 229 240 255
    $foldPen = New-Pen 194 203 215 3 255
    $g.FillPolygon($foldBrush, $fold)
    $g.DrawLines($foldPen, $fold)
    $foldBrush.Dispose(); $foldPen.Dispose()

    # PSForge badge on the document
    $badgePath = New-RoundedPath 56 74 144 116 18
    $badgeGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.Point]::new(56, 74),
        [System.Drawing.Point]::new(200, 190),
        [System.Drawing.Color]::FromArgb(255, 14, 28, 58),
        [System.Drawing.Color]::FromArgb(255, 5, 12, 28)
    )
    $g.FillPath($badgeGrad, $badgePath)
    $badgeBorder = New-Pen 0 170 235 3 95
    $g.DrawPath($badgeBorder, $badgePath)
    $badgeGrad.Dispose(); $badgeBorder.Dispose(); $badgePath.Dispose()

    # Chevron mark
    $chevPen = New-Pen 0 196 255 18 255
    $chevPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $chevPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $chevPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLines($chevPen, [System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(74, 96),
        [System.Drawing.Point]::new(120, 132),
        [System.Drawing.Point]::new(74, 168)
    ))
    $chevPen.Dispose()

    # PS text
    $font = New-Object System.Drawing.Font("Consolas", 34, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $txtBrush = New-Brush 220 235 255 255
    $shadow = New-Brush 0 80 180 75
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Near
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $shadowRect = New-Object System.Drawing.RectangleF(128, 106, 64, 44)
    $textRect = New-Object System.Drawing.RectangleF(125, 102, 64, 44)
    $g.DrawString("PS", $font, $shadow, $shadowRect, $fmt)
    $g.DrawString("PS", $font, $txtBrush, $textRect, $fmt)
    $font.Dispose(); $txtBrush.Dispose(); $shadow.Dispose(); $fmt.Dispose()

    # Forge accent bar
    $barPath = New-RoundedPath 84 166 88 10 5
    $barGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.Point]::new(84, 166),
        [System.Drawing.Point]::new(172, 166),
        [System.Drawing.Color]::FromArgb(255, 255, 160, 20),
        [System.Drawing.Color]::FromArgb(255, 255, 70, 0)
    )
    $g.FillPath($barGrad, $barPath)
    $barGrad.Dispose(); $barPath.Dispose()

    # Horizontal text lines to reinforce "document" shape at smaller sizes
    $linePen = New-Pen 184 193 206 3 210
    foreach ($y in 204, 216, 228) {
        $g.DrawLine($linePen, 56, $y, 198, $y)
    }
    $linePen.Dispose()

    $png = New-Object System.IO.MemoryStream
    try {
        $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-SinglePngIco -pngBytes $png.ToArray() -path $outPath
    }
    finally {
        $png.Dispose()
    }

    Write-Host "[OK] Saved: $outPath" -ForegroundColor Green
}
finally {
    $g.Dispose()
    $bmp.Dispose()
}