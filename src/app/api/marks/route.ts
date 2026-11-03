import { getServerSupabase } from "@/lib/supabase";
import { errorMessage, type MarkStatus } from "@/lib/types";

/** 비플페이 가능/불가능 표시. 가장 최근 응답이 이전 응답을 덮어쓴다. */
export async function POST(request: Request) {
  try {
    const { restaurantId, status } = (await request.json()) as {
      restaurantId?: string;
      status?: MarkStatus;
    };
    if (!restaurantId || (status !== "possible" && status !== "impossible")) {
      return Response.json({ error: "restaurantId와 status(possible|impossible)가 필요합니다." }, { status: 400 });
    }

    const { data, error } = await getServerSupabase()
      .from("bplepay_marks")
      .upsert({ restaurant_id: restaurantId, status, updated_at: new Date().toISOString() })
      .select("*")
      .single();
    if (error) throw error;
    return Response.json({ mark: data });
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
