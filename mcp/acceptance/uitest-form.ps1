# UIMOUSE-TEST form: click/double/right/middle counters, scroll textbox, drag tracker.
# Events append to uievents.log; control screen rects written to uirects.json on shown.
# ASCII only (PS 5.1). Kill the powershell process to close.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$base = 'D:\SDK-MCP\.tmpprobe'
$log = Join-Path $base 'uievents.log'
$rectFile = Join-Path $base 'uirects.json'
if (Test-Path $log) { Remove-Item $log }
$script:seq = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()
function LogEvt([string]$type, [string]$btn, [int]$x, [int]$y) {
  $script:seq++
  Add-Content -Path $log -Value ('{"seq":' + $script:seq + ',"ms":' + [int]$sw.ElapsedMilliseconds + ',"type":"' + $type + '","btn":"' + $btn + '","x":' + $x + ',"y":' + $y + '}')
}
$form = New-Object System.Windows.Forms.Form
$form.Text = 'UIMOUSE-TEST'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(700, 260)
$form.Size = New-Object System.Drawing.Size(520, 430)
$form.TopMost = $true
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false

function Add-Loggers($c) {
  $c.Add_MouseDown({ param($s, $e)
    $p = $s.PointToScreen($e.Location)
    $b = switch ($e.Button) { 'Left' { 'left' } 'Right' { 'right' } 'Middle' { 'middle' } default { 'other' } }
    LogEvt 'down' $b $p.X $p.Y
  })
  $c.Add_MouseUp({ param($s, $e)
    $p = $s.PointToScreen($e.Location)
    $b = switch ($e.Button) { 'Left' { 'left' } 'Right' { 'right' } 'Middle' { 'middle' } default { 'other' } }
    LogEvt 'up' $b $p.X $p.Y
  })
}

$btnL = New-Object System.Windows.Forms.Button
$btnL.Text = 'LEFT'; $btnL.Location = New-Object System.Drawing.Point(15, 12); $btnL.Size = New-Object System.Drawing.Size(150, 56)
$btnR = New-Object System.Windows.Forms.Button
$btnR.Text = 'RIGHT'; $btnR.Location = New-Object System.Drawing.Point(185, 12); $btnR.Size = New-Object System.Drawing.Size(150, 56)
$btnD = New-Object System.Windows.Forms.Button
$btnD.Text = 'DOUBLE'; $btnD.Location = New-Object System.Drawing.Point(355, 12); $btnD.Size = New-Object System.Drawing.Size(145, 56)
$btnD.Add_DoubleClick({ param($s, $e)
  $p = $s.PointToScreen($e.Location); LogEvt 'dbl' 'left' $p.X $p.Y
})
$edit = New-Object System.Windows.Forms.TextBox
$edit.Multiline = $true; $edit.ReadOnly = $true; $edit.ScrollBars = 'Vertical'
$edit.Location = New-Object System.Drawing.Point(15, 80); $edit.Size = New-Object System.Drawing.Size(485, 160)
$edit.Font = New-Object System.Drawing.Font('Consolas', 9)
$lines = for ($i = 1; $i -le 150; $i++) { 'line-{0:d3} scroll-test-content' -f $i }
$edit.Lines = $lines
$panel = New-Object System.Windows.Forms.Panel
$panel.Location = New-Object System.Drawing.Point(15, 252); $panel.Size = New-Object System.Drawing.Size(485, 135)
$panel.BorderStyle = 'FixedSingle'; $panel.BackColor = [System.Drawing.Color]::WhiteSmoke
$dragging = $false
$panel.Add_MouseDown({ param($s, $e)
  if ($e.Button -eq 'Left') { $script:dragging = $true; $p = $s.PointToScreen($e.Location); LogEvt 'dragStart' 'left' $p.X $p.Y }
  $b = switch ($e.Button) { 'Left' { 'left' } 'Right' { 'right' } 'Middle' { 'middle' } default { 'other' } }
  $p = $s.PointToScreen($e.Location); LogEvt 'down' $b $p.X $p.Y
})
$panel.Add_MouseMove({ param($s, $e)
  if ($script:dragging) { $p = $s.PointToScreen($e.Location); LogEvt 'dragMove' 'left' $p.X $p.Y }
})
$panel.Add_MouseUp({ param($s, $e)
  $p = $s.PointToScreen($e.Location)
  if ($e.Button -eq 'Left') { $script:dragging = $false; LogEvt 'dragEnd' 'left' $p.X $p.Y }
  LogEvt 'up' 'left' $p.X $p.Y
})
$tip = New-Object System.Windows.Forms.Label
$tip.Text = 'DRAG ZONE'; $tip.Location = New-Object System.Drawing.Point(8, 4); $tip.Size = New-Object System.Drawing.Size(80, 16); $tip.BackColor = [System.Drawing.Color]::Transparent
$panel.Controls.Add($tip)
$form.Controls.AddRange(@($btnL, $btnR, $btnD, $edit, $panel))
foreach ($c in @($form, $btnL, $btnR, $btnD, $edit)) { Add-Loggers $c }
$tip.Add_MouseDown({ param($s, $e) $form.Focus() })
function Add-DblLogger($c, [string]$tag) {
  $c.Add_DoubleClick({ param($s, $e)
    $p = $s.PointToScreen($e.Location); LogEvt 'dbl' $tag $p.X $p.Y
  })
}
Add-DblLogger $btnD 'btnD'
Add-DblLogger $btnL 'btnL'
Add-DblLogger $edit 'edit'
Add-DblLogger $panel 'panel'
$form.Add_Shown({
  $r = @{}
  $map = @{ btnL = $btnL; btnR = $btnR; btnD = $btnD; edit = $edit; panel = $panel }
  foreach ($k in $map.Keys) {
    $c = $map[$k]
    $sr = $form.RectangleToScreen($c.Bounds)
    if ($k -eq 'panel') { $r[$k] = @($sr.X, $sr.Y, $sr.Width, $sr.Height) }
    else { $r[$k] = @([int]($sr.X + $sr.Width / 2), [int]($sr.Y + $sr.Height / 2)) }
  }
  $r['form'] = @($form.Left, $form.Top, $form.Width, $form.Height)
  $r | ConvertTo-Json -Compress | Set-Content -Path $rectFile
})
[void]$form.ShowDialog()
