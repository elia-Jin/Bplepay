-- 비플페이 지도 서비스 DB 스키마
-- Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.

-- 1) 구획: 사용자가 입력한 동 이름/도로명/지명과 그 경계 폴리곤
create table if not exists public.areas (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,               -- 사용자가 입력한 이름 (공백 제거)
  label         text,                               -- 네이버에 표시된 정식 이름
  kind          text check (kind in ('dong', 'road', 'place')),
  polygon       jsonb,                              -- GeoJSON Polygon / MultiPolygon (WGS84)
  status        text not null default 'pending'
                check (status in ('pending', 'collecting', 'done', 'error')),
  error         text,
  store_count   integer,
  requested_at  timestamptz not null default now(),
  collected_at  timestamptz
);

-- 2) 식당: 소상공인 상가정보 1건 = 1행 (상가업소번호가 키)
create table if not exists public.restaurants (
  id             text primary key,                  -- 상가업소번호 (bizesId)
  name           text not null,
  branch         text,
  category       text not null check (category in ('한식', '중식', '양식', '일식', '기타')),
  upjong_mid     text,                              -- 상권업종중분류명
  upjong_small   text,                              -- 상권업종소분류명
  address        text,
  lat            double precision not null,
  lng            double precision not null,
  is_restaurant  boolean not null default true,     -- Gemini가 "식당 아님"으로 판단하면 false
  updated_at     timestamptz not null default now()
);

-- 3) 구획-식당 연결 (한 식당이 여러 구획에 속할 수 있음)
create table if not exists public.area_restaurants (
  area_id        uuid not null references public.areas(id) on delete cascade,
  restaurant_id  text not null references public.restaurants(id) on delete cascade,
  primary key (area_id, restaurant_id)
);

-- 4) 비플페이 가능/불가능 표시 (식당당 1행, 가장 최근 응답이 덮어씀)
create table if not exists public.bplepay_marks (
  restaurant_id  text primary key references public.restaurants(id) on delete cascade,
  status         text not null check (status in ('possible', 'impossible')),
  updated_at     timestamptz not null default now()
);

create index if not exists areas_status_idx on public.areas (status, requested_at);
create index if not exists area_restaurants_restaurant_idx on public.area_restaurants (restaurant_id);
create index if not exists restaurants_category_idx on public.restaurants (category);

-- 권한: 웹 화면(anon 키)은 읽기만. 쓰기는 Vercel 서버와 PC 수집기가 service_role 키로 처리.
alter table public.areas            enable row level security;
alter table public.restaurants      enable row level security;
alter table public.area_restaurants enable row level security;
alter table public.bplepay_marks    enable row level security;

drop policy if exists "public read" on public.areas;
drop policy if exists "public read" on public.restaurants;
drop policy if exists "public read" on public.area_restaurants;
drop policy if exists "public read" on public.bplepay_marks;
create policy "public read" on public.areas            for select using (true);
create policy "public read" on public.restaurants      for select using (true);
create policy "public read" on public.area_restaurants for select using (true);
create policy "public read" on public.bplepay_marks    for select using (true);

-- 실시간 반영: 표시 변경과 수집 상태 변경을 모든 접속자에게 바로 전달
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'bplepay_marks') then
    alter publication supabase_realtime add table public.bplepay_marks;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'areas') then
    alter publication supabase_realtime add table public.areas;
  end if;
end $$;
