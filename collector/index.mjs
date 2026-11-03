// 비플페이 지도 - 내 PC 수집기
//
// Supabase의 areas 테이블에서 status='pending'인 구획을 가져와
//   1) Aside(네이버지도)로 구획 경계를 얻고
//   2) 공공데이터포털 소상공인 상가정보에서 경계 안의 음식점을 받아
//   3) 한식/중식/양식/일식/기타로 나누고 Gemini로 식당이 아닌 곳을 걸러
//   4) Supabase에 저장한다.
//
// 실행:  npm run collector                      → 대기하면서 들어오는 요청을 계속 처리
//        npm run collector -- 역삼동             → 해당 구획만 바로 수집하고 종료
//        npm run collector -- --dry-run 역삼동   → Supabase에 저장하지 않고 결과만 출력 (시험용)

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import * as turf from "@turf/turf";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const POLL_MS = 10_000;
const ROAD_BUFFER_M = Number(process.env.ROAD_BUFFER_M ?? 50); // 도로명: 도로 양쪽 거리
const PLACE_RADIUS_M = Number(process.env.PLACE_RADIUS_M ?? 500); // 지명: 반경
const ASIDE_BIN = process.env.ASIDE_BIN || "aside";
const ASIDE_TIMEOUT_MS = 10 * 60_000;
// 앞 모델이 과부하(503)면 다음 모델로 넘어간다
const GEMINI_MODELS = [
  ...new Set([process.env.GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-3.5-flash"]),
].filter(Boolean);
const STORE_API = "https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInPolygon";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[설정 오류] .env의 ${name} 값이 비어 있습니다.`);
    process.exit(1);
  }
  return v;
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const AREA_ARG = args.filter((a) => !a.startsWith("--")).join("").replace(/\s+/g, "");

const supabase = DRY_RUN
  ? null
  : createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
const DATA_KEY = requireEnv("DATA_GO_KR_SERVICE_KEY");
const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 90_000 } })
  : null;

const log = (...args) => console.log(`[${new Date().toLocaleTimeString("ko-KR")}]`, ...args);

// ───────────────────────── 1) Aside로 구획 경계 얻기 ─────────────────────────

function asidePrompt(name) {
  return `네이버 지도(https://map.naver.com)에서 "${name}"을(를) 검색해 주세요.
- 검색 결과가 행정구역(동·가 등)이면: 지도에 그려지는 구역 경계선(폴리곤)의 좌표
- 도로명(○○로, ○○길)이면: 지도에 강조되는 도로 선의 좌표
- 역·건물·지명이면: 그 위치의 좌표 한 점
을 구해 주세요.

좌표는 페이지가 경계선을 그리려고 받아오는 네트워크 응답이나 지도 데이터에서 실제 값을 추출해야 하며, 절대 어림잡아 만들어 내면 안 됩니다.
좌표는 WGS84 [경도, 위도] 순서, GeoJSON geometry(Polygon / MultiPolygon / LineString / MultiLineString / Point)로 정리하세요.

마지막 답변에는 아래 형식의 JSON 하나만 <result>와 </result> 사이에 넣어 출력하세요.
<result>{"kind":"dong 또는 road 또는 place","label":"네이버에 표시된 정식 이름(예: 서울특별시 강남구 역삼동)","geometry":{...GeoJSON geometry...}}</result>
찾지 못했으면 <result>{"error":"이유"}</result>`;
}

function runAside(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(ASIDE_BIN, ["exec", prompt], { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Aside 응답 시간 초과(10분)"));
    }, ASIDE_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Aside CLI 실행 실패: ${e.message} (aside 명령이 설치돼 있는지 확인)`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.includes("<result>")) reject(new Error(`Aside 종료 코드 ${code}: ${err.slice(-500)}`));
      else resolve(out);
    });
  });
}

/** text[start]의 '{'부터 짝이 맞는 '}'까지 잘라 JSON으로 읽는다. 실패하면 null */
function readJsonObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseAsideResult(text) {
  // Aside는 중간 설명에도 <result>라는 말을 쓰기 때문에 태그 짝에 의존하지 않고,
  // 출력 전체에서 {"kind"... 또는 {"error"... 로 시작하는 JSON 중 마지막으로 읽히는 것을 쓴다
  let json = null;
  for (const m of text.matchAll(/\{\s*"(kind|error|label|geometry)"/g)) {
    const parsed = readJsonObjectAt(text, m.index);
    if (parsed && (parsed.geometry?.type || parsed.error)) json = parsed;
  }
  if (!json) {
    const tail = text.replace(/\s+/g, " ").slice(-200);
    throw new Error(`Aside 답변에서 좌표 JSON을 찾지 못했습니다. 마지막 출력: ${tail}`);
  }
  if (json.error) throw new Error(`Aside: ${json.error}`);
  if (!json.geometry?.type) throw new Error("Aside 답변에 geometry가 없습니다.");
  return json;
}

/** [위도, 경도]로 뒤집혀 온 좌표를 바로잡는다 (한국 범위 기준) */
function fixAxisOrder(geometry) {
  const first = turf.coordAll(turf.feature(geometry))[0];
  if (!first) throw new Error("좌표가 비어 있습니다.");
  const [x, y] = first;
  const inKorea = (lng, lat) => lng > 124 && lng < 132 && lat > 33 && lat < 39.5;
  if (inKorea(x, y)) return geometry;
  if (inKorea(y, x)) {
    const flipped = structuredClone(geometry);
    turf.coordEach(turf.feature(flipped), (c) => c.reverse());
    return flipped;
  }
  throw new Error(`좌표가 한국 범위를 벗어났습니다: ${first}`);
}

/** 네이버 결과를 "구획 폴리곤"으로 통일: 도로는 띠, 지명은 원 */
function toAreaPolygon(geometry) {
  const g = fixAxisOrder(geometry);
  switch (g.type) {
    case "Polygon":
    case "MultiPolygon":
      return g;
    case "LineString":
    case "MultiLineString":
      return turf.buffer(turf.feature(g), ROAD_BUFFER_M, { units: "meters" }).geometry;
    case "Point":
      return turf.circle(g.coordinates, PLACE_RADIUS_M, { units: "meters", steps: 48 }).geometry;
    default:
      throw new Error(`지원하지 않는 geometry: ${g.type}`);
  }
}

async function getBoundary(name) {
  log(`  Aside로 「${name}」 경계 조회 중… (수 분 걸릴 수 있음)`);
  const result = parseAsideResult(await runAside(asidePrompt(name)));
  return {
    kind: ["dong", "road", "place"].includes(result.kind) ? result.kind : null,
    label: result.label ?? null,
    polygon: toAreaPolygon(result.geometry),
  };
}

// ───────────────────────── 2) 소상공인 상가정보에서 음식점 받기 ─────────────────────────

/** API가 받는 WKT 길이를 넘지 않도록 꼭짓점 수를 줄인다 */
function toWkt(polygonCoords) {
  let ring = polygonCoords[0];
  let tolerance = 0.00005;
  while (ring.length > 120 && tolerance < 0.01) {
    ring = turf.simplify(turf.polygon([polygonCoords[0]]), { tolerance, highQuality: true }).geometry.coordinates[0];
    tolerance *= 2;
  }
  return `POLYGON((${ring.map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`).join(", ")}))`;
}

async function fetchStorePage(wkt, pageNo, withFoodFilter) {
  const params = new URLSearchParams({
    serviceKey: DATA_KEY,
    pageNo: String(pageNo),
    numOfRows: "1000",
    key: wkt,
    type: "json",
  });
  if (withFoodFilter) params.set("indsLclsCd", "I2"); // 대분류: 음식
  const res = await fetch(`${STORE_API}?${params}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`상가정보 API 응답 오류(HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const code = json.header?.resultCode;
  if (code === "03") return { items: [], total: 0 }; // 데이터 없음
  if (code !== "00") throw new Error(`상가정보 API 오류 ${code}: ${json.header?.resultMsg}`);
  return { items: json.body?.items ?? [], total: Number(json.body?.totalCount ?? 0) };
}

async function fetchStoresInPolygon(polygonCoords) {
  const wkt = toWkt(polygonCoords);
  for (const withFoodFilter of [true, false]) {
    const items = [];
    for (let page = 1; ; page++) {
      const { items: batch, total } = await fetchStorePage(wkt, page, withFoodFilter);
      items.push(...batch);
      if (!batch.length || items.length >= total) break;
    }
    const food = items.filter((s) => s.indsLclsNm === "음식" || String(s.indsLclsCd).startsWith("I2"));
    if (food.length || !withFoodFilter) return food;
    // 업종 코드 체계가 달라 필터가 0건이면, 필터 없이 받아서 직접 거른다
  }
  return [];
}

async function fetchStores(areaPolygon) {
  const polygons = areaPolygon.type === "Polygon" ? [areaPolygon.coordinates] : areaPolygon.coordinates;
  const area = turf.feature(areaPolygon);
  const byId = new Map();
  for (const coords of polygons) {
    for (const s of await fetchStoresInPolygon(coords)) {
      const lng = Number(s.lon);
      const lat = Number(s.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      // 단순화된 폴리곤으로 조회했으므로 원래 경계로 한 번 더 확인
      if (!turf.booleanPointInPolygon([lng, lat], area)) continue;
      byId.set(s.bizesId, { ...s, lng, lat });
    }
  }
  return [...byId.values()];
}

// ───────────────────────── 3) 분류 + Gemini로 식당 아닌 곳 거르기 ─────────────────────────

function classify(mid = "", small = "") {
  const t = `${mid} ${small}`;
  if (/한식/.test(t)) return "한식";
  if (/중식|중국/.test(t)) return "중식";
  if (/일식|일본/.test(t)) return "일식";
  if (/서양식|양식|이탈리|프랑스|스테이크|피자|햄버거|버거|패스트푸드/.test(t)) return "양식";
  return "기타";
}

const NOT_RESTAURANT_RULE = `"식당"은 손님이 와서 식사를 하는 음식점입니다(분식·패스트푸드·고깃집·뷔페 포함).
다음은 식당이 아닙니다: 카페·커피전문점·찻집·주스 등 음료 위주 가게, 제과·제빵·떡·아이스크림·디저트 전문점,
반찬가게·정육·식품 판매점, 술이 주력인 호프·바·포차(식사 위주 가게는 식당), 편의점, 배달 전용 공유주방.`;

/** 503(과부하)·429(한도)·404(모델 종료)·시간 초과면 다음 모델로, 모델을 한 바퀴 돌면 잠깐 쉬고 한 번 더 */
async function withModelFallback(fn) {
  let lastError;
  for (let round = 0; round < 2; round++) {
    for (const model of GEMINI_MODELS) {
      try {
        return await fn(model);
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/\b(503|429|404|UNAVAILABLE|RESOURCE_EXHAUSTED|NOT_FOUND)\b|aborted|timeout/i.test(msg)) throw e;
        log(`  Gemini ${model} 응답 실패, 다음 모델로…`);
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw lastError;
}

/** 식당이 아닌 가게의 bizesId 집합. Gemini 키가 없으면 빈 집합(전부 식당으로 취급) */
async function findNonRestaurants(stores) {
  const result = new Set();
  if (!gemini) {
    log("  GEMINI_API_KEY가 없어 '식당 아님' 걸러내기를 건너뜁니다.");
    return result;
  }
  for (let i = 0; i < stores.length; i += 200) {
    const batch = stores.slice(i, i + 200);
    const lines = batch
      .map((s, j) => `${j}\t${s.bizesNm}\t${s.indsMclsNm?.trim() ?? ""}>${s.indsSclsNm?.trim() ?? ""}`)
      .join("\n");
    const res = await withModelFallback((model) => gemini.models.generateContent({
      model,
      contents: `${NOT_RESTAURANT_RULE}\n\n아래 목록(번호\\t상호\\t업종)에서 식당이 아닌 가게의 번호만 골라 주세요.\n\n${lines}`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { notRestaurant: { type: "array", items: { type: "integer" } } },
          required: ["notRestaurant"],
        },
      },
    }));
    const { notRestaurant = [] } = JSON.parse(res.text ?? "{}");
    for (const idx of notRestaurant) if (batch[idx]) result.add(batch[idx].bizesId);
  }
  return result;
}

// ───────────────────────── 4) 저장 ─────────────────────────

async function upsertChunks(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table} 저장 실패: ${error.message}`);
  }
}

/** 경계 → 음식점 → 분류 → 식당 아님 걸러내기 (저장 전 단계) */
async function gather(name) {
  const boundary = await getBoundary(name);
  log(`  경계 확보: ${boundary.label ?? name} (${boundary.kind ?? "?"}, ${boundary.polygon.type})`);

  const stores = await fetchStores(boundary.polygon);
  log(`  상가정보 음식점 ${stores.length}곳`);

  const nonRestaurants = await findNonRestaurants(stores);
  log(`  식당 아님으로 분류: ${nonRestaurants.size}곳`);

  const now = new Date().toISOString();
  const rows = stores.map((s) => ({
    id: s.bizesId,
    name: s.bizesNm,
    branch: s.brchNm || null,
    category: classify(s.indsMclsNm, s.indsSclsNm),
    upjong_mid: s.indsMclsNm?.trim() || null, // API 값 끝에 공백이 붙어 오는 경우가 있음
    upjong_small: s.indsSclsNm?.trim() || null,
    address: s.rdnmAdr || s.lnoAdr || null,
    lat: s.lat,
    lng: s.lng,
    is_restaurant: !nonRestaurants.has(s.bizesId),
    updated_at: now,
  }));
  return { boundary, rows, restaurantCount: rows.length - nonRestaurants.size, now };
}

async function collect(area) {
  log(`▶ 「${area.name}」 수집 시작`);
  await supabase.from("areas").update({ status: "collecting", error: null }).eq("id", area.id);

  try {
    const { boundary, rows, restaurantCount, now } = await gather(area.name);
    await upsertChunks("restaurants", rows, "id");

    await supabase.from("area_restaurants").delete().eq("area_id", area.id);
    await upsertChunks(
      "area_restaurants",
      rows.map((r) => ({ area_id: area.id, restaurant_id: r.id })),
      "area_id,restaurant_id",
    );

    const { error } = await supabase
      .from("areas")
      .update({
        status: "done",
        kind: boundary.kind,
        label: boundary.label,
        polygon: boundary.polygon,
        store_count: restaurantCount,
        collected_at: now,
        error: null,
      })
      .eq("id", area.id);
    if (error) throw error;
    log(`✔ 「${area.name}」 완료: 식당 ${restaurantCount}곳`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`✖ 「${area.name}」 실패: ${message}`);
    await supabase.from("areas").update({ status: "error", error: message.slice(0, 500) }).eq("id", area.id);
  }
}

// ───────────────────────── 실행 ─────────────────────────

async function nextPending() {
  const { data, error } = await supabase
    .from("areas")
    .select("*")
    .eq("status", "pending")
    .order("requested_at")
    .limit(1);
  if (error) throw error;
  return data[0] ?? null;
}

async function dryRun(name) {
  log(`▶ [시험] 「${name}」 (Supabase에 저장하지 않음)`);
  const { boundary, rows, restaurantCount } = await gather(name);
  const byCategory = {};
  for (const r of rows.filter((r) => r.is_restaurant)) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  console.log(`\n구획: ${boundary.label} (${boundary.kind}) / 식당 ${restaurantCount}곳`);
  console.log("분류별:", byCategory);
  console.log("식당 아님으로 걸러진 예:", rows.filter((r) => !r.is_restaurant).slice(0, 10).map((r) => `${r.name}(${r.upjong_small})`).join(", "));
  console.log("식당 예:", rows.filter((r) => r.is_restaurant).slice(0, 10).map((r) => `${r.name}[${r.category}]`).join(", "));
}

async function main() {
  if (DRY_RUN) {
    if (!AREA_ARG) throw new Error("--dry-run 뒤에 구획 이름을 적어 주세요. 예: npm run collector -- --dry-run 역삼동");
    await dryRun(AREA_ARG);
    return;
  }

  const name = AREA_ARG;
  if (name) {
    const { data, error } = await supabase
      .from("areas")
      .upsert({ name, status: "pending", requested_at: new Date().toISOString() }, { onConflict: "name" })
      .select("*")
      .single();
    if (error) throw error;
    await collect(data);
    return;
  }

  // 지난번에 수집 도중 꺼졌던 구획은 다시 대기열로
  await supabase.from("areas").update({ status: "pending" }).eq("status", "collecting");
  log("수집기 대기 중… (종료: Ctrl+C)");
  for (;;) {
    try {
      const area = await nextPending();
      if (area) await collect(area);
      else await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (e) {
      log("대기열 확인 오류:", e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
