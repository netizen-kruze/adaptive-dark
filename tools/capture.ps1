# Samples real screen pixels as fast as GDI allows and logs "unixMs,r,g,b" per sample.
param([int]$X, [int]$Y, [int]$Seconds, [string]$Out)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 24, 24
$g = [System.Drawing.Graphics]::FromImage($bmp)
$sb = New-Object System.Text.StringBuilder
$end = [DateTime]::UtcNow.AddSeconds($Seconds)
while ([DateTime]::UtcNow -lt $end) {
  $g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $r = 0; $gg = 0; $b = 0
  foreach ($p in @(@(2, 2), @(21, 2), @(12, 12), @(2, 21), @(21, 21))) { $c = $bmp.GetPixel($p[0], $p[1]); $r += $c.R; $gg += $c.G; $b += $c.B }
  [void]$sb.AppendLine("$t,$([int]($r / 5)),$([int]($gg / 5)),$([int]($b / 5))")
}
[System.IO.File]::WriteAllText($Out, $sb.ToString())
