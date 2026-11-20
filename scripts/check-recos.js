// 매달 추천(recos.js) 검사: node scripts/check-recos.js
// 형식·좌표 범위(홈 지도 안)·id 중복·시간 형식·카테고리를 확인하고, 문제가 있으면 exit 1
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const root = path.join(__dirname, "..");
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "templates.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(root, "recos.js"), "utf8"), ctx);
const base = ctx.window.PREDEFINED_TEMPLATES || {};
const batches = ctx.window.MONTHLY_RECOS;
const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const CATS = new Set(["sightseeing", "restaurant", "cafe", "shopping", "hotel", "transit"]);
const TIME = /^([01]\d|2[0-3]):[0-5]\d - ([01]\d|2[0-3]):[0-5]\d$/;
// 홈 지도 범위 (app.js HOME_MAP): 경도 122~142, 위도 31.2~40.2
const inMap = (lat, lng) => lng > 122.2 && lng < 141.8 && lat > 31.4 && lat < 40.0;
if (!Array.isArray(batches)) err("recos.js", "window.MONTHLY_RECOS 배열이 없음");
const ids = new Set(Object.keys(base));
const months = new Set();
(batches || []).forEach((b, bi) => {
  const w = `묶음[${bi}] ${b && b.month}`;
  if (!b || !/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month || "")) return err(w, "month는 YYYY-MM");
  if (months.has(b.month)) err(w, "같은 달 묶음이 두 개");
  months.add(b.month);
  if (bi > 0 && String(b.month) > String(batches[bi - 1].month)) err(w, "최신 달이 맨 앞에 와야 함");
  if (!Array.isArray(b.templates) || b.templates.length < 3 || b.templates.length > 6) err(w, "templates는 3~6개");
  (b.templates || []).forEach(t => {
    const tw = `${w} / ${t && t.id}`;
    if (!t || !t.id || ids.has(t.id)) return err(tw, "id가 없거나 중복");
    ids.add(t.id);
    for (const k of ["title", "description", "destination"]) if (!t[k] || typeof t[k] !== "string") err(tw, `${k} 없음`);
    if (!Number.isInteger(t.duration) || t.duration < 1 || t.duration > 5) err(tw, "duration은 1~5 정수");
    if (!["low", "medium", "high"].includes(t.budget)) err(tw, "budget은 low|medium|high");
    if (!["relaxing", "active"].includes(t.style)) err(tw, "style은 relaxing|active");
    if (t.theme && !(/^#[0-9A-Fa-f]{6}$/.test(t.theme.c1 || "") && /^#[0-9A-Fa-f]{6}$/.test(t.theme.c2 || "") && t.theme.emoji)) err(tw, "theme {c1:#RRGGBB, c2:#RRGGBB, emoji}");
    const places = Array.isArray(t.places) ? t.places : [];
    if (places.length < 4 * t.duration) err(tw, `장소가 너무 적음(${places.length})`);
    const pids = new Set();
    let sumLat = 0, sumLng = 0, n = 0;
    places.forEach((p, i) => {
      const pw = `${tw} / 장소${i} ${p && p.name}`;
      if (!p || !p.id || pids.has(p.id)) return err(pw, "장소 id 없음/중복");
      pids.add(p.id);
      if (!Number.isInteger(p.day) || p.day < 1 || p.day > t.duration) err(pw, "day 범위");
      if (!CATS.has(p.category)) err(pw, "category");
      if (!TIME.test(p.time || "")) err(pw, `time 형식 "HH:MM - HH:MM" (${p.time})`);
      if (!(typeof p.lat === "number" && typeof p.lng === "number")) err(pw, "lat/lng 숫자");
      else if (p.category !== "transit") { sumLat += p.lat; sumLng += p.lng; n++; }
      if (!p.description) err(pw, "description 없음");
    });
    for (let d = 1; d <= t.duration; d++) {
      const day = places.filter(p => p.day === d);
      const meals = day.filter(p => p.category === "restaurant").length;
      if (d === 1 || d === t.duration ? meals < 1 : meals < 3) err(tw, `${d}일차 끼니 부족(${meals}끼): 중간 날은 아침·점심·저녁 3끼, 첫날·마지막 날은 머무는 동안의 끼니`);
      if (d > 1 && d < t.duration && !day.some(p => p.category === "restaurant" && /\(아침\)/.test(p.name))) err(tw, `${d}일차 아침 없음`);
      if (d < t.duration && !day.some(p => p.category === "hotel")) err(tw, `${d}일차 숙소 없음`);
      for (let i = 1; i < day.length; i++) if ((day[i].time || "") < (day[i - 1].time || "")) err(tw, `${d}일차 시간 순서`);
    }
    if (n && !inMap(sumLat / n, sumLng / n)) err(tw, "코스 중심이 홈 지도(한국·일본 서부~도쿄) 밖");
    places.forEach(p => {
      if (typeof p.lat === "number" && n && p.category !== "transit" && Math.hypot(p.lat - sumLat / n, (p.lng - sumLng / n) * 0.8) > 1.2) err(`${tw} / ${p.name}`, "다른 장소들과 너무 멀리 떨어진 좌표(오타 의심)");
    });
  });
});
if (errors.length) { console.error("❌ 문제 " + errors.length + "건\n" + errors.join("\n")); process.exit(1); }
console.log(`✅ 통과: 묶음 ${(batches || []).length}개, 코스 ${(batches || []).reduce((a, b) => a + b.templates.length, 0)}개`);
