@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0internal\Lite.ps1" -Mode Launch
if errorlevel 1 pause
