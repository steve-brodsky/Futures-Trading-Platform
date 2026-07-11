$ErrorActionPreference = 'Stop'

$vcvars = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio\*\BuildTools\VC\Auxiliary\Build\vcvars64.bat' |
  Sort-Object FullName -Descending |
  Select-Object -First 1
$sdk = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Lib' -Directory |
  Sort-Object Name -Descending |
  Select-Object -First 1

if (-not $vcvars) { throw 'Visual Studio C++ Build Tools vcvars64.bat was not found.' }
if (-not $sdk) { throw 'Windows 10/11 SDK libraries were not found.' }

$sdkRoot = Split-Path $sdk.FullName -Parent
$sdkVersion = $sdk.Name
$umLib = Join-Path $sdk.FullName 'um\x64'
$includeRoot = Join-Path (Split-Path $sdkRoot -Parent) "Include\$sdkVersion"
$extraIncludes = @('shared', 'um', 'winrt', 'cppwinrt') |
  ForEach-Object { Join-Path $includeRoot $_ } |
  Where-Object { Test-Path $_ }

$includeSuffix = $extraIncludes -join ';'
$command = 'call "{0}" >nul && set "LIB=!LIB!;{1}" && set "INCLUDE=!INCLUDE!;{2}" && npm run tauri dev' -f $vcvars.FullName, $umLib, $includeSuffix

cmd.exe /d /v:on /s /c $command
exit $LASTEXITCODE
