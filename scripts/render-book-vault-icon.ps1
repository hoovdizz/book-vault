$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $repositoryRoot "public\book-vault-icon.png"
$bitmap = [System.Drawing.Bitmap]::new(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#241713"))
$backgroundPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
$backgroundPath.AddArc(8, 8, 56, 56, 180, 90)
$backgroundPath.AddArc(192, 8, 56, 56, 270, 90)
$backgroundPath.AddArc(192, 192, 56, 56, 0, 90)
$backgroundPath.AddArc(8, 192, 56, 56, 90, 90)
$backgroundPath.CloseFigure()
$graphics.FillPath($background, $backgroundPath)

$pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#F0A45B"), 13)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

$leftPage = [System.Drawing.Drawing2D.GraphicsPath]::new()
$leftPage.StartFigure()
$leftPage.AddLine(39, 55, 88, 55)
$leftPage.AddBezier(88, 55, 110, 55, 128, 73, 128, 95)
$leftPage.AddLine(128, 95, 128, 207)
$leftPage.AddBezier(128, 207, 113, 190, 96, 182, 74, 182)
$leftPage.AddLine(74, 182, 39, 182)
$leftPage.CloseFigure()
$graphics.DrawPath($pen, $leftPage)

$rightPage = [System.Drawing.Drawing2D.GraphicsPath]::new()
$rightPage.StartFigure()
$rightPage.AddLine(217, 55, 168, 55)
$rightPage.AddBezier(168, 55, 146, 55, 128, 73, 128, 95)
$rightPage.AddLine(128, 95, 128, 207)
$rightPage.AddBezier(128, 207, 143, 190, 160, 182, 182, 182)
$rightPage.AddLine(182, 182, 217, 182)
$rightPage.CloseFigure()
$graphics.DrawPath($pen, $rightPage)

$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$rightPage.Dispose()
$leftPage.Dispose()
$pen.Dispose()
$backgroundPath.Dispose()
$background.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "Rendered $outputPath"
