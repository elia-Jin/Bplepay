import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let browserClient: SupabaseClient | null = null;

/** 브라우저용 클라이언트 (anon 키, 읽기 + 실시간 구독만 가능) */
export function getBrowserSupabase(): SupabaseClient | null {
  if (!url || !anonKey) return null;
  try {
    browserClient ??= createClient(url, anonKey);
  } catch {
    return null; // URL 형식이 잘못된 경우 화면에서 안내 문구를 보여준다
  }
  return browserClient;
}

/** 서버(Route Handler)용 클라이언트 (service_role 키, 쓰기 가능) */
export function getServerSupabase(): SupabaseClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Supabase 환경변수(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)가 비어 있습니다.");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}
