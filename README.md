# MyNote 📝

개인용 스마트 메모 앱. 카테고리·태그(복수 선택 지원)로 분류하고, 전문 키워드 검색 및 **Gemini AI 시맨틱(의미 기반) 검색·추론(RAG)**, 메모별 **4자리 PIN 잠금(Lock)**, 메모 간 링크(`[[제목]]`), 이미지·수식·동영상 임베드를 지원하는 1인용 PWA.

- **배포 주소**: https://2gateless.github.io/mynote/
- **사용자**: 2gateless@gmail.com 단일 계정 전용 (Google 로그인)

---

## ✨ 최근 주요 업데이트 (What's New)

기존 버전 대비 아래 4가지 핵심 기능이 새롭게 추가 및 고도화되었습니다.

### 1. 🤖 Gemini AI 시맨틱 검색 및 종합·추론 (RAG) (`src/services/ai.ts`)
- **메모 임베딩 자동 생성 (`text-embedding-004`)**:
  - 메모 신규 저장·수정 시 `제목 + 카테고리 + 태그 + 키워드 + 본문`을 결합하여 Google Gemini `text-embedding-004` 벡터 배열로 변환 후 Firestore `notes/{noteId}` 문서의 `embedding` 필드에 자동 저장합니다.
  - 기존에 작성해 둔 메모들도 **`⚙️ AI 설정 → 🔄 기존 메모 일괄 임베딩 생성`** 버튼 한 번으로 일괄 변환할 수 있습니다.
- **자연어 의미 검색 (코사인 유사도 Top 3~5 추출)**:
  - 검색창에 찾고자 하는 의미나 자연어 질문을 입력하고 **`✨ AI 의미 검색 · 추론`**을 실행하면, 질문 벡터와 메모 벡터 간 코사인 유사도(Cosine Similarity)를 계산해 연관도 높은 상위 3~5개 메모를 유사도 점수(`🎯 유사도 89%`)와 함께 즉시 추출합니다.
- **AI 종합 및 추론 답변 (Gemini Flash RAG)**:
  - 추출된 상위 메모들의 본문을 프롬프트 컨텍스트로 묶어 **Gemini Flash** 모델에 전달하고, 질문 의도에 맞춰 요약·비교·추론한 답변을 마크다운 카드로 보여줍니다.
  - 답변 내에 인용된 `[[메모 제목]]` 링크를 클릭하면 즉시 원본 메모 상세 화면으로 이동하며, **잠금(`locked: true`) 메모의 본문은 프라이버시 보호를 위해 AI 프롬프트 컨텍스트에서 자동 제외**됩니다.
- **🔥 Firestore 읽기 비용 극대화 절감 설계 (Zero-Scan Local Vector Cache)**:
  - 전체 문서를 매번 Firestore에서 반복 조회하지 않도록 브라우저 **`IndexedDB`(`mynote_ai_vector_cache_db`)에 벡터와 본문을 영구 캐싱**합니다.
  - 카테고리 인덱스의 경량 타임스탬프(`embeddingUpdatedAt`)와 비교하여 **변경된 메모가 없으면 Firestore 읽기 0건**, 다른 기기에서 수정된 메모가 있으면 **해당 메모만 증분 단건 조회(Delta Sync)**합니다.
  - RAG 본문 역시 상위 3~5개 일치 문서 중 로컬에 전문이 없는 문서만 최소한으로 단건 조회 후 영구 캐싱합니다.
- **🔒 안전한 API 키 관리 및 기기 간 자동 동기화**:
  - 공개 GitHub 저장소에 API 키가 절대 노출되지 않도록 소스 코드에는 키를 일절 포함하지 않습니다.
  - 앱 내 `⚙️ AI 설정`에서 한 번만 API 키를 입력하면 기기 `localStorage`와 본인 전용 비공개 Firestore 문서(`user_meta/{uid}`)에 안전하게 저장되어, **PC에서 1회 입력 시 휴대폰 등 다른 기기에서도 재입력 없이 자동 동기화**됩니다.

### 2. 🔒 메모별 4자리 숫자 잠금 (PIN Lock) (`src/ui/pinModal.ts`)
- 메모 작성·수정 화면에서 **Lock 토글(`🔓 해제` / `🔒 잠금됨`)**을 통해 특정 메모를 개별 잠금 설정할 수 있습니다.
- 잠긴 메모는 목록 및 검색 결과에서 `🔒` 아이콘과 함께 본문 미리보기가 `🔒 잠긴 메모입니다`로 보호되며, 열람 시 4자리 숫자 암호가 일치해야만 열립니다.
- 4자리 암호는 각 기기(PC·휴대폰)에서 앱 최초 실행 시 **1회 입력 + 1회 확인(컨펌)**을 거쳐 해당 기기의 `localStorage`(`mynote_lock_pin`)에만 독립적으로 저장됩니다.

### 3. 📂 카테고리(폴더) 및 #태그 복수 선택 지원
- **복수 카테고리 지정 (`categories: string[]`)**:
  - 메모 작성·수정 시 드롭다운 멀티셀렉트 패널을 통해 **여러 개의 카테고리 폴더를 동시에 선택**할 수 있습니다.
  - 선택된 모든 카테고리의 샤드 인덱스(`note_index/{uid}_{category}`)와 카테고리별 카운트(`user_meta`)가 단일 트랜잭션으로 원자적 갱신되며, 기존 단일 `category` 메모와도 100% 호환됩니다.
- **복수 태그 지정 (`tags: string[]`)**:
  - 선택된 카테고리들에 속한 서브 태그들을 **체크박스 방식으로 여러 개 동시 선택·해제**할 수 있습니다.
  - 목록·상세·검색 화면에서 복수 태그 배지가 모두 표시되며, 어느 태그 배지를 클릭하더라도 해당 태그가 속한 카테고리 필터 화면으로 정확히 이동합니다.

### 4. 🛠️ 작성/수정 모달 하단 툴바 1줄 컴팩트 UI
- 메모 작성·수정 창 하단의 **`📝 메모링크`**, **`🔒 Lock`**, **`📌 핀고정`** 3가지 설정 버튼을 한 줄(3열 그리드)에 컴팩트하게 배치하여 모바일 터치와 PC 마우스 클릭 모두에서 스크롤 없이 한눈에 조작할 수 있도록 개선했습니다.

---

## 기술 구성

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 | Vanilla TypeScript + Vite (프레임워크 없음, 벤더 청크 분할 적용) |
| 데이터 | Firebase Firestore (`mynote-53a33`, `persistentLocalCache` 다중 탭 오프라인 캐시 적용) |
| AI 검색 / RAG | Google Gemini API (`text-embedding-004` 임베딩 + `Gemini Flash` 종합·추론) |
| 로컬 캐시 | `localStorage` (인증·카운트·검색 인덱스·잠금 PIN) + `IndexedDB` (`mynote_ai_vector_cache_db` 영구 벡터·본문 캐시) |
| 이미지 저장 | Firebase Storage (`notes/{uid}/` 경로, 최대 2560px / 품질 0.88 압축, 1.5MB 이하 및 GIF 원본 유지) |
| 인증 | Firebase Auth — Google 로그인 |
| 본문 렌더링 | `marked`(마크다운) + `DOMPurify`(XSS 방지) + `KaTeX`(수식) — 모두 동적 지연 로딩(Lazy Loading) |
| 배포 | GitHub Actions → GitHub Pages (`main` 브랜치 push 시 자동) |

---

## 폴더 구조

```
├── index.html              # 전체 화면 마크업 (로그인/홈/목록/상세/작성·수정/PIN 잠금/AI 설정 모달/이미지 뷰어)
├── public/                 # 빌드 시 가공 없이 그대로 복사되는 정적 파일
│   ├── manifest.json       # PWA 설정 (start_url, scope = /mynote/)
│   └── icon-*.png          # 앱 아이콘
├── src/
│   ├── main.ts             # 앱 본체 — 화면 전환, 이벤트, 키워드·AI 시맨틱 검색, 복수 카테고리·태그, 저장/삭제 흐름
│   ├── state.ts            # 전역 상태 (appState) 및 검색/제목 인덱스 캐시
│   ├── pwa.ts              # 화면 전환 + 브라우저 뒤로가기(popstate) 처리
│   ├── style.css           # 전체 스타일시트 (컴팩트 툴바, 멀티셀렉트, PIN 패드, AI RAG 카드 포함)
│   ├── types/
│   │   └── index.ts        # TypeScript 타입 정의 (Note, NoteIndexItem, UserMeta)
│   ├── services/
│   │   ├── firebase.ts     # Firebase 초기화 (Firestore 로컬 캐시 및 Storage 타임아웃 설정)
│   │   ├── auth.ts         # Google 로그인, 허용 이메일 검사
│   │   ├── database.ts     # Firestore CRUD 트랜잭션(복수 카테고리·태그 지원), 샤드 인덱스 구독
│   │   └── ai.ts           # Gemini 임베딩 생성, 코사인 유사도 검색, RAG 추론, IndexedDB 벡터 캐시 및 증분 동기화
│   ├── ui/
│   │   ├── imageViewer.ts  # 이미지 뷰어 (더블클릭/더블탭 2배 확대, 휠 줌, 드래그 이동, 다운로드)
│   │   └── pinModal.ts     # 4자리 숫자 PIN 초기 설정·컨펌 및 잠금 메모 열람 인증 모달
│   └── utils/
│       ├── formatter.ts    # 마크다운/수식/동영상 임베드/[[메모 링크]] 렌더링
│       ├── image.ts        # 고해상도 이미지 압축·메모리(Uint8Array) 업로드·삭제 (Storage)
│       ├── share.ts        # 네이티브/카카오톡/이메일/텔레그램 공유
│       └── toast.ts        # 토스트 알림 표시
└── backups/                # 로컬 백업 스크립트 (배포와 무관)
```

---

## 데이터 구조 (Firestore & Local Storage)

- `notes/{noteId}` — 메모 본문 전체
  - 필드: `uid, title, body, category, categories[], tag, tags[], images[], keywords, pinned, pinnedAt, locked, embedding[], embeddingUpdatedAt, createdAt, updatedAt`
- `user_meta/{uid}` — 홈 화면용 카테고리별 메모 개수 (`categoryCount`) 및 계정 동기화된 AI 설정 (`geminiApiKey`, `aiProxyUrl`)
- `note_index/{uid}_{category}` — **카테고리별 분할(Sharding) 인덱스 (총 9개 문서)**
  - 기존 단일 문서(`note_index/{uid}`)의 1MB 제한을 해결하기 위해 카테고리별로 분할됨.
  - 각 항목은 `id, title, category, categories[], tag, tags[], snippet(200자), keywords, createdAt, pinned, pinnedAt, locked, embeddingUpdatedAt`을 포함하며, 무거운 `embedding` 벡터 배열은 인덱스에 넣지 않아 1MB 제한을 안전하게 유지함.
  - 복수 카테고리가 지정된 메모는 선택된 모든 카테고리 인덱스 문서에 단일 트랜잭션으로 동시 반영되며, 전체 구독(`subscribeAllNotes`) 시 메모 ID 기준으로 자동 중복 제거 및 병합됨.

---

## 주요 기능 및 최적화

- **즉시 부팅 & 즉시 검색 (Optimistic UI)**: `localStorage`에 인증 상태, 카테고리 카운트, 전체 검색 인덱스를 캐싱하여 앱 실행 직후 네트워크 대기 없이 홈 화면 표시, 즉시 검색, 카테고리 목록 진입이 가능하다.
- **초저비용 AI 시맨틱 검색 & RAG**: `IndexedDB` 로컬 영구 벡터 캐시와 `embeddingUpdatedAt` 기반 증분 동기화(Delta Sync)를 결합해 반복 AI 검색 시 Firestore 읽기 비용을 0건으로 억제하고, 상위 3~5개 매칭 메모에 한해서만 조건부 본문 단건 조회를 수행한다.
- **고해상도 이미지 & 전용 뷰어**: 문서·텍스트 이미지의 가독성을 위해 최대 2560px(품질 0.88, PNG는 WebP 우선)로 압축하며, 클릭 시 뷰어 열기, 더블클릭(모바일 더블탭) 시 즉시 2배 확대, 마우스 휠 줌(최대 5배) 및 드래그 패닝을 지원한다.
- **업로드 안정성 & 고아 이미지 자동 정리**: 모바일/웹뷰 파일 핸들 만료 방지를 위해 즉시 메모리 버퍼(`Uint8Array`)로 복사 후 업로드하며, 메모 삭제·수정 시 제거된 이미지와 작성 취소된 인라인 이미지를 Storage에서 자동 삭제한다.

---

## 보안

- 보안의 실체는 **Firebase 콘솔의 규칙**이다. 코드의 `ALLOWED_EMAILS`는 화면 제어일 뿐.
- Firestore·Storage 규칙 모두 ① `2gateless@gmail.com` 이메일 확인 + ② 본인 `uid` 일치, 이중 잠금 적용됨.
- Gemini API 키는 리포지토리 코드에 절대 저장되지 않으며, 인증된 본인의 `user_meta/{uid}` 문서 및 기기 `localStorage`에만 보관됨.

---

## 배포

`main` 브랜치에 커밋·푸시하면 `.github/workflows/deploy.yml`이 자동으로 빌드·배포한다 (약 1~2분, Actions 탭에서 확인).

- Vite 빌드 시 `public/` 폴더 파일은 이름 그대로 `dist` 루트에 복사된다. **manifest·아이콘은 반드시 `public/`에 두어야 PWA가 깨지지 않는다**.
- 경로 기준은 `vite.config.js`의 `base: '/mynote/'`.

---

## 로컬 백업

Firestore 전체(`notes`, `user_meta`, `note_index`)를 JSON으로 내려받는 관리자 스크립트. 보안 규칙과 무관하게 작동한다 (서비스 계정 권한).

1. Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성
2. 받은 파일을 `backups/serviceAccountKey.json`으로 저장 (`.gitignore`에 등록되어 있어 커밋되지 않음 — **절대 커밋 금지**)
3. `backups/backup.bat` (또는 `npx tsx backup.ts`) 실행 → `backup_YYYY-MM-DD.json` 생성

---

## 유지보수 메모

- **카테고리·태그 정의**: `src/services/database.ts`의 `CATEGORIES`(9개 카테고리) / `SUB_TAGS`에서 수정.
- **인덱스 자동 보정**: 구버전 인덱스 항목에 날짜 등이 누락되었거나 카운트가 맞지 않을 경우, 목록 진입 시 `rebuildCategoryIndex()`가 세션당 카테고리별 1회 자동으로 재구성한다.
- **마이그레이션**: `database.ts`의 `migrateCategories()` / `migrateNotesToMeta()` / `migrateNoteIndexToShards()`는 모두 완료되어 호출하지 않음 (기록 보존용).
- **오프라인 지원**: Firestore `persistentLocalCache` 및 `IndexedDB` 벡터 캐시가 적용되어 데이터 캐시는 오프라인에서 유지됨.
