"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import { CATEGORIES, type Area, type Category, type MarkStatus, type Restaurant } from "@/lib/types";

// Leaflet은 브라우저 전용이라 서버 렌더링 없이 불러온다
const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="map" />,
});

const CATEGORY_COLOR: Record<Category, string> = {
  한식: "var(--cat-hansik)",
  중식: "var(--cat-jungsik)",
  양식: "var(--cat-yangsik)",
  일식: "var(--cat-ilsik)",
  기타: "var(--cat-gita)",
};

type Mode = "area" | "ai";

interface AiFilter {
  categories: Category[];
  keyword: string | null;
  bplepay: MarkStatus | null;
}

const STATUS_TEXT: Record<Area["status"], string> = {
  pending: "수집 대기 중이에요. 관리자 PC의 수집기가 곧 가져옵니다.",
  collecting: "식당 정보를 수집하고 있어요. 잠시만 기다려 주세요.",
  done: "",
  error: "수집에 실패했어요.",
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `요청 실패 (${res.status})`);
  return json as T;
}

export default function BplepayApp() {
  const supabase = getBrowserSupabase();

  const [mode, setMode] = useState<Mode>("area");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(
    supabase ? null : { text: ".env의 Supabase 값이 비어 있어요. 작업절차.md를 참고해 키를 넣어 주세요.", error: true },
  );

  const [area, setArea] = useState<Area | null>(null);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [marks, setMarks] = useState<Record<string, MarkStatus>>({});
  const [enabled, setEnabled] = useState<Set<Category>>(new Set(CATEGORIES));
  const [aiFilter, setAiFilter] = useState<AiFilter | null>(null);

  // 실시간 구독 콜백에서 "지금 보고 있는 구획"을 알기 위한 ref
  const areaRef = useRef<Area | null>(null);
  useEffect(() => {
    areaRef.current = area;
  }, [area]);

  /** 식당 id 목록의 비플페이 표시를 불러온다 (URL 길이 때문에 나눠서 요청) */
  const loadMarks = useCallback(
    async (ids: string[]) => {
      if (!supabase || !ids.length) return;
      const next: Record<string, MarkStatus> = {};
      for (let i = 0; i < ids.length; i += 150) {
        const { data } = await supabase
          .from("bplepay_marks")
          .select("restaurant_id,status")
          .in("restaurant_id", ids.slice(i, i + 150));
        for (const m of data ?? []) next[m.restaurant_id] = m.status;
      }
      setMarks((prev) => ({ ...prev, ...next }));
    },
    [supabase],
  );

  /** 구획 상태에 따라 식당을 불러오거나 안내 문구를 띄운다 */
  const showArea = useCallback(
    async (a: Area) => {
      setArea(a);
      if (a.status !== "done") {
        setRestaurants([]);
        setMessage({
          text: `「${a.name}」 ${STATUS_TEXT[a.status]}${a.error ? ` (${a.error})` : ""}`,
          error: a.status === "error",
        });
        return;
      }
      if (!supabase) return;
      const rows: Restaurant[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("area_restaurants")
          .select("restaurants(*)")
          .eq("area_id", a.id)
          .range(from, from + 999);
        if (error) {
          setMessage({ text: error.message, error: true });
          return;
        }
        for (const row of data ?? []) {
          const r = row.restaurants as unknown as Restaurant | null;
          if (r?.is_restaurant) rows.push(r);
        }
        if (!data || data.length < 1000) break;
      }
      setRestaurants(rows);
      setMessage({ text: `「${a.label ?? a.name}」 식당 ${rows.length}곳` });
      await loadMarks(rows.map((r) => r.id));
    },
    [supabase, loadMarks],
  );

  // 실시간: 다른 사용자가 누른 비플페이 표시 + 수집 완료 알림
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel("bplepay-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "bplepay_marks" }, (payload) => {
        const row = payload.new as { restaurant_id?: string; status?: MarkStatus };
        if (row.restaurant_id && row.status) {
          setMarks((prev) => ({ ...prev, [row.restaurant_id!]: row.status! }));
        }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "areas" }, (payload) => {
        const updated = payload.new as Area;
        const current = areaRef.current;
        if (current && updated.id === current.id && updated.status !== current.status) {
          void showArea(updated);
        }
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, showArea]);

  // 실시간 연결이 끊겨도 수집 완료를 놓치지 않도록, 대기 중에는 15초마다 확인
  useEffect(() => {
    if (!supabase || !area || (area.status !== "pending" && area.status !== "collecting")) return;
    const timer = setInterval(async () => {
      const { data } = await supabase.from("areas").select("*").eq("id", area.id).single<Area>();
      if (data && data.status !== area.status) void showArea(data);
    }, 15000);
    return () => clearInterval(timer);
  }, [supabase, area, showArea]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setBusy(true);
    setMessage({ text: mode === "ai" ? "AI가 검색어를 해석하고 있어요…" : "구획을 찾고 있어요…" });
    try {
      if (mode === "area") {
        setAiFilter(null);
        const { area: a } = await postJson<{ area: Area }>("/api/areas", { name: q });
        await showArea(a);
      } else {
        const res = await postJson<{
          parsed: AiFilter & { area: string | null };
          area: Area | null;
          restaurants?: Restaurant[];
        }>("/api/search", { q });
        const { parsed } = res;
        setAiFilter({ categories: parsed.categories, keyword: parsed.keyword, bplepay: parsed.bplepay });
        if (res.area) {
          await showArea(res.area);
        } else {
          setArea(null);
          const rows = res.restaurants ?? [];
          setRestaurants(rows);
          setMessage({ text: `수집된 전체 지역에서 ${rows.length}곳을 찾았어요.` });
          await loadMarks(rows.map((r) => r.id));
        }
      }
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  const onMark = useCallback(async (restaurantId: string, status: MarkStatus) => {
    let previous: MarkStatus | undefined;
    setMarks((prev) => {
      previous = prev[restaurantId];
      return { ...prev, [restaurantId]: status };
    });
    try {
      await postJson("/api/marks", { restaurantId, status });
    } catch (err) {
      setMarks((prev) => {
        const next = { ...prev };
        if (previous) next[restaurantId] = previous;
        else delete next[restaurantId];
        return next;
      });
      setMessage({ text: `저장 실패: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  }, []);

  const visible = useMemo(() => {
    const kw = aiFilter?.keyword?.toLowerCase();
    return restaurants.filter((r) => {
      if (!enabled.has(r.category)) return false;
      if (!aiFilter) return true;
      if (aiFilter.categories.length && !aiFilter.categories.includes(r.category)) return false;
      if (kw && !`${r.name} ${r.upjong_small ?? ""}`.toLowerCase().includes(kw)) return false;
      if (aiFilter.bplepay && marks[r.id] !== aiFilter.bplepay) return false;
      return true;
    });
  }, [restaurants, enabled, aiFilter, marks]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(CATEGORIES.map((k) => [k, 0])) as Record<Category, number>;
    for (const r of restaurants) c[r.category]++;
    return c;
  }, [restaurants]);

  function toggle(cat: Category) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  return (
    <div className="app">
      <header className="toolbar">
        <h1>비플페이 지도</h1>
        <form className="search" onSubmit={onSubmit}>
          <div className="mode" role="group" aria-label="검색 방식">
            <button type="button" aria-pressed={mode === "area"} onClick={() => setMode("area")}>
              구획
            </button>
            <button type="button" aria-pressed={mode === "ai"} onClick={() => setMode("ai")}>
              AI 검색
            </button>
          </div>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === "area" ? "동 이름, 도로명, 지명 (예: 역삼동, 테헤란로, 강남역)" : "예: 을지로 근처 한식집"}
            aria-label="검색어"
          />
          <button className="go" type="submit" disabled={busy || !supabase}>
            {busy ? "…" : "검색"}
          </button>
        </form>
        <div className="filters">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              className="chip"
              aria-pressed={enabled.has(cat)}
              onClick={() => toggle(cat)}
            >
              <span className="dot" style={{ background: CATEGORY_COLOR[cat] }} />
              {cat} {restaurants.length ? counts[cat] : ""}
            </button>
          ))}
        </div>
        <div className="legend">
          <span>
            <span className="sample" style={{ border: "3px solid var(--neon)" }} />
            비플페이 가능
          </span>
          <span>
            <span className="sample" style={{ background: "var(--impossible)" }} />
            불가능
          </span>
        </div>
      </header>
      {message && (
        <div className={`status${message.error ? " error" : ""}`} role="status">
          {message.text}
          {aiFilter && (aiFilter.categories.length || aiFilter.keyword || aiFilter.bplepay)
            ? ` · AI 조건: ${[
                aiFilter.categories.join("/"),
                aiFilter.keyword,
                aiFilter.bplepay === "possible" ? "비플페이 가능" : aiFilter.bplepay === "impossible" ? "비플페이 불가능" : "",
              ]
                .filter(Boolean)
                .join(", ")} (${visible.length}곳)`
            : ""}
        </div>
      )}
      <MapView area={area} restaurants={visible} marks={marks} onMark={onMark} />
    </div>
  );
}
