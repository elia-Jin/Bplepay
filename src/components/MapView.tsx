"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import { GeoJSON, MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import type { Area, Category, MarkStatus, Restaurant } from "@/lib/types";

const SEOUL_CITY_HALL: [number, number] = [37.5665, 126.978];

const iconCache = new Map<string, L.DivIcon>();
function pinIcon(category: Category, mark: MarkStatus | undefined): L.DivIcon {
  const key = `${category}|${mark ?? ""}`;
  let icon = iconCache.get(key);
  if (!icon) {
    icon = L.divIcon({
      className: "pin-wrap",
      html: `<div class="pin cat-${category} ${mark ?? ""}"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      popupAnchor: [0, -10],
    });
    iconCache.set(key, icon);
  }
  return icon;
}

/** 구획이나 결과가 바뀌면 화면을 그 범위에 맞춘다 */
function FitBounds({ area, restaurants }: { area: Area | null; restaurants: Restaurant[] }) {
  const map = useMap();
  useEffect(() => {
    let bounds: L.LatLngBounds | null = null;
    if (area?.polygon) {
      bounds = L.geoJSON(area.polygon).getBounds();
    } else if (restaurants.length) {
      bounds = L.latLngBounds(restaurants.map((r) => [r.lat, r.lng] as [number, number]));
    }
    if (bounds?.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
    // 구획/결과 집합이 바뀔 때만 이동 (표시 변경으로는 이동하지 않음)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, area?.id, area?.polygon, restaurants.length]);
  return null;
}

interface Props {
  area: Area | null;
  restaurants: Restaurant[];
  marks: Record<string, MarkStatus>;
  onMark: (restaurantId: string, status: MarkStatus) => void;
}

export default function MapView({ area, restaurants, marks, onMark }: Props) {
  const polygonKey = useMemo(() => (area?.polygon ? `${area.id}-${area.collected_at}` : "none"), [area]);

  return (
    <MapContainer center={SEOUL_CITY_HALL} zoom={14} className="map" preferCanvas>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      {area?.polygon && (
        <GeoJSON
          key={polygonKey}
          data={area.polygon}
          style={{ color: "#2f6fed", weight: 2, fillColor: "#2f6fed", fillOpacity: 0.06 }}
        />
      )}
      {restaurants.map((r) => {
        const mark = marks[r.id];
        return (
          <Marker key={r.id} position={[r.lat, r.lng]} icon={pinIcon(r.category, mark)}>
            <Popup>
              <div className="popup">
                <h3>
                  {r.name}
                  {r.branch ? ` ${r.branch}` : ""}
                </h3>
                <p className="meta">
                  {r.category}
                  {r.upjong_small ? ` · ${r.upjong_small}` : ""}
                  {r.address ? <><br />{r.address}</> : null}
                </p>
                <p className="now">
                  비플페이:{" "}
                  <strong>{mark === "possible" ? "가능" : mark === "impossible" ? "불가능" : "미확인"}</strong>
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="yes"
                    aria-pressed={mark === "possible"}
                    onClick={() => onMark(r.id, "possible")}
                  >
                    비플페이 가능
                  </button>
                  <button
                    type="button"
                    className="no"
                    aria-pressed={mark === "impossible"}
                    onClick={() => onMark(r.id, "impossible")}
                  >
                    불가능
                  </button>
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
      <FitBounds area={area} restaurants={restaurants} />
    </MapContainer>
  );
}
