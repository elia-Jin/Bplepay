import { getServerSupabase } from "./supabase";
import { normalizeAreaName, type Area } from "./types";

/** 구획을 찾고, 없으면 수집 요청(pending)을 만든다. 실패했던 구획은 다시 요청 상태로 되돌린다. */
export async function requestArea(rawName: string): Promise<Area> {
  const name = normalizeAreaName(rawName);
  if (!name || name.length > 40) throw new Error("구획 이름을 확인해 주세요.");

  const supabase = getServerSupabase();
  const { data: existing, error: findError } = await supabase
    .from("areas")
    .select("*")
    .eq("name", name)
    .maybeSingle<Area>();
  if (findError) throw findError;

  if (existing && existing.status !== "error") return existing;

  const { data, error } = await supabase
    .from("areas")
    .upsert(
      { name, status: "pending", error: null, requested_at: new Date().toISOString() },
      { onConflict: "name" },
    )
    .select("*")
    .single<Area>();
  if (error) throw error;
  return data;
}
