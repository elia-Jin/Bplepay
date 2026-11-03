export const CATEGORIES = ["한식", "중식", "양식", "일식", "기타"] as const;
export type Category = (typeof CATEGORIES)[number];

export type MarkStatus = "possible" | "impossible";

export type AreaStatus = "pending" | "collecting" | "done" | "error";

export interface Area {
  id: string;
  name: string;
  label: string | null;
  kind: "dong" | "road" | "place" | null;
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  status: AreaStatus;
  error: string | null;
  store_count: number | null;
  requested_at: string;
  collected_at: string | null;
}

export interface Restaurant {
  id: string;
  name: string;
  branch: string | null;
  category: Category;
  upjong_mid: string | null;
  upjong_small: string | null;
  address: string | null;
  lat: number;
  lng: number;
  is_restaurant: boolean;
}

/** Error 객체가 아닌 Supabase 오류({ message, code })도 읽을 수 있는 문장으로 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") return e.message;
  return String(e);
}

/** 입력 이름 정규화: 공백 제거 ("역삼 동" → "역삼동") */
export function normalizeAreaName(name: string): string {
  return name.replace(/\s+/g, "").trim();
}
