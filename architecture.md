# 비플페이 지도 — 아키텍처

구획 이름(동 이름·도로명·지명)을 입력하면 그 구획 안의 식당을 지도에 표시하고, 사용자가 식당마다 **비플페이 가능/불가능**을 기록하면 모든 접속자의 지도에 바로 반영되는 웹 서비스입니다.

## 1. 전체 구성

```
 ┌──────────────┐        ┌─────────────────────────┐        ┌────────────────────┐
 │ 사용자 브라우저 │ ─────▶ │ Vercel (Next.js)         │ ─────▶ │ Supabase (Postgres) │
 │  지도·버튼     │ ◀───── │  화면 + /api/* 서버 기능   │ ◀───── │  테이블 + Realtime   │
 └──────┬───────┘  HTTP  └───────────┬─────────────┘        └─────────▲──────────┘
        │                            │ Gemini API (자연어 해석)          │
        │  실시간 구독 (읽기 전용)       ▼                                  │ 수집 결과 저장
        └──────────────────────────────────────────────────▶          │
                                                          ┌────────────┴──────────┐
                                                          │ 관리자 PC 수집기          │
                                                          │  collector/index.mjs   │
                                                          │   ├ Aside CLI → 네이버지도 │ (구획 경계)
                                                          │   ├ 공공데이터포털 상가정보 │ (음식점 목록)
                                                          │   └ Gemini              │ (식당 아닌 곳 걸러내기)
                                                          └───────────────────────┘
```

| 구성 요소 | 위치 | 역할 |
|---|---|---|
| 웹 화면 | Vercel | 구획 입력, AI 검색, 지도(OpenStreetMap + Leaflet), 분류 필터, 비플페이 버튼 |
| API (Route Handler) | Vercel | 수집 요청 등록, 비플페이 표시 저장, Gemini 자연어 검색 |
| DB + 실시간 | Supabase | 구획·식당·표시 저장, 변경 사항을 모든 접속자에게 실시간 전달 |
| 수집기 | 관리자 PC | 대기 중인 구획을 처리 (Aside는 PC에서만 실행 가능하므로 Vercel과 분리) |

## 2. 기술 스택

| 분야 | 사용 기술 |
|---|---|
| 웹 프레임워크 | Next.js 16 (App Router, TypeScript) |
| 지도 | Leaflet + react-leaflet, OpenStreetMap 타일 (API 키 불필요) |
| DB / 실시간 | Supabase (Postgres, Row Level Security, Realtime) |
| AI | Google Gemini API (`@google/genai`). `gemini-flash-lite-latest` → `gemini-flash-latest` → `gemini-3.5-flash` 순으로, 과부하(503)면 다음 모델로 자동 전환 |
| 구획 경계 | Aside CLI (`aside exec`)로 네이버지도에서 추출 |
| 식당 목록 | 공공데이터포털 소상공인시장진흥공단 상가(상권)정보 `storeListInPolygon` |
| 공간 계산 | Turf.js (도로 버퍼, 원 생성, 폴리곤 단순화, 점-폴리곤 판정) |
| 배포 | Vercel (웹), 관리자 PC (수집기) |
| 로그인 | 없음 (누구나 접속·표시 가능) |

## 3. 폴더 구조

```
비플페이/
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx            # 공통 HTML 틀 (lang="ko", 제목)
│  │  ├─ page.tsx              # 첫 화면 → BplepayApp
│  │  ├─ globals.css           # 전체 스타일, 분류 색, 깜빡이는 형광 테두리 애니메이션
│  │  └─ api/
│  │     ├─ areas/route.ts     # POST: 구획 조회/수집 요청
│  │     ├─ marks/route.ts     # POST: 비플페이 가능/불가능 저장
│  │     └─ search/route.ts    # POST: Gemini 자연어 검색
│  ├─ components/
│  │  ├─ BplepayApp.tsx        # 검색창, 분류 필터, 상태 표시, 실시간 구독, 데이터 로딩
│  │  └─ MapView.tsx           # Leaflet 지도, 구획 폴리곤, 마커, 팝업 버튼
│  └─ lib/
│     ├─ types.ts              # 공통 타입, 5개 분류 상수
│     ├─ supabase.ts           # 브라우저용(anon) / 서버용(service_role) 클라이언트
│     ├─ areas.ts              # 구획 조회 + 수집 요청 등록
│     └─ gemini.ts             # 자연어 검색어 → 조건(구획·분류·키워드·비플페이)
├─ collector/
│  └─ index.mjs                # 관리자 PC 수집기 (Aside + 상가정보 + Gemini → Supabase)
├─ supabase/
│  └─ schema.sql               # 테이블, 권한(RLS), 실시간 설정
├─ .env                        # 키 (GitHub에 올라가지 않음)
├─ architecture.md             # 이 문서
└─ 작업절차.md                  # 설치·실행·배포 절차
```

## 4. 데이터 모델 (Supabase)

```
areas ──< area_restaurants >── restaurants ──1:1── bplepay_marks
```

| 테이블 | 주요 컬럼 | 설명 |
|---|---|---|
| `areas` | `name`(입력값, 고유), `label`, `kind`(dong/road/place), `polygon`(GeoJSON), `status`(pending/collecting/done/error), `error`, `store_count` | 구획과 수집 상태. 웹이 `pending`으로 만들면 수집기가 처리 |
| `restaurants` | `id`(상가업소번호), `name`, `category`(한식/중식/양식/일식/기타), `upjong_mid/small`, `address`, `lat/lng`, `is_restaurant` | 식당. Gemini가 식당이 아니라고 판단하면 `is_restaurant=false` (화면에서 숨김) |
| `area_restaurants` | `area_id`, `restaurant_id` | 구획-식당 연결 (구획이 겹쳐도 식당은 한 번만 저장) |
| `bplepay_marks` | `restaurant_id`(PK), `status`(possible/impossible), `updated_at` | 식당당 1행. 새 응답이 기존 값을 덮어씀 → **최신 응답 우선** |

**권한:** 모든 테이블은 RLS가 켜져 있고, 공개(anon) 키로는 **읽기만** 가능합니다. 쓰기는 Vercel 서버(API)와 수집기만 `service_role` 키로 합니다. 그래서 브라우저에서 DB를 직접 바꿀 수 없고, 반드시 `/api/*`를 거칩니다.

**실시간:** `bplepay_marks`, `areas`가 Supabase Realtime에 등록되어 있어, 누가 버튼을 누르거나 수집이 끝나면 접속 중인 모든 화면이 바로 갱신됩니다.

## 5. 주요 흐름

### 5.1 구획 입력 → 수집 → 지도 표시
1. 사용자가 「역삼동」 입력 → `POST /api/areas`
2. 이미 `done`이면 바로 반환. 없으면 `areas`에 `pending` 행 생성 (실패했던 구획은 다시 `pending`)
3. 화면은 "수집 대기 중" 표시 후 Realtime(+15초 확인)으로 상태 변화를 기다림
4. 수집기가 `pending` 구획을 가져와 `collecting`으로 변경 후:
   1. **Aside** → 네이버지도에서 검색, 경계 좌표를 `<result>{...}</result>` JSON으로 받음
      - 동: 폴리곤 그대로
      - 도로: 도로 선 → 양쪽 **50m** 버퍼 폴리곤 (`ROAD_BUFFER_M`)
      - 지명: 점 → 반경 **500m** 원 (`PLACE_RADIUS_M`)
      - 위도·경도 순서가 뒤집혀 오면 한국 좌표 범위로 판단해 바로잡음
   2. **상가정보 API** `storeListInPolygon` + 대분류 `I2`(음식)로 폴리곤 내 음식점 조회
      - 꼭짓점이 많으면 단순화(최대 약 120개)해서 조회하고, 원래 경계로 다시 한 번 걸러냄
   3. **분류**: 업종 중분류명으로 한식/중식/일식/양식(서양식)/기타
   4. **Gemini**: 200곳씩 묶어 "식당이 아닌 곳"(카페, 제과, 주점 등)을 골라 `is_restaurant=false`
   5. `restaurants`, `area_restaurants` 저장 → `areas.status='done'`
5. Realtime으로 화면이 `done`을 받아 식당을 불러와 지도에 표시

### 5.2 비플페이 표시
1. 마커 클릭 → 팝업의 **[비플페이 가능] [불가능]**
2. 화면에 바로 반영(낙관적 업데이트) → `POST /api/marks`가 `bplepay_marks`에 upsert
3. Realtime으로 다른 접속자 화면도 즉시 갱신
4. 표시 방식 (`globals.css`)
   - 가능: 형광 테두리(`#39ff14`)가 1초 주기로 **깜빡임** (`@keyframes neon-blink`)
   - 불가능: 회색 마커
   - 미확인: 분류 색 마커

### 5.3 AI 자연어 검색
1. 「을지로 근처 한식집」 → `POST /api/search`
2. Gemini가 JSON으로 해석: `{ area: "을지로", categories: ["한식"], keyword: null, bplepay: null }`
3. 구획이 있으면 5.1과 같이 구획을 불러오고(없으면 수집 요청), 화면에서 조건 필터 적용
4. 구획이 없으면 이미 수집된 전체 식당에서 분류·키워드로 검색해 반환

## 6. 환경변수 (.env)

| 이름 | 사용처 | 공개 여부 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 웹, 서버, 수집기 | 공개 가능 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 웹 (읽기·구독) | 공개 가능 (`sb_publishable_…`) |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버, 수집기 (쓰기) | **비공개** (`sb_secret_…`) |
| `GEMINI_API_KEY` | 서버, 수집기 | **비공개** |
| `DATA_GO_KR_SERVICE_KEY` | 수집기 | **비공개** |
| `GEMINI_MODEL` (선택) | 서버, 수집기 | 넣으면 이 모델을 가장 먼저 시도 |
| `ROAD_BUFFER_M`, `PLACE_RADIUS_M` (선택) | 수집기 | 기본 50, 500 |

`NEXT_PUBLIC_`로 시작하는 값은 브라우저 코드에 그대로 들어가므로, 비밀 키를 넣으면 안 됩니다.

## 7. 설계상 제약과 주의점

- **수집은 관리자 PC가 켜져 있고 `npm run collector`가 실행 중일 때만** 됩니다. 이미 수집된 구획은 PC와 무관하게 조회됩니다.
- **Aside 크레딧**: 구획 1개당 Aside 작업 1회. 역삼동 시험에 약 40초가 걸렸습니다. 무료 요금제는 월 500크레딧입니다.
- **네이버 화면 구조가 바뀌면** Aside가 좌표를 못 찾을 수 있습니다. 그때는 구획이 `error` 상태가 되고 화면에 이유가 표시됩니다.
- **상가정보는 분기 갱신** 데이터라 최근 개업·폐업이 반영되지 않을 수 있습니다.
- **로그인이 없으므로** 누구나 표시를 바꿀 수 있습니다(최신 응답 우선). 기록 이력이 필요하면 `bplepay_marks` 변경 로그 테이블을 추가하면 됩니다.
- OpenStreetMap 공용 타일은 소규모 서비스용입니다. 접속자가 많아지면 상용 타일 서비스로 바꾸는 것이 좋습니다.
