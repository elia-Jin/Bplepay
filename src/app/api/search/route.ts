import { requestArea } from "@/lib/areas";
import { parseSearchQuery } from "@/lib/gemini";
import { getServerSupabase } from "@/lib/supabase";
import { errorMessage, type Restaurant } from "@/lib/types";

/**
 * AI 자연어 검색. Gemini가 문장을 조건(구획·분류·키워드·비플페이)으로 바꾸고,
 * - 구획이 있으면: 그 구획을 찾거나 수집을 요청하고, 화면이 구획 데이터에 조건을 적용한다.
 * - 구획이 없으면: 이미 수집된 전체 식당에서 조건에 맞는 곳을 돌려준다.
 */
export async function POST(request: Request) {
  try {
    const { q } = (await request.json()) as { q?: string };
    if (!q?.trim()) return Response.json({ error: "검색어를 입력해 주세요." }, { status: 400 });

    const parsed = await parseSearchQuery(q.slice(0, 200));

    if (parsed.area) {
      const area = await requestArea(parsed.area);
      return Response.json({ parsed, area });
    }

    let query = getServerSupabase()
      .from("restaurants")
      .select("*")
      .eq("is_restaurant", true)
      .limit(500);
    if (parsed.categories.length) query = query.in("category", parsed.categories);
    // PostgREST 필터 문법을 깨뜨리는 문자는 제거
    const keyword = parsed.keyword?.replace(/[,()%*\\]/g, "");
    if (keyword) query = query.or(`name.ilike.%${keyword}%,upjong_small.ilike.%${keyword}%`);
    const { data, error } = await query.returns<Restaurant[]>();
    if (error) throw error;

    return Response.json({ parsed, area: null, restaurants: data });
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
