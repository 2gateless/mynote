# MyNote 📝

개인용 스마트 메모 앱. 카테고리·태그로 분류하고, 전문 검색과 이미지·수식·동영상 임베드를 지원하는 1인용 PWA.

- **배포 주소**: https://2gateless.github.io/mynote/
- **사용자**: 2gateless@gmail.com 단일 계정 전용 (Google 로그인)

## 기술 구성

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 | Vanilla TypeScript + Vite (프레임워크 없음) |
| 데이터 | Firebase Firestore (프로젝트: `mynote-53a33`) |
| 이미지 저장 | Firebase Storage (`notes/{uid}/` 경로, 800px/품질 0.6으로 압축 업로드) |
| 인증 | Firebase Auth — Google 로그인 |
| 본문 렌더링 | marked(마크다운) + DOMPurify(XSS 방지) + KaTeX(수식, 지연 로딩) |
| 배포 | GitHub Actions → GitHub Pages (main 브랜치 push 시 자동) |

## 폴더 구조

```
├── index.html              # 전체 화면 마크업 (로그인/홈/목록/상세/모달)
├── public/                 # 빌드 시 가공 없이 그대로 복사되는 파일들
│   ├── manifest.json       # PWA 설정 (start_url, scope = /mynote/)
│   └── icon-*.png          # 앱 아이콘
├── src/
│   ├── main.ts             # 앱 본체 — 화면 전환, 이벤트, 저장/삭제 흐름
│   ├── state.ts            # 전역 상태 (appState)
│   ├── pwa.ts              # 화면 전환 + 뒤로가기 처리
│   ├── services/
│   │   ├── firebase.ts     # Firebase 초기화 (설정값은 공개되어도 정상 — 보안은 규칙이 담당)
│   │   ├── auth.ts         # Google 로그인, 허용 이메일 검사
│   │   └── database.ts     # Firestore 읽기/쓰기, 카테고리·태그 정의, 메타 동기화
│   └── utils/
│       ├── formatter.ts    # 마크다운/수식/동영상 임베드 렌더링
│       ├── image.ts        # 이미지 압축·업로드·삭제 (Storage)
│       └── share.ts        # 카카오톡/이메일/텔레그램 공유
└── backups/                # 로컬 백업 스크립트 (배포와 무관)
```

## 데이터 구조 (Firestore)

- `notes/{noteId}` — 메모 본문. `uid, title, body, category, tag, images[], keywords, pinned, createdAt`
- `user_meta/{uid}` — 홈 화면용 카테고리별 개수
- `note_index/{uid}` — 검색용 인덱스 (제목 + 200자 스니펫). **단일 문서라 1MB 제한 있음 — 메모가 1,500~2,000개에 이르면 스니펫 축소 또는 분할 필요**

메모 저장·수정·삭제 시 `syncNoteMeta()`가 트랜잭션으로 메타/인덱스를 함께 갱신한다.

## 보안 (2026-07 점검 완료)

- 보안의 실체는 **Firebase 콘솔의 규칙**이다. 코드의 `ALLOWED_EMAILS`는 화면 제어일 뿐.
- Firestore·Storage 규칙 모두 ① `2gateless@gmail.com` 이메일 확인 + ② 본인 uid 일치, 이중 잠금 적용됨.
- 규칙은 콘솔 → Firestore/Storage → 규칙 탭에서 관리 (리포지토리에 저장되지 않음).
- 새 컬렉션이나 Storage 경로를 코드에 추가하면 **규칙에도 반드시 추가**해야 작동한다 (미등록 경로는 자동 차단).

## 배포

main 브랜치에 커밋하면 `.github/workflows/deploy.yml`이 자동으로 빌드·배포한다 (약 1~2분, Actions 탭에서 확인).

- Vite 빌드 시 `public/` 폴더 파일은 이름 그대로 `dist` 루트에 복사된다. **manifest·아이콘은 반드시 `public/`에 두어야 PWA가 깨지지 않는다** (루트에 두면 해시가 붙거나 누락됨 — 2026-07에 겪은 버그).
- 경로 기준은 `vite.config.js`의 `base: '/mynote/'`.

## 로컬 백업

Firestore 전체를 JSON으로 내려받는 관리자 스크립트. 보안 규칙과 무관하게 작동한다 (서비스 계정 권한).

1. Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성
2. 받은 파일을 `backups/serviceAccountKey.json`으로 저장 (`.gitignore`에 등록되어 있어 커밋되지 않음 — **절대 커밋 금지**)
3. `backups/backup.bat` 실행 → `backup_YYYY-MM-DD.json` 생성

## 유지보수 메모

- **마이그레이션**: `main.ts`의 `migrateCategories()` / `migrateNotesToMeta()`는 완료되어 주석 처리됨 (2026-07). 카테고리 체계를 바꿀 때만 `//`를 지워 1회 실행 후 다시 주석 처리할 것.
- **이미지 정리**: 메모 삭제·수정 시 첨부/인라인 이미지가 Storage에서 자동 삭제됨 (2026-07 추가). 그 이전에 삭제한 메모의 고아 파일은 남아 있을 수 있음.
- **카테고리·태그 정의**: `src/services/database.ts`의 `CATEGORIES` / `SUB_TAGS`에서 수정.
- **미해결 과제**: 서비스 워커 없음 → 오프라인에서 앱이 열리지 않음. 개선 시 `vite-plugin-pwa` + Firestore `persistentLocalCache` 검토.
