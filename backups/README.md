# MyNote Firestore 백업 안내

## ✅ 백업하는 방법 (매우 간단)

**`backup.bat` 파일을 더블클릭하면 끝입니다.**

백업 완료 후 이 폴더 안에 `backup_YYYY-MM-DD.json` 파일이 생성됩니다.

---

## ⚠️ 절대 하면 안 되는 것

**AI(Antigravity 등)에게 백업을 요청하지 마세요.**

AI에게 백업을 맡기면 다음과 같은 심각한 문제가 발생했습니다:
- 앱 소스 코드(`src/main.ts`, `src/services/firebase.ts`)가 무단으로 수정됨
- 불필요한 파일들이 여러 곳에 생성됨
- 중요한 기존 백업 파일이 삭제되는 사고 발생

백업은 반드시 **직접 배치파일을 실행**하는 방식으로만 하세요.

---

## 📋 사전 준비 (최초 1회 또는 키 재발급 시)

`serviceAccountKey.json` 파일이 이 폴더(`backups`)에 있어야 합니다.

없다면:
1. [Firebase Console](https://console.firebase.google.com) 접속
2. 해당 프로젝트 선택
3. 왼쪽 ⚙️ **프로젝트 설정** → **서비스 계정** 탭
4. **"새 비공개 키 생성"** 클릭 → JSON 파일 다운로드
5. 다운로드된 파일을 이 폴더에 **`serviceAccountKey.json`** 이름으로 저장

> 이 파일은 보안상 git에 올라가지 않으며, PC에만 보관됩니다.

---

## 📁 백업 파일 구조

```json
{
  "backupDate": "2026-07-07T...",
  "notes": { ... },       // 메모 본문 전체
  "user_meta": { ... },   // 사용자 메타정보
  "note_index": { ... }   // 메모 인덱스
}
```

---

## 🔧 오류 발생 시

배치파일 실행 시 창이 바로 꺼지거나 오류가 나면:

- `serviceAccountKey.json` 파일이 이 폴더에 있는지 확인
- 오류 메시지 확인 방법: CMD 창을 직접 열고 아래 명령 실행
  ```
  cd /d C:\Users\Admin\Documents\database\mynote\backups
  npx tsx backup.ts
  ```
