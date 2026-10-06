Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force $outDir | Out-Null

function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

function Draw-Chibi($S) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $u = $S / 128.0
  function NewRect($x,$y,$w,$h) { New-Object System.Drawing.RectangleF ([single]($x*$u)), ([single]($y*$u)), ([single]($w*$u)), ([single]($h*$u)) }
  function Fill($hex,$x,$y,$w,$h) { $b = New-Object System.Drawing.SolidBrush (C $hex); $g.FillEllipse($b,(NewRect $x $y $w $h)); $b.Dispose() }
  function Poly($hex,$pts) {
    $b = New-Object System.Drawing.SolidBrush (C $hex)
    $arr = $pts | ForEach-Object { New-Object System.Drawing.PointF ([single]($_[0]*$u)), ([single]($_[1]*$u)) }
    $g.FillPolygon($b, [System.Drawing.PointF[]]$arr); $b.Dispose()
  }

  # background circle
  Fill '#FFE3EE' 2 2 124 124
  # hair back + twin tails
  Fill '#5B3A63' 14 12 100 100
  Fill '#5B3A63' 0 54 38 62
  Fill '#5B3A63' 90 54 38 62
  # cat ears
  Poly '#5B3A63' @(@(20,44),@(22,6),@(52,20))
  Poly '#5B3A63' @(@(108,44),@(106,6),@(76,20))
  Poly '#F7A8C4' @(@(27,34),@(28,16),@(43,24))
  Poly '#F7A8C4' @(@(101,34),@(100,16),@(85,24))
  # face
  Fill '#FFEBDD' 24 28 80 82
  # bangs
  Poly '#5B3A63' @(@(22,60),@(26,24),@(64,12),@(102,24),@(106,60),@(92,42),@(78,56),@(64,38),@(50,56),@(36,42))
  # eyes
  Fill '#3B2A4F' 34 62 24 30
  Fill '#3B2A4F' 70 62 24 30
  Fill '#7EC8E3' 38 70 16 20
  Fill '#7EC8E3' 74 70 16 20
  Fill '#FFFFFF' 40 66 10 11
  Fill '#FFFFFF' 76 66 10 11
  Fill '#FFFFFF' 47 82 5 5
  Fill '#FFFFFF' 83 82 5 5
  # blush
  Fill '#FF9DB8' 28 92 18 10
  Fill '#FF9DB8' 82 92 18 10
  # mouth
  $pen = New-Object System.Drawing.Pen ((C '#C2566F'), [single](2.6*$u))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawArc($pen, (NewRect 56 92 16 10), 10, 160)
  # hair ribbon
  Fill '#FF6F9F' 14 20 22 14
  Fill '#FF6F9F' 28 20 22 14
  Fill '#FFC2D8' 25 22 11 10
  $g.Dispose()
  return $bmp
}

$big = Draw-Chibi 512
foreach ($s in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($big, 0, 0, $s, $s)
  $g.Dispose()
  $bmp.Save((Join-Path $outDir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
$big.Dispose()
"done"

