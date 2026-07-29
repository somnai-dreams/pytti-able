@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

:: Enable ANSI escape codes (Windows 10+)
for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"

set "CYAN=%ESC%[96m"
set "GREEN=%ESC%[92m"
set "YELLOW=%ESC%[93m"
set "RED=%ESC%[91m"
set "DIM=%ESC%[90m"
set "BOLD=%ESC%[1m"
set "R=%ESC%[0m"

cls
echo.
echo  %CYAN%######  #   # ##### ##### ###%R%
echo  %CYAN%#    #  #  #    #     #    # %R%
echo  %CYAN%######   ##     #     #    # %R%
echo  %CYAN%#        #      #     #    # %R%
echo  %CYAN%#        #      #     #   ###%R%
echo.
echo %DIM%  Neural Image Synthesizer  %YELLOW%v1.0.0-beta%R%
echo.
echo %DIM%  ----------------------------------------%R%
echo.

if exist python\python.exe (
    echo %YELLOW%  Already installed.%R%
    echo %DIM%  Delete the python\ folder to reinstall.%R%
    echo.
    pause
    exit /b 0
)

:: Check git is available
git --version >nul 2>&1
if errorlevel 1 (
    echo %RED%  ERROR: git is not installed or not on PATH.%R%
    echo %DIM%  Install it from https://git-scm.com and try again.%R%
    echo.
    pause
    exit /b 1
)

:: ---------------------------------------------------------------------------
call :step 1 5 "Downloading Python 3.10.11"
powershell -Command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip' -OutFile 'python-embed.zip'"
if errorlevel 1 goto :error
call :ok

:: ---------------------------------------------------------------------------
call :step 2 5 "Extracting Python"
powershell -Command "Expand-Archive -Path 'python-embed.zip' -DestinationPath 'python' -Force"
if errorlevel 1 goto :error
del python-embed.zip
call :ok

:: ---------------------------------------------------------------------------
call :step 3 5 "Configuring Python"
(
  echo python310.zip
  echo .
  echo Lib\site-packages
  echo.
  echo import site
) > python\python310._pth
if errorlevel 1 goto :error
call :ok

:: ---------------------------------------------------------------------------
call :step 4 5 "Installing pip"
powershell -Command "Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile 'get-pip.py'"
if errorlevel 1 goto :error
python\python.exe get-pip.py
if errorlevel 1 goto :error
del get-pip.py
call :ok

:: ---------------------------------------------------------------------------
call :step 5 5 "Installing packages"
echo.
echo %DIM%       This will take 20-60 minutes.%R%
echo %DIM%       PyTorch alone is ~4GB - please be patient.%R%
echo.

echo %DIM%       [+] PyTorch + CUDA 11.7%R%
python\python.exe -m pip install --no-warn-script-location torch==2.0.0 torchvision==0.15.1 --index-url https://download.pytorch.org/whl/cu117
if errorlevel 1 goto :error

echo %DIM%       [+] pytti-core v2 (pulls CLIP + all render dependencies)%R%
python\python.exe -m pip install --no-warn-script-location "pyttitools-core[animation] @ git+https://github.com/somnai-dreams/pytti-core.git@v2"
if errorlevel 1 goto :error

echo %DIM%       [+] UI dependencies%R%
python\python.exe -m pip install --no-warn-script-location pyyaml
if errorlevel 1 goto :error

call :ok

:: ---------------------------------------------------------------------------
echo.
echo.
echo %GREEN%  ========================================%R%
echo %GREEN%  ^|                                      ^|%R%
echo %GREEN%  ^|       Installation complete!          ^|%R%
echo %GREEN%  ^|       Run launch.bat to start.        ^|%R%
echo %GREEN%  ^|                                      ^|%R%
echo %GREEN%  ========================================%R%
echo.
pause
exit /b 0

:: ---------------------------------------------------------------------------
:step
echo.
echo   %CYAN%[%~1/%~2]%R% %BOLD%%~3%R%
exit /b 0

:ok
echo   %GREEN%      done.%R%
exit /b 0

:error
echo.
echo %RED%  ========================================%R%
echo %RED%  ^|  ERROR: Something went wrong.        ^|%R%
echo %RED%  ^|  See above for details.               ^|%R%
echo %RED%  ^|                                      ^|%R%
echo %RED%  ^|  Copy the error and report it.        ^|%R%
echo %RED%  ========================================%R%
echo.
pause
exit /b 1
