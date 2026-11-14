@echo off
rem bside: drive B-Side from a terminal.
rem   bside                  open the control panel (starts the app if needed)
rem   bside <youtube link>   play that link (put it in double quotes if it has an & in it)
rem   bside off              open the video in your browser at the same second
rem   bside stop | quit      turn the wallpaper off | quit the app
rem   bside pause|play|next|prev|mute|louder|quieter|wallpaper|screensaver|resume
rem   bside status           what's playing, as JSON
rem   bside vol 50 | dim 30 | screens all|main | fill on|off
rem
rem Delayed expansion stays off for the whole file, so ! and ^ in a link survive. The arguments
rem are joined one at a time with %~1, so a quoted link with an & in it is not split.
setlocal DisableDelayedExpansion

rem B-Side writes the installed exe path on the next line when it copies this file onto the PATH.
set "EXE_ABS="

set "EXE="
if exist "%~dp0..\B-Side.exe" set "EXE=%~dp0..\B-Side.exe"
if not defined EXE if defined EXE_ABS if exist "%EXE_ABS%" set "EXE=%EXE_ABS%"
if not defined EXE if exist "%LOCALAPPDATA%\Programs\B-Side\B-Side.exe" set "EXE=%LOCALAPPDATA%\Programs\B-Side\B-Side.exe"
if not defined EXE for %%X in (B-Side.exe) do set "EXE=%%~$PATH:X"
if not defined EXE goto notinstalled

set "ARGS="
:collect
if "%~1"=="" goto collected
if defined ARGS goto append
set "ARGS=%~1"
goto next
:append
set "ARGS=%ARGS% %~1"
:next
shift
goto collect
:collected

if not defined ARGS set "ARGS=panel"
if /i "%ARGS%"=="status" goto status
"%EXE%" "--cmd=%ARGS%"
exit /b 0

:notinstalled
echo B-Side is not installed. Get it from https://bsideapp.netlify.app/ 1>&2
exit /b 1

:status
rem The running app writes status.json when it gets the status command. Wait for it.
set "F=%APPDATA%\B-Side\status.json"
del "%F%" >nul 2>&1
"%EXE%" "--cmd=status"
for /l %%i in (1,1,20) do (
  if exist "%F%" goto show
  ping -n 2 127.0.0.1 >nul
)
echo {"running": false}
exit /b 0

:show
type "%F%"
exit /b 0
