# MyNote 📝

개인용 스마트 메모 앱. 카테고리·태그로 분류하고, 전문 검색과 메모 간 링크(`[[제목]]`), 이미지·수식·동영상 임베드를 지원하는 1인용 PWA.

- **배포 주소**: https://2gateless.github.io/mynote/
- **사용자**: 2gateless@gmail.com 단일 계정 전용 (Google 로그인)

## 기술 구성

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 | Vanilla TypeScript + Vite (프레임워크 없음, 벤더 청크 분할 적용) |
| 데이터 | Firebase Firestore (`mynote-53a33`, `persistentLocalCache` 다중 탭 오프라인 캐시 적용) |
| 로컬 캐시 | `localStorage` 낙관적 UI 캐시 (인증 상태·카운트·검색 인덱스 즉시 복원) |
| 이미지 저장 | Firebase Storage (`notes/{uid}/` 경로, 최대 2560px / 품질 0.88 압축, 1.5MB 이하 및 GIF 원본 유지) |
| 인증 | Firebase Auth — Google 로그인 |
| 본문 렌더링 | `marked`(마크다운) + `DOMPurify`(XSS 방지) + `KaTeX`(수식) — 모두 동적 지연 로딩(Lazy Loading) |
| 배포 | GitHub Actions → GitHub Pages (`main` 브랜치 push 시 자동) |

## 폴더 구조

```
├── index.html              # 전체 화면 마크업 (로그인/홈/목록/상세/모달/이미지 뷰어)
├── public/                 # 빌드 시 가공 없이 그대로 복사되는 정적 파일
│   ├── manifest.json       # PWA 설정 (start_url, scope = /mynote/)
│   └── icon-*.png          # 앱 아이콘
├── src/
│   ├── main.ts             # 앱 본체 — 화면 전환, 이벤트, 검색, 저장/삭제 흐름
│   ├── state.ts            # 전역 상태 (appState) 및 검색/제목 인덱스 캐시
│   ├── pwa.ts              # 화면 전환 + 브라우저 뒤로가기(popstate) 처리
│   ├── style.css           # 전체 스타일시트
│   ├── types/
│   │   └── index.ts        # TypeScript 타입 정의 (Note, NoteIndexItem, UserMeta)
│   ├── services/
│   │   ├── firebase.ts     # Firebase 초기화 (Firestore 로컬 캐시 및 Storage 타임아웃 설정)
│   │   ├── auth.ts         # Google 로그인, 허용 이메일 검사
│   │   └── database.ts     # Firestore CRUD 트랜잭션, 카테고리·태그 정의, 샤드 인덱스 구독
│   ├── ui/
│   │   └── imageViewer.ts  # 이미지 뷰어 (더블클릭/더블탭 2배 확대, 휠 줌, 드래그 이동, 다운로드)
│   └── utils/
│       ├── formatter.ts    # 마크다운/수식/동영상 임베드/[[메모 링크]] 렌더링
│       ├── image.ts        # 고해상도 이미지 압축·메모리(Uint8Array) 업로드·삭제 (Storage)
│       ├── share.ts        # 네이티브/카카오톡/이메일/텔레그램 공유
│       └── toast.ts        # 토스트 알림 표시
└── backups/                # 로컬 백업 스크립트 (배포와 무관)
```

## 데이터 구조 (Firestore)

- `notes/{noteId}` — 메모 본문 전체 (`uid, title, body, category, tag, images[], keywords, pinned, pinnedAt, createdAt, updatedAt`)
- `user_meta/{uid}` — 홈 화면용 카테고리별 메모 개수 (`categoryCount`)
- `note_index/{uid}_{category}` — **카테고리별 분할(Sharding) 인덱스 (총 9개 문서)**.
  - 기존 단일 문서(`note_index/{uid}`)의 1MB 제한을 해결하기 위해 카테고리별로 분할됨.
  - 각 항목은 `id, title, category, tag, snippet(200자), keywords, createdAt, pinned, pinnedAt`을 포함하며, **전문 검색**과 **카테고리별 목록 화면 렌더링**(본문 전체를 읽지 않음)에 함께 사용됨.

메모 생성·수정·삭제 시 `createNoteWithIndex()`, `updateNoteWithIndex()`, `deleteNoteWithIndex()`가 단일 트랜잭션으로 본문과 카테고리 인덱스, `user_meta` 카운트(`increment`)를 원자적으로 함께 갱신한다.

## 주요 기능 및 최적화

- **즉시 부팅 & 즉시 검색 (Optimistic UI)**: `localStorage`에 인증 상태, 카테고리 카운트, 전체 검색 인덱스를 캐싱하여 앱 실행 직후 네트워크 대기 없이 홈 화면 표시, 즉시 검색, 카테고리 목록 진입이 가능하다.
- **고해상도 이미지 & 전용 뷰어**: 문서·텍스트 이미지의 가독성을 위해 최대 2560px(품질 0.88, PNG는 WebP 우선)로 압축하며, 클릭 시 뷰어 열기, 더블클릭(모바일 더블탭) 시 즉시 2배 확대, 마우스 휠 줌(최대 5배) 및 드래그 패닝을 지원한다.
- **업로드 안정성**: 모바일/웹뷰에서 발생할 수 있는 파일 핸들 만료 및 Blob 스트림 멈춤 현상을 방지하기 위해 즉시 메모리 버퍼(`Uint8Array`)로 복사 후 타임아웃 관리 하에 업로드한다.
- **고아 이미지 자동 정리**: 메모 삭제·수정 시 제거된 첨부/인라인 이미지뿐만 아니라, 작성 중 업로드했다가 저장하지 않고 취소한 인라인 이미지까지 Storage에서 자동 삭제한다.

## 보안 (2026-07 점검 완료)

- 보안의 실체는 **Firebase 콘솔의 규칙**이다. 코드의 `ALLOWED_EMAILS`는 화면 제어일 뿐.
- Firestore·Storage 규칙 모두 ① `2gateless@gmail.com` 이메일 확인 + ② 본인 `uid` 일치, 이중 잠금 적용됨.
- 규칙은 콘솔 → Firestore/Storage → 규칙 탭에서 관리 (리포지토리에 저장되지 않음).
- 새 컬렉션이나 Storage 경로를 코드에 추가하면 **규칙에도 반드시 추가**해야 작동한다 (미등록 경로는 자동 차단).

## 배포

`main` 브랜치에 커밋·푸시하면 `.github/workflows/deploy.yml`이 자동으로 빌드·배포한다 (약 1~2분, Actions 탭에서 확인).

- Vite 빌드 시 `public/` 폴더 파일은 이름 그대로 `dist` 루트에 복사된다. **manifest·아이콘은 반드시 `public/`에 두어야 PWA가 깨지지 않는다**.
- 경로 기준은 `vite.config.js`의 `base: '/mynote/'`.

## 로컬 백업

Firestore 전체(`notes`, `user_meta`, `note_index`)를 JSON으로 내려받는 관리자 스크립트. 보안 규칙과 무관하게 작동한다 (서비스 계정 권한).

1. Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성
2. 받은 파일을 `backups/serviceAccountKey.json`으로 저장 (`.gitignore`에 등록되어 있어 커밋되지 않음 — **절대 커밋 금지**)
3. `backups/backup.bat` 실행 → `backup_YYYY-MM-DD.json` 생성

## 유지보수 메모

- **카테고리·태그 정의**: `src/services/database.ts`의 `CATEGORIES`(9개 카테고리) / `SUB_TAGS`에서 수정.
- **인덱스 자동 보정**: 구버전 인덱스 항목에 날짜 등이 누락되었거나 카운트가 맞지 않을 경우, 목록 진입 시 `rebuildCategoryIndex()`가 세션당 카테고리별 1회 자동으로 재구성한다.
- **마이그레이션**: `database.ts`의 `migrateCategories()` / `migrateNotesToMeta()` / `migrateNoteIndexToShards()`는 모두 완료되어 호출하지 않음 (기록 보존용).
- **오프라인 지원**: Firestore `persistentLocalCache`가 적용되어 데이터 캐시는 오프라인에서 유지됨. 앱 셸(HTML/JS)의 완전 오프라인 구동이 필요할 경우 `vite-plugin-pwa` 서비스 워커 도입 검토.
