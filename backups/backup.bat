@echo off
chcp 65001 >nul
echo =========================================
echo MyNote Firestore Local Backup Script
echo (용량 최적화: embedding 필드는 제외됩니다)
echo =========================================

cd /d "%~dp0"
npx tsx backup.ts

echo.
echo 작업이 완료되었습니다. 창을 닫아주세요.
pause
