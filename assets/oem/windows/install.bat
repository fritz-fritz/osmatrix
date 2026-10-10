@echo off
rem Executed by dockur at the end of unattended Windows setup (folder is copied to C:\OEM).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\OEM\provision.ps1 > C:\OEM\provision.log 2>&1
