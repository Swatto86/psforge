# Generates the 1024x1024 master icon PNG for PSForge.
# Usage: .\tools\generate-source-icon.ps1
# Output: tools\psforge-master.png

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$SIZE     = 1024
$RADIUS   = 150
$OUT_PATH = Join-Path $PSScriptRoot 'psforge-master.png'

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

try {
    $bmp = New-Object System.Drawing.Bitmap($SIZE, $SIZE, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint  = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Background gradient rounded square
    $bgPath = New-RoundedPath 0 0 $SIZE $SIZE $RADIUS
    $bgGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.Point]::new(0, 0),
        [System.Drawing.Point]::new($SIZE, $SIZE),
        [System.Drawing.Color]::FromArgb(255, 14, 28, 58),
        [System.Drawing.Color]::FromArgb(255, 5, 12, 28))
    $g.FillPath($bgGrad, $bgPath)
    $bgGrad.Dispose(); $bgPath.Dispose()

    # Subtle border glow
    $insetPath = New-RoundedPath 5 5 ($SIZE - 10) ($SIZE - 10) ($RADIUS - 5)
    $borderPen = New-Pen 0 148 220 9 55
    $g.DrawPath($borderPen, $insetPath)
    $borderPen.Dispose(); $insetPath.Dispose()

    # Chevron ">" as two thick line segments
    $pkX = [int]($SIZE * 0.62); $pkY = [int]($SIZE * 0.50)
    $tlX = [int]($SIZE * 0.12); $tlY = [int]($SIZE * 0.17)
    $blX = [int]($SIZE * 0.12); $blY = [int]($SIZE * 0.83)
    $pk = [System.Drawing.Point]::new($pkX, $pkY)
    $tl = [System.Drawing.Point]::new($tlX, $tlY)
    $bl = [System.Drawing.Point]::new($blX, $blY)
    $pts = [System.Drawing.Point[]]@($tl, $pk, $bl)

    $glowPen = New-Pen 0 196 255 145 80
    $glowPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $glowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $glowPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLines($glowPen, $pts); $glowPen.Dispose()

    $chevPen = New-Pen 0 196 255 110 255
    $chevPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $chevPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $chevPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLines($chevPen, $pts); $chevPen.Dispose()

    # "PS" text
    $psFontPx = [float]($SIZE * 0.24)
    $psFont   = New-Object System.Drawing.Font("Consolas", $psFontPx, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment     = [System.Drawing.StringAlignment]::Near
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $msf = New-Object System.Drawing.StringFormat
    $tsz = $g.MeasureString("PS", $psFont, 9999, $msf)
    $textX = [float]($SIZE * 0.47)
    $textY = [float](($SIZE - $tsz.Height) / 2)
    $tRect = New-Object System.Drawing.RectangleF($textX, $textY, ($tsz.Width + 20), $tsz.Height)

    $shadowBrush = New-Brush 0 80 180 70
    $sRect = New-Object System.Drawing.RectangleF(($textX + 7), ($textY + 9), ($tsz.Width + 20), $tsz.Height)
    $g.DrawString("PS", $psFont, $shadowBrush, $sRect, $sf)
    $shadowBrush.Dispose()

    $psBrush = New-Brush 220 235 255 255
    $g.DrawString("PS", $psFont, $psBrush, $tRect, $sf)
    $psBrush.Dispose(); $psFont.Dispose()

    # Amber forge accent bar
    $barH = [float]($SIZE * 0.048)
    $barW = [float]($SIZE * 0.58)
    $barX = [float](($SIZE - $barW) / 2)
    $barY = [float]($SIZE * 0.86)
    $barR = [float]($barH / 2)
    $barPath = New-RoundedPath $barX $barY $barW $barH $barR
    $barGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.Point]::new([int]$barX, [int]$barY),
        [System.Drawing.Point]::new([int]($barX + $barW), [int]$barY),
        [System.Drawing.Color]::FromArgb(255, 255, 160, 20),
        [System.Drawing.Color]::FromArgb(255, 255, 70, 0))
    $g.FillPath($barGrad, $barPath); $barGrad.Dispose()
    $barHiGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.Point]::new([int]$barX, [int]$barY),
        [System.Drawing.Point]::new([int]$barX, [int]($barY + $barH)),
        [System.Drawing.Color]::FromArgb(100, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(0, 255, 255, 255))
    $g.FillPath($barHiGrad, $barPath)
    $barHiGrad.Dispose(); $barPath.Dispose()

    $bmp.Save($OUT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "[OK] Saved: $OUT_PATH  ($SIZE x $SIZE)" -ForegroundColor Green
}
finally {
    if ($null -ne $g)   { $g.Dispose()   }
    if ($null -ne $bmp) { $bmp.Dispose() }
}
