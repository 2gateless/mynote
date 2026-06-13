@echo off
chcp 65001 >nul
echo =========================================
echo MyNote Firestore Local Backup Script
echo =========================================

cd /d "%~dp0"
npx tsx backup.ts

echo.
echo 작업이 완료되었습니다. 창을 닫아주세요.
pause
