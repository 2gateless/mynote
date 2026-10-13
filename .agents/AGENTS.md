# MyNote 프로젝트 AI 행동 규칙

## 백업 요청 처리 규칙

사용자가 "백업", "backup", "메모 백업", "데이터 백업" 등 백업과 관련된 요청을 할 경우:

1. **절대로 소스 코드를 수정하거나 새 파일을 생성하지 마세요.**
2. **절대로 백업 관련 코드를 `src/main.ts` 또는 다른 앱 소스 파일에 추가하지 마세요.**
3. 대신 아래 명령어를 실행하여 백업을 수행하세요:

```
cmd /c "cd /d C:\Users\Admin\Documents\database\mynote\backups && npx tsx backup.ts"
```

4. 백업 전에 `serviceAccountKey.json`이 `backups` 폴더에 있는지 확인하세요.
   - 없다면 사용자에게 Firebase Console에서 발급받아 `backups` 폴더에 저장하도록 안내하세요.
   - 자세한 안내는 `backups/README.md` 참조.
5. 백업 결과(성공/실패)를 사용자에게 알려주세요.

> 이 규칙은 과거에 AI가 백업 요청을 잘못 처리하여 소스 코드를 무단 수정하고 중요 파일을 삭제하는 사고가 발생했기 때문에 만들어졌습니다.
