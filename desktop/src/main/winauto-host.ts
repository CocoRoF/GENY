// ─────────────────────────────────────────────────────────────────────────────
// WinAutoHost — structured Windows application control for the agent.
//
// A PERSISTENT Windows PowerShell 5.1 child process (STA — required for both
// UI Automation and Office COM) hosts two capability sets:
//
//   · UIA  (app_windows / app_snapshot / app_act / app_read): walk any app's
//     accessibility tree, address controls as e1,e2,…, and drive them through
//     real automation patterns (Invoke/Toggle/SetValue/Select/Expand) instead
//     of blind pixel clicks. When a control exposes no pattern the host returns
//     its bounds and main falls back to a nut.js click at the center.
//
//   · Office COM (office_status / office_read / office_act): the LIVE
//     PowerPoint/Word/Excel instances the user is looking at — read slide/
//     paragraph/cell content, edit text, add slides, export PDF. Complements
//     Geny's file-based document tools (those edit files; this drives the app).
//
// Protocol: JSON lines over stdio — {id,op,args} in → {id,ok,result|error} out.
// Calls are serialized (single STA apartment); the host lazy-starts and
// auto-restarts if it dies. Windows-only by nature; other platforms get a
// clean "Windows-only" error from ensure().
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'

// NOTE: this is a plain (non-template) string built via String.raw with NO
// backticks and NO ${ sequences inside — PowerShell's escape char (backtick)
// and JS interpolation would otherwise collide.
const HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GenyWin { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'

$script:elems = @{}
$script:wins = @{}

function TryPattern($el, $patName) {
  $field = [System.Windows.Automation.AutomationElement].Assembly.GetType('System.Windows.Automation.' + $patName + 'Pattern')
  if ($null -eq $field) { return $null }
  $prop = $field.GetField('Pattern').GetValue($null)
  $out = $null
  if ($el.TryGetCurrentPattern($prop, [ref]$out)) { return $out }
  return $null
}

function ShortRole($el) {
  $ct = $el.Current.ControlType.ProgrammaticName
  return $ct.Replace('ControlType.', '')
}

function PatternFlags($el) {
  $flags = @()
  foreach ($p in @('Invoke','Toggle','SelectionItem','Value','ExpandCollapse','RangeValue','Text','Window','ScrollItem')) {
    if ($null -ne (TryPattern $el $p)) { $flags += $p.ToLower() }
  }
  return $flags
}

function BoundsOf($el) {
  $r = $el.Current.BoundingRectangle
  if ([double]::IsInfinity($r.Width)) { return $null }
  return @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
}

function Op-Windows($a) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $kids = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $fg = [GenyWin]::GetForegroundWindow()
  $script:wins = @{}
  $out = New-Object System.Collections.Generic.List[object]
  $i = 1
  foreach ($k in $kids) {
    $c = $k.Current
    if ([string]::IsNullOrWhiteSpace($c.Name)) { continue }
    $procName = ''
    try { $procName = (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch {}
    if ($procName -eq 'geny-connector') { continue }
    $id = 'w' + $i; $i = $i + 1
    $script:wins[$id] = $k
    $out.Add(@{ id = $id; title = ('' + $c.Name); process = $procName; process_id = $c.ProcessId; focused = ($c.NativeWindowHandle -eq [int]$fg); offscreen = $c.IsOffscreen })
  }
  return @{ windows = $out; hint = 'app_snapshot {window:"w2"} maps its controls; app_act acts on them.' }
}

function Resolve-Win($sel) {
  if ($script:wins.ContainsKey('' + $sel)) { return $script:wins['' + $sel] }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $kids = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($k in $kids) {
    if (('' + $k.Current.Name).ToLower().Contains(('' + $sel).ToLower())) { return $k }
  }
  throw ('window not found: ' + $sel + ' - call app_windows first')
}

function Op-WinSnapshot($a) {
  $win = Resolve-Win $a.window
  $maxNodes = 350
  $script:elems = @{}
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $lines = New-Object System.Collections.Generic.List[string]
  $eid = 1
  $visited = 0
  # Preorder DFS with an explicit stack; children pushed in reverse for order.
  $stack = New-Object System.Collections.Generic.Stack[object]
  $stack.Push(@($win, 0))
  while ($stack.Count -gt 0) {
    if ($visited -ge $maxNodes) { break }
    $pair = $stack.Pop()
    $el = $pair[0]; $depth = $pair[1]
    $visited = $visited + 1
    $c = $el.Current
    $role = ShortRole $el
    $name = ('' + $c.Name)
    if ($name.Length -gt 70) { $name = $name.Substring(0, 70) }
    $flags = @()
    if ($depth -gt 0) { $flags = PatternFlags $el }
    $interactive = ($flags.Count -gt 0) -or ($role -in @('Button','Edit','ComboBox','CheckBox','RadioButton','ListItem','TabItem','MenuItem','Hyperlink','TreeItem','Slider','SplitButton','Document'))
    $show = $interactive -or (-not [string]::IsNullOrWhiteSpace($name))
    if ($show -and $depth -gt 0 -and -not $c.IsOffscreen) {
      $id = 'e' + $eid; $eid = $eid + 1
      $script:elems[$id] = $el
      $ind = ' ' * [Math]::Min($depth, 10)
      $line = $ind + $id + ' ' + $role + ' "' + $name + '"'
      $vp = TryPattern $el 'Value'
      if ($null -ne $vp) {
        $v = ('' + $vp.Current.Value)
        if ($v.Length -gt 50) { $v = $v.Substring(0, 50) }
        if ($v -ne '') { $line = $line + ' value="' + $v + '"' }
      }
      $tp = TryPattern $el 'Toggle'
      if ($null -ne $tp) { $line = $line + ' (' + $tp.Current.ToggleState + ')' }
      if ($flags.Count -gt 0) { $line = $line + ' [' + ($flags -join ',') + ']' }
      if (-not $c.IsEnabled) { $line = $line + ' (disabled)' }
      $lines.Add($line)
    }
    if ($depth -lt 14) {
      $kids = New-Object System.Collections.Generic.List[object]
      $child = $walker.GetFirstChild($el)
      while ($null -ne $child) {
        $kids.Add($child)
        if ($kids.Count -ge 60) { break }
        $child = $walker.GetNextSibling($child)
      }
      for ($j = $kids.Count - 1; $j -ge 0; $j--) { $stack.Push(@($kids[$j], $depth + 1)) }
    }
  }
  return @{ window = ('' + $win.Current.Name); controls = $lines; truncated = ($visited -ge $maxNodes); hint = 'app_act {element:"e5", action:"invoke"|"set_value"|...} drives a control.' }
}

function Op-ElAct($a) {
  $id = '' + $a.element
  if (-not $script:elems.ContainsKey($id)) { throw 'stale element id - call app_snapshot again' }
  $el = $script:elems[$id]
  $action = '' + $a.action
  if ($action -eq 'invoke' -or $action -eq 'click') {
    $p = TryPattern $el 'Invoke'
    if ($null -ne $p) { $p.Invoke(); return @{ done = ('invoked ' + $id) } }
    $p = TryPattern $el 'Toggle'
    if ($null -ne $p) { $p.Toggle(); return @{ done = ('toggled ' + $id) } }
    $p = TryPattern $el 'SelectionItem'
    if ($null -ne $p) { $p.Select(); return @{ done = ('selected ' + $id) } }
    $b = BoundsOf $el
    if ($null -ne $b) { return @{ no_pattern = $true; bounds = $b; note = 'no automation pattern - falling back to a real click' } }
    throw ($id + ' exposes no invoke/toggle/select pattern and has no bounds')
  }
  if ($action -eq 'toggle') { $p = TryPattern $el 'Toggle'; if ($null -eq $p) { throw 'no Toggle pattern' }; $p.Toggle(); return @{ done = 'toggled'; state = ('' + $p.Current.ToggleState) } }
  if ($action -eq 'select') { $p = TryPattern $el 'SelectionItem'; if ($null -eq $p) { throw 'no SelectionItem pattern' }; $p.Select(); return @{ done = 'selected' } }
  if ($action -eq 'set_value') {
    $p = TryPattern $el 'Value'
    if ($null -eq $p) { throw 'no Value pattern - try app_act invoke to focus, then desktop_type' }
    $p.SetValue('' + $a.value)
    return @{ done = ('value set on ' + $id) }
  }
  if ($action -eq 'expand') { $p = TryPattern $el 'ExpandCollapse'; if ($null -eq $p) { throw 'no ExpandCollapse pattern' }; $p.Expand(); return @{ done = 'expanded' } }
  if ($action -eq 'collapse') { $p = TryPattern $el 'ExpandCollapse'; if ($null -eq $p) { throw 'no ExpandCollapse pattern' }; $p.Collapse(); return @{ done = 'collapsed' } }
  if ($action -eq 'focus') { $el.SetFocus(); return @{ done = 'focused' } }
  if ($action -eq 'scroll_into_view') { $p = TryPattern $el 'ScrollItem'; if ($null -eq $p) { throw 'no ScrollItem pattern' }; $p.ScrollIntoView(); return @{ done = 'scrolled into view' } }
  if ($action -eq 'close_window') { $p = TryPattern $el 'Window'; if ($null -eq $p) { throw 'no Window pattern' }; $p.Close(); return @{ done = 'window closed' } }
  throw ('unknown action: ' + $action)
}

function Op-WinFocus($a) {
  $win = Resolve-Win $a.window
  $h = [IntPtr]$win.Current.NativeWindowHandle
  [GenyWin]::SetForegroundWindow($h) | Out-Null
  return @{ done = ('focused ' + $win.Current.Name) }
}

function Op-WinRead($a) {
  $target = $null
  if ($a.element -and $script:elems.ContainsKey('' + $a.element)) { $target = $script:elems['' + $a.element] }
  elseif ($a.window) { $target = Resolve-Win $a.window }
  else { throw 'app_read needs window or element' }
  $tp = TryPattern $target 'Text'
  if ($null -ne $tp) {
    $txt = $tp.DocumentRange.GetText(24000)
    return @{ text = $txt; source = 'text-pattern' }
  }
  # Aggregate visible leaf names/values.
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $sb = New-Object System.Text.StringBuilder
  $stack = New-Object System.Collections.Generic.Stack[object]
  $stack.Push(@($target, 0))
  $n = 0
  while ($stack.Count -gt 0 -and $n -lt 400 -and $sb.Length -lt 24000) {
    $pair = $stack.Pop(); $el = $pair[0]; $d = $pair[1]
    $n = $n + 1
    $c = $el.Current
    if (-not $c.IsOffscreen) {
      $nm = ('' + $c.Name).Trim()
      if ($nm -ne '') { [void]$sb.AppendLine($nm) }
      $vp = TryPattern $el 'Value'
      if ($null -ne $vp) { $v = ('' + $vp.Current.Value).Trim(); if ($v -ne '' -and $v -ne $nm) { [void]$sb.AppendLine($v) } }
    }
    if ($d -lt 14) {
      $kids = New-Object System.Collections.Generic.List[object]
      $child = $walker.GetFirstChild($el)
      while ($null -ne $child) { $kids.Add($child); if ($kids.Count -ge 50) { break }; $child = $walker.GetNextSibling($child) }
      for ($j = $kids.Count - 1; $j -ge 0; $j--) { $stack.Push(@($kids[$j], $d + 1)) }
    }
  }
  return @{ text = $sb.ToString(); source = 'aggregated' }
}

# ── Office COM ───────────────────────────────────────────────────────────────
function Get-OfficeApp($name, $create) {
  $map = @{ powerpoint = 'PowerPoint.Application'; word = 'Word.Application'; excel = 'Excel.Application' }
  $prog = $map['' + $name]
  if ($null -eq $prog) { throw ('unknown office app: ' + $name + ' (use powerpoint|word|excel)') }
  try { return [System.Runtime.InteropServices.Marshal]::GetActiveObject($prog) } catch {}
  if ($create) {
    $app = New-Object -ComObject $prog
    try { $app.Visible = $true } catch {}
    return $app
  }
  throw ($name + ' is not running - office_act {action:"open", path:...} or ask the user to open it')
}

function Op-OfficeStatus($a) {
  $out = @{}
  try {
    $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
    $docs = @(); foreach ($p in $app.Presentations) { $docs += @{ name = $p.Name; path = ('' + $p.FullName); slides = $p.Slides.Count } }
    $out.powerpoint = @{ running = $true; documents = $docs }
  } catch { $out.powerpoint = @{ running = $false } }
  try {
    $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
    $docs = @(); foreach ($d in $app.Documents) { $docs += @{ name = $d.Name; path = ('' + $d.FullName) } }
    $out.word = @{ running = $true; documents = $docs }
  } catch { $out.word = @{ running = $false } }
  try {
    $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
    $docs = @()
    foreach ($w in $app.Workbooks) {
      $sheets = @(); foreach ($s in $w.Worksheets) { $sheets += ('' + $s.Name); if ($sheets.Count -ge 20) { break } }
      $docs += @{ name = $w.Name; path = ('' + $w.FullName); sheets = $sheets }
    }
    $out.excel = @{ running = $true; workbooks = $docs }
  } catch { $out.excel = @{ running = $false } }
  return $out
}

function Resolve-PptDoc($app, $name) {
  if ($name) { foreach ($p in $app.Presentations) { if ($p.Name -eq $name) { return $p } } }
  if ($app.Presentations.Count -gt 0) { try { return $app.ActivePresentation } catch { return $app.Presentations.Item(1) } }
  throw 'no open presentation'
}
function Resolve-WordDoc($app, $name) {
  if ($name) { foreach ($d in $app.Documents) { if ($d.Name -eq $name) { return $d } } }
  if ($app.Documents.Count -gt 0) { try { return $app.ActiveDocument } catch { return $app.Documents.Item(1) } }
  throw 'no open document'
}
function Resolve-Workbook($app, $name) {
  if ($name) { foreach ($w in $app.Workbooks) { if ($w.Name -eq $name) { return $w } } }
  if ($app.Workbooks.Count -gt 0) { try { return $app.ActiveWorkbook } catch { return $app.Workbooks.Item(1) } }
  throw 'no open workbook'
}

function Op-OfficeRead($a) {
  $appName = '' + $a.app
  $app = Get-OfficeApp $appName $false
  if ($appName -eq 'powerpoint') {
    $pres = Resolve-PptDoc $app $a.document
    $slides = New-Object System.Collections.Generic.List[object]
    $budget = 25000
    foreach ($s in $pres.Slides) {
      $shapes = New-Object System.Collections.Generic.List[object]
      $si = 0
      foreach ($sh in $s.Shapes) {
        $si = $si + 1
        $txt = ''
        try { if ($sh.HasTextFrame) { $txt = ('' + $sh.TextFrame.TextRange.Text) } } catch {}
        if ($txt.Length -gt 400) { $txt = $txt.Substring(0, 400) }
        $budget = $budget - $txt.Length
        $shapes.Add(@{ shape = $si; name = ('' + $sh.Name); text = $txt })
      }
      $slides.Add(@{ slide = $s.SlideIndex; shapes = $shapes })
      if ($budget -lt 0) { break }
    }
    return @{ document = $pres.Name; slide_count = $pres.Slides.Count; slides = $slides; truncated = ($budget -lt 0); hint = 'edit with office_act set_shape_text {slide, shape, text}' }
  }
  if ($appName -eq 'word') {
    $doc = Resolve-WordDoc $app $a.document
    $paras = New-Object System.Collections.Generic.List[object]
    $budget = 25000
    $i = 0
    foreach ($p in $doc.Paragraphs) {
      $i = $i + 1
      $t = ('' + $p.Range.Text).TrimEnd([char]13, [char]10)
      if ($t -ne '') {
        if ($t.Length -gt 500) { $t = $t.Substring(0, 500) }
        $budget = $budget - $t.Length
        $paras.Add(@{ index = $i; text = $t })
      }
      if ($budget -lt 0 -or $i -ge 800) { break }
    }
    return @{ document = $doc.Name; paragraphs = $paras; truncated = ($budget -lt 0) }
  }
  if ($appName -eq 'excel') {
    $wb = Resolve-Workbook $app $a.document
    $ws = $null
    if ($a.sheet) { $ws = $wb.Worksheets.Item('' + $a.sheet) } else { $ws = $wb.ActiveSheet }
    $ur = $ws.UsedRange
    $rows = [Math]::Min($ur.Rows.Count, 80)
    $cols = [Math]::Min($ur.Columns.Count, 40)
    $data = New-Object System.Collections.Generic.List[object]
    for ($r = 1; $r -le $rows; $r++) {
      $row = New-Object System.Collections.Generic.List[object]
      for ($c = 1; $c -le $cols; $c++) {
        $v = $ur.Cells.Item($r, $c).Value2
        if ($null -eq $v) { $row.Add('') } else { $row.Add(('' + $v)) }
      }
      $data.Add($row)
    }
    $sheets = @(); foreach ($s in $wb.Worksheets) { $sheets += ('' + $s.Name); if ($sheets.Count -ge 30) { break } }
    return @{ workbook = $wb.Name; sheet = ('' + $ws.Name); sheets = $sheets; first_cell = ('' + $ur.Cells.Item(1,1).Address($false, $false)); rows = $data; truncated = ($ur.Rows.Count -gt $rows -or $ur.Columns.Count -gt $cols) }
  }
  throw ('unknown office app: ' + $appName)
}

function Op-OfficeAct($a) {
  $appName = '' + $a.app
  $action = '' + $a.action
  if ($action -eq 'open') {
    $app = Get-OfficeApp $appName $true
    if (-not $a.path) { throw 'open needs path' }
    if ($appName -eq 'powerpoint') { $d = $app.Presentations.Open('' + $a.path); return @{ done = ('opened ' + $d.Name); slides = $d.Slides.Count } }
    if ($appName -eq 'word') { $d = $app.Documents.Open('' + $a.path); return @{ done = ('opened ' + $d.Name) } }
    if ($appName -eq 'excel') { $d = $app.Workbooks.Open('' + $a.path); return @{ done = ('opened ' + $d.Name) } }
  }
  if ($action -eq 'new') {
    $app = Get-OfficeApp $appName $true
    if ($appName -eq 'powerpoint') { $d = $app.Presentations.Add(); return @{ done = ('created ' + $d.Name) } }
    if ($appName -eq 'word') { $d = $app.Documents.Add(); return @{ done = ('created ' + $d.Name) } }
    if ($appName -eq 'excel') { $d = $app.Workbooks.Add(); return @{ done = ('created ' + $d.Name) } }
  }
  $app = Get-OfficeApp $appName $false
  if ($action -eq 'save') {
    if ($appName -eq 'powerpoint') { (Resolve-PptDoc $app $a.document).Save(); return @{ done = 'saved' } }
    if ($appName -eq 'word') { (Resolve-WordDoc $app $a.document).Save(); return @{ done = 'saved' } }
    if ($appName -eq 'excel') { (Resolve-Workbook $app $a.document).Save(); return @{ done = 'saved' } }
  }
  if ($action -eq 'save_as') {
    if (-not $a.path) { throw 'save_as needs path' }
    if ($appName -eq 'powerpoint') { (Resolve-PptDoc $app $a.document).SaveAs('' + $a.path); return @{ done = ('saved as ' + $a.path) } }
    if ($appName -eq 'word') { (Resolve-WordDoc $app $a.document).SaveAs2('' + $a.path); return @{ done = ('saved as ' + $a.path) } }
    if ($appName -eq 'excel') { (Resolve-Workbook $app $a.document).SaveAs('' + $a.path); return @{ done = ('saved as ' + $a.path) } }
  }
  if ($action -eq 'export_pdf') {
    if (-not $a.path) { throw 'export_pdf needs path' }
    if ($appName -eq 'powerpoint') { (Resolve-PptDoc $app $a.document).SaveAs('' + $a.path, 32); return @{ done = ('exported PDF: ' + $a.path) } }
    if ($appName -eq 'word') { (Resolve-WordDoc $app $a.document).ExportAsFixedFormat('' + $a.path, 17); return @{ done = ('exported PDF: ' + $a.path) } }
    if ($appName -eq 'excel') { (Resolve-Workbook $app $a.document).ExportAsFixedFormat(0, '' + $a.path); return @{ done = ('exported PDF: ' + $a.path) } }
  }
  if ($appName -eq 'powerpoint') {
    $pres = Resolve-PptDoc $app $a.document
    if ($action -eq 'goto_slide') { $app.ActiveWindow.View.GotoSlide([int]$a.slide); return @{ done = ('on slide ' + $a.slide) } }
    if ($action -eq 'set_shape_text') {
      $slide = $pres.Slides.Item([int]$a.slide)
      $shape = $null
      $sn = '' + $a.shape
      if ($sn -match '^[0-9]+$') { $shape = $slide.Shapes.Item([int]$sn) } else { $shape = $slide.Shapes.Item($sn) }
      if (-not $shape.HasTextFrame) { throw 'shape has no text frame' }
      $shape.TextFrame.TextRange.Text = ('' + $a.text)
      return @{ done = ('slide ' + $a.slide + ' shape ' + $a.shape + ' text set') }
    }
    if ($action -eq 'add_slide') {
      $idx = $pres.Slides.Count + 1
      if ($a.index) { $idx = [int]$a.index }
      $s = $pres.Slides.Add($idx, 2)
      if ($a.title) { try { $s.Shapes.Item(1).TextFrame.TextRange.Text = ('' + $a.title) } catch {} }
      if ($a.text) { try { $s.Shapes.Item(2).TextFrame.TextRange.Text = ('' + $a.text) } catch {} }
      return @{ done = ('added slide ' + $idx); slide = $idx }
    }
    if ($action -eq 'delete_slide') { $pres.Slides.Item([int]$a.slide).Delete(); return @{ done = ('deleted slide ' + $a.slide) } }
  }
  if ($appName -eq 'word') {
    $doc = Resolve-WordDoc $app $a.document
    if ($action -eq 'append_text') { $doc.Content.InsertAfter(('' + $a.text)); return @{ done = 'text appended' } }
    if ($action -eq 'replace_text') {
      if (-not $a.find) { throw 'replace_text needs find + replace' }
      $rng = $doc.Content
      $count = 0
      while ($rng.Find.Execute(('' + $a.find), $false, $false, $false, $false, $false, $true, 1, $false, ('' + $a.replace), 1)) {
        $count = $count + 1
        if ($count -ge 200) { break }
        if ($a.all -ne $true) { break }
      }
      return @{ done = ('replaced ' + $count + ' occurrence(s)') }
    }
  }
  if ($appName -eq 'excel') {
    $wb = Resolve-Workbook $app $a.document
    $ws = $null
    if ($a.sheet) { $ws = $wb.Worksheets.Item('' + $a.sheet) } else { $ws = $wb.ActiveSheet }
    if ($action -eq 'set_cell') {
      if (-not $a.cell) { throw 'set_cell needs cell (e.g. B3) + value' }
      $ws.Range('' + $a.cell).Value2 = $a.value
      return @{ done = ($a.cell + ' set') }
    }
    if ($action -eq 'set_range') {
      if (-not $a.start -or $null -eq $a.values) { throw 'set_range needs start (e.g. A1) + values [[...],[...]]' }
      $startCell = $ws.Range('' + $a.start)
      $r0 = $startCell.Row; $c0 = $startCell.Column
      $ri = 0
      foreach ($row in $a.values) {
        $ci = 0
        foreach ($v in $row) { $ws.Cells.Item($r0 + $ri, $c0 + $ci).Value2 = $v; $ci = $ci + 1 }
        $ri = $ri + 1
      }
      return @{ done = ($ri + ' row(s) written from ' + $a.start) }
    }
  }
  throw ('unknown office action: ' + $action + ' for ' + $appName)
}

function Dispatch($op, $a) {
  if ($null -eq $a) { $a = @{} }
  switch ($op) {
    'windows' { return Op-Windows $a }
    'win_snapshot' { return Op-WinSnapshot $a }
    'el_act' { return Op-ElAct $a }
    'win_focus' { return Op-WinFocus $a }
    'win_read' { return Op-WinRead $a }
    'office_status' { return Op-OfficeStatus $a }
    'office_read' { return Op-OfficeRead $a }
    'office_act' { return Op-OfficeAct $a }
    default { throw ('unknown op: ' + $op) }
  }
}

[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $resp = @{ id = $req.id }
  try {
    $resp.ok = $true
    $resp.result = Dispatch ('' + $req.op) $req.args
  } catch {
    $resp.ok = $false
    $resp.error = ('' + $_.Exception.Message)
  }
  [Console]::Out.WriteLine((ConvertTo-Json $resp -Depth 8 -Compress))
}
`

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

class WinAutoHost {
  private proc: ChildProcess | null = null
  private rl: Interface | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private starting: Promise<void> | null = null
  /** Serialize calls — the host is a single STA apartment (UIA + COM). */
  private chain: Promise<unknown> = Promise.resolve()

  private async start(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('app/office control is Windows-only')
    const encoded = Buffer.from(HOST_SCRIPT, 'utf16le').toString('base64')
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    )
    this.proc = proc
    this.rl = createInterface({ input: proc.stdout! })
    const readyP = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('winauto host start timeout')), 15000)
      const onLine = (line: string): void => {
        try {
          const msg = JSON.parse(line.replace(/^\uFEFF/, ''))
          if (msg.ready) {
            clearTimeout(t)
            this.rl?.off('line', onLine)
            resolve()
            return
          }
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            clearTimeout(p.timer)
            if (msg.ok) p.resolve(msg.result)
            else p.reject(new Error(String(msg.error || 'winauto call failed')))
          }
        } catch {
          /* non-JSON noise on stdout — ignore */
        }
      }
      this.rl!.on('line', onLine)
      proc.once('exit', () => {
        clearTimeout(t)
        reject(new Error('winauto host exited during start'))
      })
    })
    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = null
        this.rl = null
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error('winauto host died'))
        }
        this.pending.clear()
      }
    })
    // After ready, route all subsequent lines to pending resolvers.
    await readyP
    this.rl!.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line.replace(/^\uFEFF/, ''))
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.ok) p.resolve(msg.result)
          else p.reject(new Error(String(msg.error || 'winauto call failed')))
        }
      } catch {
        /* ignore */
      }
    })
  }

  private async ensure(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  call(op: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      await this.ensure()
      const id = this.nextId++
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`winauto ${op} timeout (${timeoutMs / 1000}s)`))
        }, timeoutMs)
        this.pending.set(id, { resolve, reject, timer })
        this.proc!.stdin!.write(JSON.stringify({ id, op, args }) + '\n', (err) => {
          if (err) {
            this.pending.delete(id)
            clearTimeout(timer)
            reject(err)
          }
        })
      })
    }
    // Serialize; a failed call must not break the chain for the next one.
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  dispose(): void {
    try {
      this.proc?.stdin?.end()
      this.proc?.kill()
    } catch {
      /* already gone */
    }
    this.proc = null
  }
}

let _host: WinAutoHost | null = null
export function getWinAutoHost(): WinAutoHost {
  if (!_host) _host = new WinAutoHost()
  return _host
}
export function disposeWinAutoHost(): void {
  _host?.dispose()
  _host = null
}
