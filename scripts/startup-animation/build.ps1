$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$output=Join-Path $repo 'resources/startup-animation/CyreneBoot.exe'
$framework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
if(-not (Test-Path (Join-Path $framework 'csc.exe'))){throw '.NET Framework 4.x x64 compiler is required'}
$references=@('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll','WPF/WindowsBase.dll','WPF/PresentationCore.dll','WPF/PresentationFramework.dll','System.Xaml.dll') | ForEach-Object { '/reference:'+(Join-Path $framework $_) }
& (Join-Path $framework 'csc.exe') /nologo /target:winexe /platform:x64 "/out:$output" "/win32icon:$(Join-Path $repo 'assets/tray-icon.ico')" @references (Join-Path $PSScriptRoot 'CyreneBoot.cs')
if($LASTEXITCODE -ne 0){throw 'Startup animation build failed'}
Write-Output $output
