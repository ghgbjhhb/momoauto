param(
    [string]$Endpoint = 'http://localhost:8000',
    [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
$projectDir = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) {
    $OutputDir = Join-Path $projectDir ('.local-output/screenparser-eval-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
[IO.Directory]::CreateDirectory($OutputDir) | Out-Null

# Manually marked visible regions from the four supplied screenshots.
# Coordinates refer to the original screenshot, not a remembered tap position.
# Clipped rows and hidden badges are excluded from recall denominators.
$fixtures = @(
    @{id='01-top'; file='2600ddbc-3061-4f00-bf70-c28db1b7b4c7'; crop=@(0,84,397,796);
      rows=@(@(0,355,397,437),@(0,438,397,519),@(0,602,397,686));
      avatars=@(@(13,364,75,425),@(13,445,75,507),@(13,607,75,670));
      badges=@(@(356,398,382,419),@(356,479,382,500));
      note='3 full ordinary conversation rows; 2 system entries; AI overlay; next row clipped'},
    @{id='02-clipboard'; file='f1fffeda-888f-4b63-880e-6699fbeb3cc8'; crop=@(0,84,397,796);
      rows=@(@(0,357,397,439),@(0,440,397,521),@(0,606,397,689));
      avatars=@(@(13,367,75,428),@(13,448,75,509));
      badges=@(@(356,401,382,422),@(356,482,382,503));
      note='3 conversation rows; avatar in third row partly hidden and excluded; clipboard and AI overlays'},
    @{id='03-middle'; file='176e6488-baee-44de-9d83-bf244bdb5ae0'; crop=@(0,84,397,796);
      rows=@(@(0,223,397,303),@(0,389,397,467),@(0,472,397,549),@(0,553,397,632),@(0,635,397,705));
      avatars=@(@(13,232,75,294),@(13,394,75,455),@(13,475,75,538),@(13,559,75,620),@(13,638,75,700));
      badges=@(@(354,265,382,288),@(354,428,382,451),@(354,510,382,533),@(354,592,382,615));
      note='5 full conversation rows; 1 system entry; top row clipped; AI overlay'},
    @{id='04-recent-online'; file='10aeb4de-a20a-4bc1-b063-85aa254450c9'; crop=@(0,88,397,800);
      rows=@(@(0,413,397,493),@(0,495,397,575),@(0,576,397,657));
      avatars=@(@(11,419,77,483),@(13,502,76,565),@(13,583,76,646));
      badges=@(@(354,454,382,477),@(354,535,382,558),@(354,615,382,638));
      note='3 full conversation rows; 4 recent-online recommendation avatars; top/bottom rows clipped; AI overlay'}
)
$settings = @(
    @{id='default'; conf=0.10; iou=0.10; imgsz=1280},
    @{id='higher-iou'; conf=0.10; iou=0.45; imgsz=1280},
    @{id='low-confidence'; conf=0.03; iou=0.45; imgsz=1280}
)
$http = [Net.Http.HttpClient]::new()
$http.Timeout = [TimeSpan]::FromSeconds(60)
$allResults = [Collections.Generic.List[object]]::new()
$health = $http.GetStringAsync($Endpoint + '/').GetAwaiter().GetResult() | ConvertFrom-Json

function Invoke-Parse([string]$ImagePath, $Settings) {
    $uri = $Endpoint + '/parse?conf=' + $Settings.conf.ToString([Globalization.CultureInfo]::InvariantCulture) +
        '&iou=' + $Settings.iou.ToString([Globalization.CultureInfo]::InvariantCulture) + '&imgsz=' + $Settings.imgsz
    $body = [Net.Http.MultipartFormDataContent]::new()
    $content = [Net.Http.ByteArrayContent]::new([IO.File]::ReadAllBytes($ImagePath))
    $content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new('image/png')
    $body.Add($content, 'file', [IO.Path]::GetFileName($ImagePath))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = $http.PostAsync($uri, $body).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode() | Out-Null
        $data = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        $timer.Stop()
        return @{data=$data; requestMs=[Math]::Round($timer.Elapsed.TotalMilliseconds,2)}
    } finally {
        if ($response) { $response.Dispose() }
        $body.Dispose()
    }
}

function Get-Iou($A, $B) {
    $left=[Math]::Max($A[0],$B[0]); $top=[Math]::Max($A[1],$B[1])
    $right=[Math]::Min($A[2],$B[2]); $bottom=[Math]::Min($A[3],$B[3])
    $area=[Math]::Max(0,$right-$left)*[Math]::Max(0,$bottom-$top)
    $union=($A[2]-$A[0])*($A[3]-$A[1])+($B[2]-$B[0])*($B[3]-$B[1])-$area
    if ($union -le 0) { return 0 }
    return $area/$union
}

function Measure-Regions($Regions, $Elements, $Crop, [string[]]$Labels) {
    $matches=[Collections.Generic.List[object]]::new()
    $used=[Collections.Generic.HashSet[int]]::new()
    foreach ($region in $Regions) {
        $expected=@(($region[0] - $Crop[0]),($region[1] - $Crop[1]),($region[2] - $Crop[0]),($region[3] - $Crop[1]))
        $best=0.0; $bestIndex=-1
        for ($index=0; $index -lt $Elements.Count; $index++) {
            if ($used.Contains($index) -or $Labels -notcontains $Elements[$index].label) { continue }
            $overlap=Get-Iou $expected $Elements[$index].bbox
            if ($overlap -gt $best) { $best=$overlap; $bestIndex=$index }
        }
        $hit=$best -ge 0.5
        if ($hit) { $used.Add($bestIndex) | Out-Null }
        $matches.Add(@{expected=$expected; hit=$hit; bestIou=[Math]::Round($best,3);
          matched=if($bestIndex -ge 0){$Elements[$bestIndex]}else{$null}})
    }
    return @{expected=$Regions.Count; hit=@($matches | Where-Object {$_.hit}).Count;
      matches=$matches.ToArray(); threshold=0.5; labels=$Labels}
}

function Save-Annotation([string]$ImagePath, $Elements, [string]$Destination, [string]$Caption) {
    $bitmap=[Drawing.Bitmap]::new($ImagePath)
    $graphics=[Drawing.Graphics]::FromImage($bitmap)
    $font=[Drawing.Font]::new('Arial',8)
    $palette=@{'Avatar'=[Drawing.Color]::LimeGreen; 'Badge'=[Drawing.Color]::Red;
      'List Item'=[Drawing.Color]::DodgerBlue; 'Text'=[Drawing.Color]::DarkOrange;
      'Image'=[Drawing.Color]::Magenta; 'List'=[Drawing.Color]::BlueViolet;
      'Alert'=[Drawing.Color]::Cyan; 'Notification'=[Drawing.Color]::Cyan}
    try {
        $number=0
        foreach ($element in $Elements) {
            if (-not $palette.ContainsKey($element.label)) { continue }
            $number++
            $pen=[Drawing.Pen]::new($palette[$element.label],2)
            $brush=[Drawing.SolidBrush]::new($palette[$element.label])
            $box=$element.bbox
            $graphics.DrawRectangle($pen,[float]$box[0],[float]$box[1],[float]($box[2]-$box[0]),[float]($box[3]-$box[1]))
            $label='#'+$number+' '+$element.label+' '+$element.confidence
            $y=[Math]::Max(0,$box[1]-12)
            $graphics.FillRectangle([Drawing.Brushes]::White,[float]$box[0],[float]$y,[float][Math]::Min(190,$bitmap.Width-$box[0]),12)
            $graphics.DrawString($label,$font,$brush,[float]$box[0],[float]$y)
            $pen.Dispose(); $brush.Dispose()
        }
        $bitmap.Save($Destination,[Drawing.Imaging.ImageFormat]::Png)
    } finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}

try {
    foreach ($fixture in $fixtures) {
        $source='C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-'+$fixture.file+'.png'
        $image=[Drawing.Bitmap]::new($source)
        $crop=$fixture.crop
        $rectangle=[Drawing.Rectangle]::new($crop[0],$crop[1],$crop[2]-$crop[0],$crop[3]-$crop[1])
        $cropped=$image.Clone($rectangle,$image.PixelFormat)
        $cropPath=Join-Path $OutputDir ($fixture.id+'-phone.png')
        $cropped.Save($cropPath,[Drawing.Imaging.ImageFormat]::Png)
        $cropped.Dispose(); $image.Dispose()
        foreach ($setting in $settings) {
            $parse=Invoke-Parse $cropPath $setting
            $elements=@($parse.data.elements)
            $annotation=Join-Path $OutputDir ($fixture.id+'-'+$setting.id+'-annotated.png')
            Save-Annotation $cropPath $elements $annotation ($fixture.id+' '+$setting.id)
            $record=@{fixture=$fixture.id; setting=$setting; crop=$crop; note=$fixture.note;
              source=$source; phoneImage=$cropPath; annotatedImage=$annotation; requestMs=$parse.requestMs;
              speedMs=$parse.data.speed_ms; total=$parse.data.total; elements=$elements;
              labelCounts=@($elements | Group-Object label | ForEach-Object {@{label=$_.Name;count=$_.Count}});
              conversationAvatar=Measure-Regions $fixture.avatars $elements $crop @('Avatar');
              avatarOrImage=Measure-Regions $fixture.avatars $elements $crop @('Avatar','Image');
              unreadBadge=Measure-Regions $fixture.badges $elements $crop @('Badge');
              conversationRow=Measure-Regions $fixture.rows $elements $crop @('List Item')}
            $allResults.Add($record)
            [IO.File]::WriteAllText((Join-Path $OutputDir ($fixture.id+'-'+$setting.id+'.json')),
              ($record | ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false))
            Write-Output (@{fixture=$fixture.id;setting=$setting.id;total=$record.total;
              requestMs=$record.requestMs;speedMs=$record.speedMs;
              avatars=($record.conversationAvatar.hit.ToString()+'/'+$record.conversationAvatar.expected);
              avatarOrImage=($record.avatarOrImage.hit.ToString()+'/'+$record.avatarOrImage.expected);
              badges=($record.unreadBadge.hit.ToString()+'/'+$record.unreadBadge.expected);
              rows=($record.conversationRow.hit.ToString()+'/'+$record.conversationRow.expected)} | ConvertTo-Json -Depth 5 -Compress)
        }
    }
    # Warm service timings on a real screenshot; no reload, no external upload.
    $warm=[Collections.Generic.List[object]]::new()
    foreach ($iteration in 1..5) {
        $parse=Invoke-Parse (Join-Path $OutputDir '01-top-phone.png') $settings[0]
        $warm.Add(@{iteration=$iteration;requestMs=$parse.requestMs;speedMs=$parse.data.speed_ms})
    }
    $summary=@{endpoint=$Endpoint;health=$health;fixtures=$fixtures;settings=$settings;
      metricDefinition='Manually marked visible regions, one-to-one matching, IoU >= 0.5; no OCR; no phone actions';
      results=$allResults.ToArray();warmTimings=$warm.ToArray();outputDir=$OutputDir}
    [IO.File]::WriteAllText((Join-Path $OutputDir 'results.json'),($summary | ConvertTo-Json -Depth 60),[Text.UTF8Encoding]::new($false))
    $sheet=[Drawing.Bitmap]::new(824,1496)
    $canvas=[Drawing.Graphics]::FromImage($sheet)
    $canvas.Clear([Drawing.Color]::White)
    $titleFont=[Drawing.Font]::new('Arial',12)
    for ($index=0;$index -lt $fixtures.Count;$index++) {
        $x=10+($index%2)*407; $y=10+[Math]::Floor($index/2)*748
        $canvas.DrawString($fixtures[$index].id+' / default',$titleFont,[Drawing.Brushes]::Black,[float]$x,[float]$y)
        $preview=[Drawing.Image]::FromFile((Join-Path $OutputDir ($fixtures[$index].id+'-default-annotated.png')))
        $canvas.DrawImageUnscaled($preview,[int]$x,[int]($y+25)); $preview.Dispose()
    }
    $sheet.Save((Join-Path $OutputDir 'overview-default.png'),[Drawing.Imaging.ImageFormat]::Png)
    $titleFont.Dispose(); $canvas.Dispose(); $sheet.Dispose()
    Write-Output (@{outputDir=$OutputDir;warmTimings=$warm.ToArray()} | ConvertTo-Json -Depth 5 -Compress)
} finally { $http.Dispose() }
