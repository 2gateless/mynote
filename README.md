# 📒 MyNote — 클라우드 동기화 & 하이브리드 AI 세컨드 브레인

**MyNote**는 빠르고 직관적인 마크다운 메모 관리와 **Google Firebase 실시간 동기화**, 그리고 **Google Gemini 기반 의미론적 벡터 검색(Semantic Search) 및 RAG(검색 증강 생성) 추론**을 결합한 개인 지식 관리(PKM) 웹 애플리케이션(PWA)입니다.

---

## 🚀 최근 주요 업데이트 (What's New)

### 1. 🌐 Modern Web 플랫폼 표준 전면 적용 (`<dialog>`, `Popover`, `View Transitions`, A11y, INP)
- **네이티브 Top Layer 모달 & 팝오버 아키텍처**:
  - 모든 모달과 이미지 뷰어를 브라우저 네이티브 `<dialog>`(`showModal()`, `closedby`, `::backdrop`, `@starting-style`, `transition-behavior: allow-discrete`)로 전환하여 포커스 트랩, 배경 `inert` 처리, 데스크톱 `Esc` 및 모바일 뒤로가기 제스처를 표준화했습니다.
  - 알림 토스트(`#toast`, `popover="manual"`)와 이미지 컨텍스트 메뉴(`#img-ctx-menu`, `popover="auto"`)에 **Popover API**를 적용하여 전체화면 이미지 뷰어나 모달 위에서도 `z-index` 충돌 없이 항상 선명하게 표시됩니다.
- **렌더링 성능(INP) & 화면 전환 현대화**:
  - `document.startViewTransition()` 기반의 부드러운 화면 전환(홈 ↔ 목록 ↔ 상세)을 적용했습니다.
  - 대량 메모·검색 목록에 `content-visibility: auto`를 적용해 오프스크린 렌더링 비용을 절감하고, 역방향 링크(Backlinks) 스캔에 `scheduler.yield()` 청크 양보(`yieldToMain`)를 도입해 메인 스레드 블로킹을 방지했습니다.
  - 모달 내부 스크롤 체이닝 방지(`overscroll-behavior: contain`), 주요 이미지 `fetchpriority` / `loading="lazy" decoding="async"` 최적화를 적용했습니다.
- **웹 접근성(A11y) 및 사용자 환경 설정 존중**:
  - 폴더 행·태그 칩·메모 링크 등을 시맨틱 `<button>`으로 전환하고 키보드(`Tab`/`Enter`/`Space`) 탐색과 `:focus-visible` 포커스 링, `aria-live` 실시간 알림 영역을 지원합니다.
  - `@media (prefers-reduced-motion: reduce)` 및 `@media (prefers-contrast: more)`, `:has()` 상태 스타일링을 완벽 지원합니다.

### 2. 🔗 `[[메모링크]]` 실시간 한글 IME 검색 & 무진동 에디터 UX
- **가시 영역(`visualViewport`) 상단 고정형 메모링크 검색 모달**:
  - 모바일 가상 키보드가 올라와도 검색 입력란과 결과 목록이 가려지거나 흔들리지 않도록 키보드 위 가시 영역 최상단에 고정됩니다.
- **엔터 없는 실시간 한글 초성 · 연음 중간 단계 스마트 매칭**:
  - 한글 조합 중에도 글자를 치는 즉시(0ms) 아래에 쪽 제목이 실시간 나열됩니다.
  - 초성 검색(`ㅇㅈㅇㅎ`)은 물론 다음 글자 초성이 앞 받침에 임시 결합되는 타이핑 중간 과정(`양ㅈ`, `양장` 등)까지 끊김 없이 매칭하고 일치 구간을 하이라이트합니다. (`↑`/`↓` 방향키 및 `Enter` 즉시 삽입 지원)
- **실제 커서(Caret) 좌표 기반 스크롤 복원 & 하단 고정 툴바**:
  - 미러 엘리먼트로 `<textarea>` 내 실제 커서 줄의 픽셀 좌표를 정밀 계산하여, 메모 링크 삽입·모바일 키보드 전환·앱 전환 복귀 시 화면 점프 없이 작성 중이던 커서 줄을 그대로 유지합니다.
  - `음성 · 이미지 삽입 · 메모링크 · Lock` 1줄 컴팩트 툴바와 `취소 · 저장` 버튼을 모달 하단(`#note-modal-footer`)에 상시 고정해 긴 본문 어디서든 스크롤 없이 즉시 도구를 사용할 수 있습니다.

### 3. 🧠 고도화된 하이브리드 검색(Subindex BM25 + Max-Sim + Reranker) & 온디맨드 RAG
- **최신 임베딩 모델(`gemini-embedding-001@768`) & 서브인덱스 융합**:
  - 제목·태그·키워드 전용 서브인덱스와 본문 서브인덱스의 **Okapi BM25** 점수, 긴 본문 청크 분할 **최대 코사인 유사도(Max-Sim)**, **구문 근접도(Proximity)**, **최신성 가중치(Time Decay)**를 질문 유형에 따라 동적으로 결합합니다.
- **카테고리 내 인라인 검색 & 온디맨드 AI 요약 분리**:
  - 홈 화면뿐 아니라 각 카테고리(서브메뉴) 내부에서도 즉시 검색창을 열어 해당 폴더 범위로 검색하고 원래 목록·태그 필터 상태로 복귀할 수 있습니다.
  - 검색 즉시 하이브리드 상위 메모를 0초대로 먼저 보여주고, **`✨ AI 종합 답변 보기`** 버튼(또는 **`항상 자동 요약`** 토글)으로 원할 때만 `gemini-2.5-flash-lite` 스트리밍 RAG 답변을 생성합니다.

### 4. ⚡ 0초대 고속 시동 & 모바일 메모리·성능 최적화
- **IndexedDB 이중 영구 캐시 (`notesCache.ts` & `ai.ts`)**:
  - 메모 인덱스(`mynote_cache_db`)와 L2 정규화된 `Float32Array` 벡터 캐시(`mynote_ai_vector_cache_db`)를 IndexedDB에 분리 저장하여 수천 건의 메모도 첫 화면 0초대 즉시 렌더링과 Firestore 읽기 최소화를 달성했습니다.
- **코드 스플리팅 & 핫패스 경량화**:
  - AI 엔진(`ai.ts`), 이미지 뷰어(`imageViewer.ts`), 마크다운(`marked` + `DOMPurify`), 수식(`KaTeX`) 모듈을 온디맨드 동적 `import()` 및 벤더 청크로 분리하고, 한글 IME 타이핑 중 불필요한 전역 DOM 조회와 뷰포트 강제 리플로우를 차단했습니다.

### 5. 🛡️ PBKDF2 PIN 암호화 & 5회 오류 시 24시간 잠금 · 보안 알림
- **Web Crypto `PBKDF2` (100,000회 반복 + Salt) 해시 및 클라우드 동기화**:
  - 평문 PIN을 절대 보관하지 않으며, 브라우저 데이터를 삭제해도 우회되지 않도록 해시와 잠금 상태를 Firestore `user_meta/{uid}`와 안전하게 동기화합니다.
- **무차별 대입(Brute-force) 방어 & 보안 감사**:
  - 5회 연속 오류 시 24시간 동안 입력이 차단(실시간 카운트다운 표시)되며, 보안 경고 이메일 발송 및 Firestore `security_alerts` 감사 로그 기록이 자동으로 수행됩니다.

### 6. ⚙️ Node.js 24 기반 GitHub Pages 자동 배포 파이프라인
- GitHub Actions 워크플로를 **Node.js 24 네이티브 액션(`checkout@v6`, `setup-node@v6`, `configure-pages@v6`, `upload-pages-artifact@v5`, `deploy-pages@v5`)** 및 **`build` → `deploy` 2단계 잡 구조**로 고도화하여 아티팩트 경합 없이 안정적으로 자동 배포됩니다.

---

## ✨ 핵심 기능 요약

- **복수 카테고리(폴더) & 복수 서브 태그 분류**: 하나의 메모를 여러 폴더와 태그에 동시에 지정 가능하며 Firestore 트랜잭션으로 샤드 인덱스와 카운트를 원자적으로 관리합니다.
- **양방향 위키 링크 (`[[메모 제목]]`) & 역방향 링크 (Backlinks)**: 메모 간 유기적인 연결과 현재 메모를 참조하는 메모 자동 집계를 지원합니다.
- **마크다운 · KaTeX 수식 · 동영상 임베드**: 마크다운 문법, LaTeX 수식(`$...$`, `$$...$$`), YouTube/Shorts/Vimeo/Naver TV/Kakao TV/Google Drive 동영상 카드를 자동 렌더링합니다.
- **이미지 자동 압축 & 제스처 뷰어**: 클립보드 붙여넣기(`Ctrl+V`) 및 파일 선택 시 고해상도(최대 2560px) WebP/JPEG 자동 압축 업로드를 수행하며, 더블클릭·핀치/휠 줌·드래그 팬·다운로드를 지원하는 전용 뷰어를 제공합니다.
- **음성 입력 & 자동 임시저장**: Web Speech API 한국어 음성 받아쓰기와 새 메모·기존 메모 수정 중 비정상 종료 시 임시저장 복구를 지원합니다.
- **그림·서식 포함 하이브리드 복사 & 단축키**: 상세 화면 `복사` 시 리치 HTML(`text/html`)과 순수 텍스트(`text/plain`)를 동시에 복사하며, PC 단축키(`Ctrl+S` 저장, `Ctrl+K` 또는 `/` 검색, `Esc` 닫기/뒤로가기)를 지원합니다.

---

## 🛠️ 시작하기 및 설정 방법

### 1. 로컬 개발 및 테스트
```bash
# 의존성 패키지 설치 (Node.js 24 권장)
npm install

# 개발 서버 실행
npm run dev

# TypeScript 타입 검사 및 Vitest 단위 테스트 실행
npm run typecheck
npm test

# 프로덕션 번들 빌드
npm run build
```

### 2. Gemini API 키 설정 (`⚙️ AI 설정`)
1. [Google AI Studio](https://aistudio.google.com/app/apikey)에서 **Gemini API Key**를 발급받습니다.
2. 앱 내 검색 영역의 **`⚙️ AI 설정`** 버튼을 열어 API 키(및 선택적 Cloud Functions 보안 프록시 URL)를 입력하고 **`💾 설정 저장`**을 누릅니다.
   - 기본값은 현재 기기(`localStorage`)에만 단독 보관되며, **`내 계정에 암호화 동기화`** 체크 시 본인 전용 `user_meta/{uid}`를 통해 다른 기기에서도 자동 연동됩니다.
3. 기존 메모들의 임베딩을 한 번에 생성하려면 모달 하단의 **`일괄 변환 실행`** 버튼을 클릭합니다.

### 3. 선택적 환경변수 설정 (`.env`)
필요 시 아래 Vite 환경변수로 기본 계정 및 보안 알림 설정을 오버라이드할 수 있습니다.
- `VITE_ALLOWED_EMAILS`: 접근을 허용할 Google 이메일 목록 (쉼표 구분)
- `VITE_ALERT_EMAIL`: PIN 5회 오류 시 보안 경고를 수신할 이메일
- `VITE_ALERT_WEBHOOK_URL`: 보안 경고 전송용 커스텀 웹훅/Cloud Functions URL

---

## 📁 프로젝트 구조

```text
mynote/
├── .github/workflows/
│   └── deploy.yml          # Node.js 24 기반 빌드·테스트 및 GitHub Pages 2단계 배포 워크플로
├── index.html              # 메인 앱 셸, 0ms 초기 캐시 스크립트, 네이티브 <dialog> 및 Popover 마크업
├── public/
│   ├── manifest.json       # PWA 매니페스트 설정
│   └── sw.js               # 오프라인 앱 셸 캐싱 서비스 워커
├── vite.config.js          # Vite 빌드 설정 및 벤더 청크 분할 (firebase, katex, markdown)
├── src/
│   ├── main.ts             # 앱 부트스트랩, PWA 히스토리 네비게이션, 전역 단축키, 캐시 파이프라인
│   ├── pwa.ts              # View Transitions 화면 전환, 다이얼로그 상태 판별, 서비스 워커 등록
│   ├── state.ts            # 전역 상태 관리 (현재 메모, 사용자, 검색/목록 캐시 등)
│   ├── style.css           # 디자인 시스템, Top Layer 애니메이션, 반응형·접근성 스타일시트
│   ├── services/
│   │   ├── firebase.ts     # Firebase 앱, Auth, Firestore 오프라인 영구 캐시(persistentLocalCache)
│   │   ├── notesCache.ts   # IndexedDB 기반 메모 인덱스 로컬 영구 캐시 레이어
│   │   ├── ai.ts           # Gemini 임베딩, 서브인덱스 BM25 + Max-Sim 하이브리드 검색, RAG 스트리밍
│   │   ├── auth.ts         # Google OAuth 인증 및 허용 계정 검증
│   │   └── database.ts     # Firestore 트랜잭션 CRUD 및 복수 카테고리 샤드 인덱스 동기화
│   ├── ui/
│   │   ├── dom.ts          # 네이티브 <dialog> 헬퍼, scheduler.yield 래퍼, 공통 DOM 유틸
│   │   ├── listDetail.ts   # 카테고리 목록(정렬/태그 필터), 상세 뷰(백링크/하이브리드 복사/핀)
│   │   ├── noteModal.ts    # 메모 작성·수정 모달, 실시간 한글 메모링크 검색, Caret 정밀 스크롤
│   │   ├── search.ts       # 실시간 키워드 검색, 폴더 내 검색, 하이브리드 검색 & 온디맨드 RAG UI
│   │   ├── pinModal.ts     # PBKDF2 4자리 PIN 설정/검증, 5회 실패 24시간 잠금 및 보안 통지
│   │   └── imageViewer.ts  # 이미지 확대/축소, 드래그 팬, Popover 컨텍스트 메뉴, 다운로드 뷰어
│   ├── utils/
│   │   ├── formatter.ts    # 마크다운·KaTeX·동영상 파서, [[위키 링크]], 한글 IME 초성/연음 매칭
│   │   ├── image.ts        # 이미지 리사이징·압축 및 Firebase Storage 업로드/삭제
│   │   ├── imagePaths.ts   # 메모 본문 및 첨부 배열에서 Storage 이미지 경로 추출
│   │   └── toast.ts        # Popover Top Layer 기반 토스트 알림 유틸리티
│   └── types/
│       └── index.ts        # Note, NoteIndexItem 등 TypeScript 인터페이스 정의
├── tests/                  # Vitest 단위 테스트 (ai, database, formatter)
└── backups/                # 로컬 데이터 백업 전용 스크립트 (npx tsx backup.ts)
```
