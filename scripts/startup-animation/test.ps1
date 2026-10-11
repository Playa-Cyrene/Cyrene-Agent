param([switch]$Slow,[switch]$Skip,[switch]$Custom,[switch]$Disabled,[switch]$Attach)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$qa=[IO.Path]::GetFullPath((Join-Path $project '.build-temp/startup-animation-qa'))
New-Item -ItemType Directory -Force $qa | Out-Null
& (Join-Path $PSScriptRoot 'build.ps1')
$target=Join-Path $qa 'CyreneSmokeTarget.exe'
& (Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe') /nologo /target:winexe /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "/out:$target" (Join-Path $PSScriptRoot 'SmokeTarget.cs')
if($LASTEXITCODE){throw 'Target compilation failed'}
Copy-Item (Join-Path $project 'resources/startup-animation/CyreneBoot.exe') $qa -Force
$cfg=Get-Content (Join-Path $PSScriptRoot 'test-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.Video=Join-Path $project 'resources/startup-animation/default.mp4'
$cfg.AppLaunch=$target
$cfg.AppArguments=if($Slow){'--delay=24000'}else{'--visibility-test'}
$cfg.WorkingDirectory=$qa
$cfg.ProcessNames=@('CyreneSmokeTarget')
$cfg.ProcessPathContains=$qa
$cfg.SharedSettingsPath=Join-Path $qa 'settings.json'
$cfg | Add-Member -NotePropertyName AttachOnly -NotePropertyValue ([bool]$Attach) -Force
$customName='12345678-1234-1234-1234-123456789012.mp4'
if($Custom){
 & ffmpeg -hide_banner -loglevel error -y -i (Join-Path $project 'resources/startup-animation/default.mp4') -t 5 -c copy (Join-Path $qa $customName)
 if($LASTEXITCODE){throw 'Could not prepare short custom video'}
}
[IO.File]::WriteAllText($cfg.SharedSettingsPath,(@{enabled=(-not $Disabled);videoFile=$(if($Custom){$customName}else{$null});videoName='Test video'}|ConvertTo-Json))
[IO.File]::WriteAllText((Join-Path $qa 'launcher.json'),($cfg|ConvertTo-Json -Depth 10))
$log=Join-Path $qa 'logs/launcher.log'
if(Test-Path $log){[IO.File]::WriteAllText($log,'')}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HandoffCheck {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref Point p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,int m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 public static int[] Client(IntPtr h) { Rect r;Point p=new Point();GetClientRect(h,out r);ClientToScreen(h,ref p);return new int[]{p.X,p.Y,r.R-r.L,r.B-r.T}; }
}
'@
$null=[HandoffCheck]::SetProcessDPIAware()
$watch=[Diagnostics.Stopwatch]::StartNew()
if($Attach){
 $info=New-Object Diagnostics.ProcessStartInfo
 $info.FileName=$target;$info.Arguments=$cfg.AppArguments;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $null=[Diagnostics.Process]::Start($info)
}
$proc=Start-Process (Join-Path $qa 'CyreneBoot.exe') -WindowStyle Hidden -PassThru
try {
 if($Skip){
  Start-Sleep -Seconds 4
  $messages=Get-Content $log -Raw
  if($messages -notmatch 'host-handle=(\d+)'){throw 'No animation window'}
  $null=[HandoffCheck]::PostMessage([IntPtr][long]$Matches[1],0x100,[IntPtr]27,[IntPtr]65537)
 }
 if(-not $proc.WaitForExit(45000)){throw 'Animation did not exit automatically'}
 $watch.Stop()
 if($Disabled){
  Start-Sleep -Seconds 3
  $app=Get-Process CyreneSmokeTarget | Where-Object {$_.Path -eq $target} | Select-Object -First 1
  $app.Refresh()
  $visible=[HandoffCheck]::IsWindowVisible($app.MainWindowHandle)
  $messages=if(Test-Path $log){[IO.File]::ReadAllText($log)}else{''}
  $ok=$proc.ExitCode -eq 0 -and $visible -and $watch.Elapsed.TotalSeconds -lt 5 -and -not $messages.Contains('media-opened')
  $report=@{ok=$ok;mode='disabled';visibleAfter=$visible;animationSkipped=(-not $messages.Contains('media-opened'));realAgentTested=$false}
  $report|ConvertTo-Json|Set-Content (Join-Path $qa 'handoff-disabled.json') -Encoding UTF8
  $report|ConvertTo-Json
  if(-not $ok){throw 'Disabled animation did not launch Agent directly'}
  return
 }
 $messages=Get-Content $log -Raw
 $app=Get-Process CyreneSmokeTarget | Where-Object {$_.Path -eq $target} | Select-Object -First 1
 $app.Refresh()
 $rect=[HandoffCheck]::Client($app.MainWindowHandle)
 if($messages -notmatch 'started fixed-player=(\d+)x(\d+) at (-?\d+),(-?\d+)'){throw 'Missing player dimensions'}
 $expected=@([int]$Matches[3],[int]$Matches[4],[int]$Matches[1],[int]$Matches[2])
 $aligned=$true
 for($i=0;$i -lt 4;$i++){if([Math]::Abs($rect[$i]-$expected[$i]) -gt 2){$aligned=$false}}
 $visible=[HandoffCheck]::IsWindowVisible($app.MainWindowHandle)
 $ok=$proc.ExitCode -eq 0 -and $aligned -and $visible -and $messages.Contains('handed-off-to-real-window')
 if($Skip){$ok=$ok -and $watch.Elapsed.TotalSeconds -lt 9}
 else{$ok=$ok -and $messages.Contains('frozen-at-final-frame') -and $watch.Elapsed.TotalSeconds -ge $(if($Custom){5}else{15})}
 if($Custom){$ok=$ok -and $watch.Elapsed.TotalSeconds -lt 12}
 if($Attach){$ok=$ok -and -not $messages.Contains('app-launch-requested')}
 if($Slow){$ok=$ok -and $messages.Contains('waiting-for-window')}
 elseif(-not $Skip -and -not $Custom){$ok=$ok -and ([IO.File]::ReadAllText((Join-Path $qa 'visibility.txt')).Contains('hidden-during-video'))}
 $mode=if($Attach){'attach'}elseif($Custom){'custom'}elseif($Skip){'skip'}elseif($Slow){'slow'}else{'full'}
 $report=[ordered]@{ok=$ok;mode=$mode;elapsedSeconds=[Math]::Round($watch.Elapsed.TotalSeconds,2);automaticExit=(-not $Skip);visibleAfter=$visible;clientBounds=$rect;expectedBounds=$expected;aligned=$aligned;realAgentTested=$false}
 $report|ConvertTo-Json|Set-Content (Join-Path $qa "handoff-$mode.json") -Encoding UTF8
 $report|ConvertTo-Json
 Write-Output $messages
 if(-not $ok){throw 'Handoff validation failed'}
} finally {
 if(-not $proc.HasExited){
  $messages=if(Test-Path $log){[IO.File]::ReadAllText($log)}else{''}
  if($messages -match 'host-handle=(\d+)'){$null=[HandoffCheck]::PostMessage([IntPtr][long]$Matches[1],0x10,[IntPtr]::Zero,[IntPtr]::Zero)}
  if(-not $proc.WaitForExit(3000)){$proc.Kill()}
 }
 Get-Process CyreneSmokeTarget -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $target} | ForEach-Object {
  $null=$_.CloseMainWindow();if(-not $_.WaitForExit(3000)){$_.Kill()}
 }
}
