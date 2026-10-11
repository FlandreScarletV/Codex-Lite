[CmdletBinding()]
param([ValidateSet('Install','Launch')][string]$Mode='Launch',[string]$StateRoot,[string]$WorkHome,[string]$InstallRoot)
$ErrorActionPreference='Stop'
$package=Split-Path $PSScriptRoot
if(-not $StateRoot){$StateRoot=Join-Path $package 'data'}
$StateRoot=[IO.Path]::GetFullPath($StateRoot)
if([IO.Path]::GetPathRoot($StateRoot).TrimEnd('\') -ieq $env:SystemDrive){throw '副本运行目录不能放在系统盘，请用 -StateRoot 指定非系统盘目录。'}
$record=Join-Path $StateRoot 'current.json'
$current=if(Test-Path -LiteralPath $record){Get-Content -LiteralPath $record -Raw|ConvertFrom-Json}else{$null}
if(-not $WorkHome -and $current){$WorkHome=$current.workHome}
if(-not $WorkHome){$WorkHome=$env:CODEX_HOME}
if(-not $WorkHome){$WorkHome=[Environment]::GetEnvironmentVariable('CODEX_HOME','User')}
if($WorkHome -and (Test-Path -LiteralPath (Join-Path $WorkHome 'sessions'))){
    $sessions=Get-Item -LiteralPath (Join-Path $WorkHome 'sessions') -Force
    if($sessions.LinkType -eq 'Junction'){$WorkHome=Split-Path ([string]$sessions.Target)}
}
if(-not $WorkHome){$WorkHome=Read-Host '请输入主 App 的 CODEX_HOME 目录'}
$WorkHome=[IO.Path]::GetFullPath($WorkHome).TrimEnd('\')
if(-not(Test-Path -LiteralPath (Join-Path $WorkHome 'config.toml'))){throw '主配置目录无效，未创建空环境。'}
if($WorkHome -eq $StateRoot -or $WorkHome.StartsWith($StateRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw '主配置目录必须位于副本数据目录之外。'}
$node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source
if(-not $node -and $env:XDG_CACHE_HOME){$node=Join-Path $env:XDG_CACHE_HOME 'codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'}
if(-not $node -or -not(Test-Path -LiteralPath $node)){throw '请安装 Node.js 或配置 XDG_CACHE_HOME 中的运行时。'}
$null=New-Item -ItemType Directory -Force -Path $StateRoot
if($Mode -eq 'Install'){
    if(-not $InstallRoot){$pkg=Get-AppxPackage OpenAI.Codex|Sort-Object Version -Descending|Select-Object -First 1;if(-not $pkg){throw '未发现官方 App，请指定 -InstallRoot。'};$InstallRoot=Join-Path $pkg.InstallLocation 'app'}
    $source=Join-Path $InstallRoot 'resources/app.asar'
    $stage=Join-Path $StateRoot ('runtimes/'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Force -Path $stage
    & robocopy $InstallRoot $stage /E /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
    if($LASTEXITCODE -ge 8){throw '复制失败；原副本记录保留。'}
    $asar=Join-Path $stage 'resources/app.asar'
    if((Get-FileHash $source).Hash -ne (Get-FileHash $asar).Hash){throw '安装过程中官方资源发生变化，停止准备。'}
    $original=Join-Path $stage 'resources/app.original.asar'
    Move-Item -LiteralPath $asar -Destination $original
    & $node (Join-Path $PSScriptRoot 'patch-lite.mjs') $original $asar (Join-Path $stage 'ChatGPT.exe')
    if($LASTEXITCODE -ne 0){throw '独立桌面补丁不兼容，现有副本保留。'}
    $current=@{runtime=$stage;workHome=$WorkHome;asarHash=(Get-FileHash $asar).Hash;exeHash=(Get-FileHash (Join-Path $stage 'ChatGPT.exe')).Hash}
    if(Test-Path $record){Copy-Item -LiteralPath $record -Destination ($record+'.previous') -Force}
    $current|ConvertTo-Json|Set-Content -LiteralPath ($record+'.tmp') -Encoding UTF8
    Move-Item -LiteralPath ($record+'.tmp') -Destination $record -Force
    Write-Output ('简易副本准备完成：'+$stage)
    return
}
if(-not $current){throw '请先运行安装.cmd。'}
$runtime=[IO.Path]::GetFullPath($current.runtime)
if(-not $runtime.StartsWith((Join-Path $StateRoot 'runtimes')+'\',[StringComparison]::OrdinalIgnoreCase)){throw '副本记录超出安装目录。'}
$exe=Join-Path $runtime 'ChatGPT.exe'
if((Get-FileHash (Join-Path $runtime 'resources/app.asar')).Hash -ne $current.asarHash -or (Get-FileHash $exe).Hash -ne $current.exeHash){throw '副本文件已变化，请重新安装。'}
if(Get-Process ChatGPT -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq $exe}){Write-Output '简易副本已运行。';return}
$private=Join-Path $StateRoot 'account-home'
$profile=Join-Path $StateRoot 'profile'
$null=New-Item -ItemType Directory -Force -Path $private,$profile
if((Get-Item $private).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '独立账号目录不能是链接。'}
foreach($name in @('sessions','archived_sessions','skills','plugins/cache')){
    $from=Join-Path $WorkHome $name;$to=Join-Path $private $name
    if(-not(Test-Path -LiteralPath $from -PathType Container)){continue}
    if(Test-Path -LiteralPath $to){$item=Get-Item -LiteralPath $to -Force;if($item.LinkType -ne 'Junction' -or [string]$item.Target -ne $from){throw ('已有目录不匹配，停止同步：'+$to)}}
    else{$null=New-Item -ItemType Directory -Force -Path (Split-Path $to);$null=New-Item -ItemType Junction -Path $to -Target $from}
}
$config=Join-Path $private 'config.toml'
$text=Get-Content -LiteralPath (Join-Path $WorkHome 'config.toml') -Raw
# Remove only the root authentication setting; retain all other TOML verbatim.
$heading=[regex]::Match($text,'(?m)^\s*\[')
$rootEnd=if($heading.Success){$heading.Index}else{$text.Length}
$head=$text.Substring(0,$rootEnd) -replace '(?m)^cli_auth_credentials_store\s*=.*(?:\r?\n|$)',''
$text='cli_auth_credentials_store = "file"'+[Environment]::NewLine+$head+$text.Substring($rootEnd)
if(-not(Test-Path $config) -or (Get-Content $config -Raw) -cne $text){
    if(Test-Path $config){Copy-Item -LiteralPath $config -Destination ($config+'.previous') -Force}
    [IO.File]::WriteAllText($config,$text,[Text.UTF8Encoding]::new($false))
}
foreach($name in @('session_index.jsonl','.codex-global-state.json')){
    $from=Join-Path $WorkHome $name
    if(Test-Path -LiteralPath $from){Copy-Item -LiteralPath $from -Destination (Join-Path $private $name) -Force}
}
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=$exe;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.Arguments='--user-data-dir="'+$profile+'"'
$info.EnvironmentVariables['CODEX_ELECTRON_USER_DATA_PATH']=$profile
$info.EnvironmentVariables['CODEX_HOME']=$private
$info.EnvironmentVariables['CODEX_SQLITE_HOME']=$WorkHome
$info.EnvironmentVariables['CODEX_CLI_PATH']=Join-Path $runtime 'resources/codex.exe'
foreach($name in @('GPTWIDGET_OBSERVER_URL','GPTWIDGET_CHAT_OBSERVER','CMI_EXIT_ON_CLOSE')){$info.EnvironmentVariables.Remove($name)}
$process=[Diagnostics.Process]::Start($info)
if($process.WaitForExit(5000) -and $process.ExitCode -ne 0){throw ('副本启动失败，退出码：'+$process.ExitCode)}
Write-Output ('简易副本已启动，PID '+$process.Id+'。首次请登录另一个账号。')
