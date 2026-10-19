@echo off
chcp 65001 >nul
title Publish dsh-conversation-trash to npm
echo.
echo   This will publish dsh-conversation-trash to npm.
echo   It needs an npm access token (npm_...).
echo.
echo   If you do not have one yet, the browser will open the token page:
echo     npmjs.com  ->  avatar  ->  Access Tokens  ->  Generate New Token
echo     ->  Classic  ->  Automation  ->  copy the token
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1"
echo.
echo   Exit code: %ERRORLEVEL%
pause
