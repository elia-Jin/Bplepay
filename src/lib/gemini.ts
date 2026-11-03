import { GoogleGenAI } from "@google/genai";
import { CATEGORIES, type Category } from "./types";

// 앞 모델이 과부하(503)면 다음 모델로 넘어간다
const MODELS = [
  ...new Set([process.env.GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-3.5-flash"]),
].filter((m): m is string => !!m);

export interface ParsedQuery {
  area: string | null;        // "을지로", "역삼동" 등. 없으면 null
  categories: Category[];     // 비어 있으면 전체
  keyword: string | null;     // "국밥", "짜장면" 같은 메뉴·가게 이름 키워드
  bplepay: "possible" | "impossible" | null; // "비플페이 되는 곳" 같은 조건
}

/** 503(과부하)·429(한도)·404(모델 종료) 같은 오류는 다음 모델로 다시 시도 */
async function withModelFallback<T>(fn: (model: string) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const model of MODELS) {
    try {
      return await fn(model);
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/\b(503|429|404|UNAVAILABLE|RESOURCE_EXHAUSTED|NOT_FOUND)\b|aborted|timeout/i.test(msg)) throw e;
    }
  }
  throw lastError;
}

/** 자연어 검색어를 구조화된 조건으로 바꾼다. 예: "을지로 근처 한식집" → { area: "을지로", categories: ["한식"] } */
export async function parseSearchQuery(q: string): Promise<ParsedQuery> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY 환경변수가 비어 있습니다.");
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 20_000 } });

  const res = await withModelFallback((model) => ai.models.generateContent({
    model,
    contents: `사용자가 식당 지도에서 검색한 문장을 조건으로 바꿔 주세요.
- area: 동 이름, 도로명(○○로/○○길), 역·지명 등 장소. "근처", "주변" 같은 말은 빼고 장소 이름만. 없으면 null.
- categories: ${CATEGORIES.join(", ")} 중 해당하는 것. 파스타·스테이크·피자·버거는 양식, 초밥·라멘·돈카츠는 일식, 짜장면·마라탕은 중식, 그 외 분류가 애매하면 기타. 언급이 없으면 빈 배열.
- keyword: 특정 메뉴나 가게 이름(예: 국밥, 칼국수, 스타벅스). 분류 이름 자체(한식집 등)는 keyword가 아님. 없으면 null.
- bplepay: "비플페이 되는/가능한" → "possible", "안 되는/불가능한" → "impossible", 언급 없으면 null.

검색 문장: ${q}`,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          area: { type: ["string", "null"] },
          categories: { type: "array", items: { type: "string", enum: [...CATEGORIES] } },
          keyword: { type: ["string", "null"] },
          bplepay: { type: ["string", "null"], enum: ["possible", "impossible", null] },
        },
        required: ["area", "categories", "keyword", "bplepay"],
      },
    },
  }));

  const parsed = JSON.parse(res.text ?? "{}") as Partial<ParsedQuery>;
  return {
    area: parsed.area?.trim() || null,
    categories: (parsed.categories ?? []).filter((c): c is Category =>
      (CATEGORIES as readonly string[]).includes(c),
    ),
    keyword: parsed.keyword?.trim() || null,
    bplepay: parsed.bplepay ?? null,
  };
}
