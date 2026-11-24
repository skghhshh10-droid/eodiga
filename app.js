// 어디가 (구 Routy) - 개인용 AI 여행 플래너 (Core Controller & SPA Engine)

// --- Global Application State ---
const state = {
  activeTab: 'explore',
  seniorMode: false,
  fontSizeStep: 0, // 0: Normal, 1: Large, 2: Extra Large, 3: Double Extra Large, 4: Triple Extra Large
  savedTrips: [],
  activeTrip: null, // 현재 보고 있는 일정 { id, title, destination, days, startDate, budget, places: [] }
  activeTripDay: 1,
  editMode: false
};

// Map instance storage
let leafletMap = null;
let mapTileLayer = null;
let mapMarkersGroup = null;
let mapRouteLine = null;

// --- Pricing & Budget Utilities ---
function hashCode(str) {
  let hash = 0;
  if (!str) return hash;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

function getDeterministicPrice(placeName, category, budgetTier) {
  const hash = hashCode(placeName || "");
  const tier = budgetTier || "medium";
  
  if (category === "hotel") {
    if (tier === "low") {
      return 60000 + (hash % 50) * 1000;
    } else if (tier === "high") {
      return 250000 + (hash % 300) * 1000;
    } else { // medium
      return 120000 + (hash % 100) * 1000;
    }
  }
  
  if (category === "restaurant") {
    if (tier === "low") {
      return 8000 + (hash % 10) * 1000;
    } else if (tier === "high") {
      return 35000 + (hash % 60) * 1000;
    } else {
      return 15000 + (hash % 20) * 1000;
    }
  }
  
  if (category === "cafe") {
    if (tier === "low") {
      return 4000 + (hash % 4) * 500;
    } else if (tier === "high") {
      return 8000 + (hash % 12) * 500;
    } else {
      return 5500 + (hash % 6) * 500;
    }
  }
  
  if (category === "sightseeing") {
    if (hash % 4 === 0) return 0; // 25% chance free
    if (tier === "low") {
      return 5000 + (hash % 10) * 1000;
    } else if (tier === "high") {
      return 25000 + (hash % 30) * 1000;
    } else {
      return 12000 + (hash % 15) * 1000;
    }
  }
  
  if (category === "shopping") {
    if (tier === "low") {
      return 10000 + (hash % 20) * 1000;
    } else if (tier === "high") {
      return 80000 + (hash % 150) * 1000;
    } else {
      return 30000 + (hash % 50) * 1000;
    }
  }
  
  if (category === "transit") {
    const nameLower = (placeName || "").toLowerCase();
    if (nameLower.includes("택시")) {
      if (tier === "low") {
        return 5000 + (hash % 5) * 1000;
      } else if (tier === "high") {
        return 18000 + (hash % 20) * 1000;
      } else {
        return 9000 + (hash % 10) * 1000;
      }
    }
    if (nameLower.includes("지하철") || nameLower.includes("메트로") || nameLower.includes("버스")) {
      return 1400;
    }
    if (nameLower.includes("ktx") || nameLower.includes("srt") || nameLower.includes("기차") || nameLower.includes("열차") || nameLower.includes("항공") || nameLower.includes("비행기") || nameLower.includes("스카이라이너") || nameLower.includes("하루카")) {
      return 20000 + (hash % 60) * 1000;
    }
    if (nameLower.includes("도보") || nameLower.includes("걷기")) {
      return 0;
    }
    return 1500 + (hash % 5) * 500;
  }
  
  return 10000 + (hash % 15) * 1000;
}

// --- 끼니 채우기: 아침(숙박 다음 날부터)·점심·저녁이 빠진 날에 식사 자리를 넣는다 ---
// 넣은 자리는 이름이 '점심 식사 · ○○ 근처'이고, Places 키가 있으면 주변 Google 1위 식당으로 자동 교체된다
// 끼니 시간대: 식사 전체가 이 안에 들어가게 배치 (조식 07~09시, 중식 12~14시, 석식 18~20시)
const MEAL_SLOTS = [
  { key: "breakfast", label: "아침", from: 7 * 60, to: 9 * 60, dur: 45, query: "breakfast", re: /아침|조식|브런치|아점|breakfast|brunch/i },
  { key: "lunch", label: "점심", from: 12 * 60, to: 14 * 60, dur: 60, query: "", re: /점심|런치|중식|브런치|아점|lunch|brunch/i },
  { key: "dinner", label: "저녁", from: 18 * 60, to: 20 * 60, dur: 70, query: "", re: /저녁|디너|석식|dinner/i }
];

function mealWindowOf(p) {
  if (!p || p.category !== "restaurant" || p.noMealWindow) return null;
  if (p.mealSlot) return MEAL_SLOTS.find(m => m.key === p.mealSlot) || null;
  const named = MEAL_SLOTS.filter(m => m.re.test(p.name || ""));
  if (named.length > 1) return null; // 브런치·아점처럼 두 끼에 걸치면 건드리지 않음
  if (named.length === 1) return named[0];
  // 이름에 끼니 표시가 없으면, 끼니 시간 근처(앞 90분·뒤 60분)일 때만 식사로 본다 (오후 간식 등은 그대로)
  const r = parseTimeRange(p.time);
  if (!r) return null;
  return MEAL_SLOTS.find(m => r[0] >= m.from - 90 && r[0] <= m.to + 60) || null;
}

// 식사를 정해진 시간대 안으로 옮기고, 겹치는 앞뒤 일정은 밀거나 줄인다
function alignMealWindows(trip) {
  if (!trip || !Array.isArray(trip.places)) return false;
  let changed = false;
  const days = trip.days || Math.max(1, ...trip.places.map(p => p.day || 1));
  const fixed = p => !!p.intercity || (p.category === "transit" && STOP_RE.test(p.name || ""));
  const setTime = (p, a, b) => { p.time = `${minutesToHHMM(a)} - ${minutesToHHMM(b)}`; };
  for (let d = 1; d <= days; d++) {
    const all = trip.places.filter(p => p.day === d);
    all.forEach(p => {
      const W = mealWindowOf(p), r = parseTimeRange(p.time);
      if (!W || !r) return;
      const dur = Math.min(Math.max(r[1] - r[0], 30), W.to - W.from);
      const st = Math.min(Math.max(r[0], W.from), W.to - dur);
      if (st !== r[0] || st + dur !== r[1]) { setTime(p, st, st + dur); changed = true; }
    });
    for (let guard = 0; guard < 40; guard++) {
      const list = all.map(p => ({ p, r: parseTimeRange(p.time) })).filter(x => x.r)
        .sort((a, b) => a.r[0] - b.r[0] || (mealWindowOf(a.p) ? -1 : 1));
      let moved = false;
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        if (b.r[0] >= a.r[1]) continue;
        const aW = mealWindowOf(a.p), bW = mealWindowOf(b.p);
        if (bW) {
          const dur = b.r[1] - b.r[0];
          if (a.r[1] + 10 + dur <= bW.to) setTime(b.p, a.r[1] + 10, a.r[1] + 10 + dur);            // 식사를 조금 늦춤
          else if (!aW && !fixed(a.p) && b.r[0] - 10 - a.r[0] >= 30) setTime(a.p, a.r[0], b.r[0] - 10); // 앞 일정을 줄임
          else if (!aW && !fixed(a.p)) setTime(a.p, b.r[1] + 10, b.r[1] + 10 + (a.r[1] - a.r[0])); // 앞 일정을 식사 뒤로
          else continue;
        } else if (!fixed(b.p)) {
          setTime(b.p, a.r[1] + 10, a.r[1] + 10 + (b.r[1] - b.r[0]));                                 // 뒤 일정을 밂
        } else if (!aW && !fixed(a.p)) {
          setTime(a.p, a.r[0], Math.max(a.r[0] + 20, b.r[0] - 10));
        } else continue;
        changed = moved = true;
        break;
      }
      if (!moved) break;
    }
    sortTripPlaces(trip, d);
  }
  return changed;
}

function mealOf(p) {
  if (p.category !== "restaurant") return [];
  const r = parseTimeRange(p.time);
  const named = MEAL_SLOTS.filter(m => m.re.test(p.name || "")).map(m => m.key);
  if (named.length) return named;
  if (!r) return [];
  const st = r[0];
  if (st < 10 * 60 + 30) return ["breakfast"];
  if (st < 16 * 60) return ["lunch"];
  return ["dinner"];
}

function mealSummary(meals) {
  const n = k => meals.filter(m => m.mealSlot === k).length;
  return MEAL_SLOTS.filter(m => n(m.key)).map(m => `${m.label} ${n(m.key)}`).join("·");
}

function ensureMeals(trip) {
  if (!trip || !Array.isArray(trip.places) || trip.mealsChecked) return [];
  trip.mealsChecked = true;
  const added = [];
  const lastDay = trip.days || Math.max(1, ...trip.places.map(p => p.day || 1));
  const isEdgeTransit = p => p.category === "transit" && (p.intercity || STOP_RE.test(p.name || ""));
  for (let d = 1; d <= lastDay; d++) {
    const day = () => trip.places.filter(p => p.day === d).map(p => ({ p, r: parseTimeRange(p.time) })).filter(x => x.r).sort((a, b) => a.r[0] - b.r[0]);
    let list = day();
    if (!list.length) continue;
    const have = new Set(list.flatMap(x => mealOf(x.p)));
    // 그날 실제로 돌아다니는 시간: 첫날은 도착 뒤부터, 마지막 날은 출발 전까지
    // 첫날 맨 앞의 이동 구간들(공항 도착 → 시내 이동 등)은 한 덩어리로 보고 그 뒤부터
    let leadEnd = -1;
    if (d === 1) for (const x of list) { if (x.p.category === "transit") leadEnd = x.r[1]; else break; }
    const startMin = leadEnd >= 0 ? leadEnd : list[0].r[0];
    const trail = [];
    if (d === lastDay && lastDay > 1) for (const x of list.slice().reverse()) { if (x.p.category === "transit") trail.unshift(x); else if (x.p.category !== "hotel") break; }
    const tailTransit = trail[0] || null;
    const nonHotel = list.filter(x => x.p.category !== "hotel");
    const endMin = tailTransit ? tailTransit.r[0] : (d < lastDay ? 22 * 60 : (nonHotel.length ? nonHotel[nonHotel.length - 1].r[1] : list[list.length - 1].r[1]));
    // 연박이면 숙소가 첫날에만 적혀 있을 수 있어 가장 최근 숙소를 쓴다
    const prevHotel = trip.places.filter(p => p.day < d && p.category === "hotel").sort((a, b) => a.day - b.day).pop();
    const pref = trip.meals || {};
    MEAL_SLOTS.forEach(m => {
      if (have.has(m.key)) return;
      if (pref[m.key] === false) return; // 넣지 않기로 한 끼니
      if (m.key === "breakfast" && (d === 1 || !prevHotel)) return; // 첫날 아침은 집·이동 중
      if (m.key !== "breakfast" && (startMin > m.to - 30 || endMin < m.from + m.dur)) return; // 그 시간에 여행지에 없음
      list = day();
      let st, near;
      if (m.key === "breakfast") {
        const first = list.find(x => x.p.category !== "hotel") || list[0];
        // 조식 시간대(07~09시) 안에서, 첫 일정 전에 끝나도록 (안 되면 시간대 끝에 넣고 뒤 일정을 밂)
        st = Math.max(m.from, Math.min(m.to - m.dur, first.r[0] - 10 - m.dur));
        near = prevHotel || first.p;
      } else {
        // 끼니 시간대 안의 빈틈을 먼저 찾고, 없으면 그 시간에 끼워 넣고 뒤 일정을 민다
        let gapFound = null;
        for (let i = 0; i <= list.length; i++) {
          const gs = Math.max(i ? list[i - 1].r[1] + 10 : startMin, m.from, startMin);
          const ge = Math.min(i < list.length ? list[i].r[0] - 10 : endMin, m.to);
          if (ge - gs >= m.dur) { gapFound = { st: gs, near: (i ? list[i - 1] : list[i] || list[0]).p }; break; }
        }
        if (gapFound) { st = gapFound.st; near = gapFound.near; }
        else {
          // 끼니 시작 시각에 진행 중인 일정이 있으면 그 뒤에, 아니면 끼니 시각에 넣고 겹치는 뒤 일정을 민다
          const fixed = x => x.p.intercity || trail.includes(x) || (d === 1 && x.r[1] <= startMin && x.p.category === "transit");
          const covering = list.find(x => x.p.category !== "hotel" && x.r[0] <= m.from && x.r[1] > m.from);
          st = Math.min(Math.max(covering ? covering.r[1] + 10 : m.from, startMin, m.from), m.to - m.dur);
          near = covering ? covering.p : (list.filter(x => x.r[0] < st && x.p.category !== "hotel").pop() || list[0]).p;
          const next = list.find(x => x !== covering && x.r[1] > st && !fixed(x));
          const shift = next ? st + m.dur + 10 - next.r[0] : 0;
          if (shift > 0) {
            const from = next.r[0];
            list.filter(x => x.r[0] >= from && !fixed(x)).forEach(x => { x.p.time = shiftTimeString(x.p.time, shift); });
          }
        }
      }
      if (!hasCoords(near)) near = list.map(x => x.p).find(hasCoords);
      if (!near) return;
      // 아침을 숙소 조식으로 고른 경우: 식당 대신 '숙소 조식' (식당 자동 선택 안 함)
      if (m.key === "breakfast" && pref.breakfast === "hotel" && prevHotel) {
        const hb = {
          id: `custom-meal-${d}-hotelbf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          day: d, category: "restaurant", mealSlot: m.key, name: "숙소 조식",
          time: `${minutesToHHMM(st)} - ${minutesToHHMM(st + m.dur)}`,
          lat: prevHotel.lat, lng: prevHotel.lng, coordChecked: true, autoTopTried: true, price: 0,
          description: `${String(prevHotel.name || "숙소").slice(0, 20)}에서 아침 식사. 조식 포함이 아니면 근처 카페·편의점도 좋아요.`
        };
        trip.places.push(hb);
        added.push(hb);
        return;
      }
      const nearName = String(near.name || "").replace(/^(아침|점심|저녁) 식사 · /, "").replace(/ 근처$/, "").replace(/ 숙소$/, "").replace(/\s*\([^)]*\)\s*/g, " ").trim().slice(0, 14);
      const meal = {
        id: `meal-${d}-${m.key}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        day: d, category: "restaurant", mealSlot: m.key,
        name: `${m.label} 식사 · ${nearName} 근처`,
        time: `${minutesToHHMM(st)} - ${minutesToHHMM(st + m.dur)}`,
        lat: near.lat, lng: near.lng, coordChecked: true,
        topQuery: m.query,
        description: m.key === "breakfast" ? "숙소 근처 아침 식사. 숙소 조식이 있으면 그걸로 대신해도 돼요." : `일정 사이 ${m.label} 식사. 'TOP 5'에서 주변 인기 식당을 고를 수 있어요.`
      };
      trip.places.push(meal);
      added.push(meal);
    });
    sortTripPlaces(trip, d);
  }
  if (added.length) ensurePlacePrices(trip);
  alignMealWindows(trip);
  trip.mealWin1 = true;
  return added;
}

function ensurePlacePrices(trip) {
  if (!trip || !trip.places) return;
  trip.places.forEach(place => {
    if (place.priceUnit !== "group" && place.priceUnit !== "person") {
      place.priceUnit = place.category === "hotel" ? "group" : "person";
    }
    if (place.price === undefined || place.price === null) {
      place.price = getDeterministicPrice(place.name, place.category, trip.budget);
    }
  });
}

// --- Initialize App ---
document.addEventListener("DOMContentLoaded", () => {
  // 아이콘 렌더
  window.hydrateIcons();

  // Load LocalStorage state
  loadLocalStorage();
  
  // Render time in status bar
  updateStatusBarTime();
  setInterval(updateStatusBarTime, 60000);

  // Setup tab event listeners
  setupNavigation();
  
  // Setup theme toggle
  setupThemeToggle();

  // Setup Senior Mode toggles & overrides
  setupSeniorMode();
  setupSettingsExtras();
  renderHomeGreet();

  // Setup template selection cards
  renderTemplates();

  // Setup home/explore screen search input listener
  setupExploreSearch();

  // Setup input autocomplete / suggestions
  setupSuggestions();

  // Setup planner form submission
  setupPlannerForm();

  // Setup itinerary controls (save, back, place drawers)
  setupItineraryControls();

  // Setup senior detail view modal
  setupSeniorDetailModal();

  // Setup final confirmation screen actions
  setupConfirmationScreen();

  // Settings, place editing, delegated place buttons
  setupSettings();
  setupPlaceEditModal();
  setupBudgetModal();
  setupPlaceActionDelegation();
  setupTitleRename();
  renderSidebarTrips();
  window.addEventListener("orientationchange", () => setTimeout(refreshMapSize, 300));
  updateAiNotice();
  setupDietInputs();
  setupTemplateSetup();
  setupFlightFit();
  setupPlannerSteps();

  // Render initial explorer state
  renderExploreTab();

  // Setup drag-to-scroll functionality for Day tabs
  setupDayTabsDragScroll();

  // 공유 링크(#trip=...)로 열었으면 해당 일정 표시, 아니면 주소/첫 화면 결정
  handleSharedLink();
  routeInitial();
  window.addEventListener("popstate", () => {
    if (navDepth > 0) navDepth--;
    if (!applyRoute()) routeInitial();
  });

  // 입력 포커스로 고정 틀이 스크롤되면 즉시 원위치 (구형 Safari 대비)
  ["app-viewport", "device-wrapper"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("scroll", () => { if (el.scrollTop) el.scrollTop = 0; });
  });

  // iOS가 브라우저 저장소를 비우지 않도록 요청
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then(p => { if (!p) navigator.storage.persist(); }).catch(() => {});
  }

  // PWA: 오프라인 캐시
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then(reg => {
        // 앱을 다시 열거나 화면에 돌아올 때마다 새 버전 확인
        document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
      })
      .catch(err => console.warn("SW 등록 실패", err));
  }

  // Window resize handler to invalidate map sizes during responsive transition
  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      refreshMapSize();
    }, 200);
  });
});

// --- Status Bar Time ---
function updateStatusBarTime() {
  const timeEl = document.querySelector(".status-time");
  if (timeEl) {
    const now = new Date();
    let hours = now.getHours();
    let minutes = now.getMinutes();
    hours = hours < 10 ? '0' + hours : hours;
    minutes = minutes < 10 ? '0' + minutes : minutes;
    timeEl.textContent = `${hours}:${minutes}`;
  }
}

// --- Navigation & Router ---
function setupNavigation() {
  const navButtons = document.querySelectorAll("#bottom-nav .nav-item, #desktop-header .desktop-nav-item");
  navButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      switchTab(tab);
    });
  });
}

// --- 주소(해시) 연동: 뒤로 가기·새로고침 시 화면 유지 ---
let routerSilent = false;
let navDepth = 0;
const TAB_ROUTES = { explore: "explore", planner: "planner", trips: "trips", profile: "settings" };

function currentRouteFor(tabName) {
  if (tabName === "itinerary" && state.activeTrip) {
    return isActiveTripSaved() ? `#/trip/${encodeURIComponent(state.activeTrip.id)}` : "#/draft";
  }
  return `#/${TAB_ROUTES[tabName] || tabName}`;
}

function syncRoute(tabName) {
  if (routerSilent) return;
  const target = currentRouteFor(tabName);
  if (location.hash === target) return;
  history.pushState({ routy: true }, "", target);
  navDepth++;
}

function applyRoute() {
  const h = decodeURIComponent(location.hash || "");
  routerSilent = true;
  try {
    let m;
    if ((m = h.match(/^#\/trip\/(.+)$/))) {
      const trip = state.savedTrips.find(t => t.id === m[1]);
      if (trip) loadSavedTrip(trip.id);
      else switchTab("trips");
    } else if (h === "#/draft") {
      if (state.activeTrip && !isActiveTripSaved()) showItineraryView();
      else if (loadDraft()) showItineraryView();
      else switchTab("trips");
    } else if ((m = h.match(/^#\/(explore|planner|trips|settings)$/))) {
      switchTab(m[1] === "settings" ? "profile" : m[1]);
    } else {
      return false;
    }
    return true;
  } finally {
    routerSilent = false;
  }
}

// 첫 화면: 여행 중인 일정 → 내 일정 → 탐색
function routeInitial() {
  if (location.hash.startsWith("#trip=")) return; // 공유 링크는 handleSharedLink가 처리
  if (applyRoute()) return;
  routerSilent = true;
  try {
    const ongoing = state.savedTrips.find(t => getTodayDay(t));
    if (ongoing) loadSavedTrip(ongoing.id);
    else if (state.savedTrips.length) switchTab("trips");
    else switchTab("explore");
  } finally {
    routerSilent = false;
  }
  history.replaceState({ routy: true }, "", currentRouteFor(state.activeTab));
}

function goBack(fallbackTab) {
  if (navDepth > 0) {
    navDepth--;
    history.back();
  } else {
    switchTab(fallbackTab);
  }
}

// --- 저장 전 일정 임시 보관 (새로고침·앱 종료 대비) ---
function saveDraft() {
  try {
    if (state.activeTrip && !isActiveTripSaved()) {
      localStorage.setItem("routy_draft", JSON.stringify(state.activeTrip));
    }
  } catch (e) { /* 용량 부족 등은 무시 */ }
}
function clearDraft() {
  localStorage.removeItem("routy_draft");
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem("routy_draft") || "null");
    if (d && Array.isArray(d.places)) {
      ensureTripShape(d);
      ensurePlacePrices(d);
      state.activeTrip = d;
      state.activeTripDay = 1;
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

function switchTab(tabName) {
  state.activeTab = tabName;
  syncRoute(tabName);
  const toastEl = document.getElementById("toast-notification");
  if (toastEl && tabName !== "itinerary") toastEl.classList.remove("active");
  const menu = document.getElementById("trip-menu");
  if (menu) menu.classList.remove("open");
  const navTab = tabName === "itinerary" ? (isActiveTripSaved() ? "trips" : (state.activeTrip && state.activeTrip.source === "template" ? "explore" : "planner")) : tabName;

  // Toggle active screen visibility
  document.querySelectorAll(".app-screen").forEach(screen => {
    screen.classList.remove("active");
  });
  
  const targetScreen = document.getElementById(`screen-${tabName}`);
  if (targetScreen) {
    targetScreen.classList.add("active");
  }

  // Toggle bottom navigation icons active states
  document.querySelectorAll("#bottom-nav .nav-item").forEach(btn => {
    if (btn.getAttribute("data-tab") === navTab) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Toggle desktop navigation active states
  document.querySelectorAll("#desktop-header .desktop-nav-item").forEach(btn => {
    if (btn.getAttribute("data-tab") === navTab) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Render specific tab contents on transition
  renderSidebarTrips();
  if (tabName === 'trips') {
    renderSavedTrips();
  } else if (tabName === 'planner') {
    updateAiNotice();
  } else if (tabName === 'explore') {
    const searchInput = document.getElementById("explore-search-input");
    if (searchInput) {
      searchInput.value = "";
    }
    renderExploreTab();
    renderTemplates();
  } else if (tabName === 'profile') {
    renderSettingsTab();
  }
}

// --- Theme Toggle ---
function setupThemeToggle() {
  const mobileToggle = document.getElementById("btn-quick-theme");
  const desktopToggle = document.getElementById("btn-desktop-theme");
  
  const updateButtons = (theme) => {
    const html = window.icon(theme === "dark" ? "sun" : "moon", 20);
    if (mobileToggle) mobileToggle.innerHTML = html;
    if (desktopToggle) desktopToggle.innerHTML = html;
  };

  const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
  updateButtons(currentTheme);
  
  const handleToggle = () => {
    const activeTheme = document.documentElement.getAttribute("data-theme") || "light";
    const newTheme = activeTheme === "dark" ? "light" : "dark";
    
    document.documentElement.setAttribute("data-theme", newTheme);
    localStorage.setItem("routy_theme", newTheme);
    updateButtons(newTheme);
    showToast(newTheme === "dark" ? "다크 모드로 전환되었습니다." : "라이트 모드로 전환되었습니다.");
    
    // Update map tiles dynamically if map is initialized
    if (leafletMap && mapTileLayer) {
      const tileUrl = newTheme === "dark" 
        ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
      mapTileLayer.setUrl(tileUrl);
    }
    setOfmTheme();
  };

  if (mobileToggle) mobileToggle.addEventListener("click", handleToggle);
  if (desktopToggle) desktopToggle.addEventListener("click", handleToggle);
}

// --- Toast Notifications ---
let toastTimer = null;
function showToast(message, duration = 2500, action = null) {
  const toast = document.getElementById("toast-notification");
  toast.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);
  toast.classList.toggle("has-action", !!action);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      toast.classList.remove("active");
      action.onClick();
    });
    toast.appendChild(btn);
  }
  toast.classList.add("active");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("active");
  }, action ? Math.max(duration, 6000) : duration);
}

// 변경 전 상태를 저장해 두고 "되돌리기" 토스트를 띄움
function withUndo(message, mutate) {
  if (!state.activeTrip) return;
  const before = cloneTrip(state.activeTrip);
  mutate();
  renderItineraryAll();
  persistActiveTrip();
  showToast(typeof message === "function" ? message() : message, 6000, {
    label: "되돌리기",
    onClick: () => {
      state.activeTrip = before;
      if (state.activeTripDay > before.days) state.activeTripDay = before.days;
      renderItineraryAll();
      persistActiveTrip();
      showToast("되돌렸습니다.");
    }
  });
}

// --- Local Storage Management ---
function loadLocalStorage() {
  try {
    // 사는 곳이 광주로 바뀐 뒤 첫 실행: 예전 기본값(서울)이 남아 있으면 광주로
    if (!localStorage.getItem("routy_home_v1")) {
      const o = localStorage.getItem("routy_origin");
      if (!o || o === "서울") localStorage.setItem("routy_origin", DEFAULT_ORIGIN);
      localStorage.setItem("routy_home_v1", "1");
    }
    const savedTrips = localStorage.getItem("routy_saved_trips");
    if (savedTrips) {
      state.savedTrips = JSON.parse(savedTrips);
      state.savedTrips.forEach(trip => {
        ensureTripShape(trip);
        ensurePlacePrices(trip);
      });
    }

    const savedStep = localStorage.getItem("routy_font_size_step");
    if (savedStep !== null) {
      state.fontSizeStep = parseInt(savedStep, 10) || 0;
    }
    state.seniorMode = state.fontSizeStep > 0;

    // 예전 버전의 가짜 기능 데이터 정리
    ["routy_user", "routy_kpi", "routy_friends", "routy_mock_users", "routy_senior_mode"].forEach(k => localStorage.removeItem(k));

    const savedTheme = localStorage.getItem("routy_theme") || "light";
    document.documentElement.setAttribute("data-theme", savedTheme);
  } catch (e) {
    console.error("LocalStorage load error: ", e);
  }
}

function saveToLocalStorage() {
  try {
    localStorage.setItem("routy_saved_trips", JSON.stringify(state.savedTrips));
    localStorage.setItem("routy_font_size_step", state.fontSizeStep.toString());
    if (typeof renderSidebarTrips === "function") renderSidebarTrips();
  } catch (e) {
    console.error("LocalStorage write error: ", e);
    showToast("저장 공간이 부족해 저장하지 못했습니다. 오래된 일정을 백업 후 삭제해 주세요.", 5000);
  }
}

// --- 공통 헬퍼 ---
const TRANSPORT_LABELS = { auto: "알아서", transit: "대중교통", car: "자가용", rental: "렌터카", taxi: "택시", walk: "도보 위주" };
const MOVE_LABELS = { walk: "도보", bus: "버스", express: "고속·시외버스", subway: "지하철", train: "기차", car: "자가용", taxi: "택시", bike: "자전거", ferry: "배", flight: "비행기" };
const MOVE_ICONS = { walk: "walk", bus: "bus", express: "bus", subway: "train", train: "train", car: "car", taxi: "taxi", bike: "bike", ferry: "ferry", flight: "flight" };
const CATEGORY_LABELS = { sightseeing: "관광", restaurant: "맛집", cafe: "카페", shopping: "쇼핑", hotel: "숙소", transit: "이동" };
const CATEGORY_EMOJI = { sightseeing: "📍", restaurant: "🍜", cafe: "☕", shopping: "🛍️", hotel: "🏨", transit: "🚉" };
const expandedMore = new Set();
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function esc(str) {
  return String(str === undefined || str === null ? "" : str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cloneTrip(trip) {
  return JSON.parse(JSON.stringify(trip));
}

function isActiveTripSaved() {
  return !!state.activeTrip && state.savedTrips.some(t => t.id === state.activeTrip.id);
}

// 저장된 일정이면 변경 즉시 자동 저장
function persistActiveTrip() {
  if (!state.activeTrip) return;
  const i = state.savedTrips.findIndex(t => t.id === state.activeTrip.id);
  if (i > -1) {
    state.activeTrip.updatedAt = Date.now();
    state.savedTrips[i] = cloneTrip(state.activeTrip);
    saveToLocalStorage();
  } else {
    saveDraft();
  }
  updateSaveButton();
}

function updateSaveButton() {
  const btn = document.getElementById("btn-save-itinerary");
  if (!btn) return;
  const saved = isActiveTripSaved();
  btn.textContent = saved ? "✓ 자동 저장" : "저장";
  btn.title = saved ? "수정하면 자동으로 저장됩니다" : "내 일정에 저장";
  btn.classList.toggle("is-saved", saved);
}

// 출발일 + day → Date
function getTripDate(trip, day) {
  if (!trip || !trip.startDate) return null;
  const [y, m, d] = trip.startDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d + (day - 1));
}

function formatShortDate(date) {
  return `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAYS[date.getDay()]})`;
}

function isInKorea(lat, lng) {
  return lat > 33 && lat < 38.7 && lng > 124.5 && lng < 131;
}

// 구글 지도 길찾기 이동 수단 (장소별 이동 방법 → 여행 이동 수단 순)
function googleTravelMode(place, trip) {
  const m = (place.move && place.move.mode) || trip.transport || "auto";
  const map = { car: "driving", rental: "driving", taxi: "driving", walk: "walking", bike: "bicycling", bus: "transit", subway: "transit", train: "transit", transit: "transit" };
  return map[m] ? `&travelmode=${map[m]}` : "";
}

function getPlaceLinks(place) {
  const trip = state.activeTrip || {};
  const domestic = isInKorea(place.lat, place.lng);
  const q = place.coordMissing ? `${place.name} ${trip.destination || ""}`.trim() : place.name;
  const hasCoord = !place.coordMissing && isFinite(place.lat) && isFinite(place.lng);
  // 국내: 카카오맵 바로가기(좌표 기준), 해외: 구글 지도
  const kakaoName = encodeURIComponent(String(place.name).replace(/,/g, " "));
  const mapUrl = domestic
    ? (hasCoord ? `https://map.kakao.com/link/map/${kakaoName},${place.lat},${place.lng}` : `https://map.kakao.com/link/search/${encodeURIComponent(q)}`)
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const routeUrl = domestic
    ? (hasCoord ? `https://map.kakao.com/link/to/${kakaoName},${place.lat},${place.lng}` : `https://map.kakao.com/link/search/${encodeURIComponent(q)}`)
    : (hasCoord ? `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}` : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`) + googleTravelMode(place, trip);
  let searchUrl;
  if (place.category === "hotel") {
    searchUrl = place.bookingUrl || `https://www.agoda.com/search?q=${encodeURIComponent(place.name)}`;
  } else if (place.bookingUrl) {
    searchUrl = place.bookingUrl;
  } else {
    searchUrl = domestic
      ? `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`
      : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }
  return { mapUrl, routeUrl, searchUrl };
}

// --- 설정 화면 ---
function setupSettings() {
  const keyInput = document.getElementById("setting-api-key");
  const modelInput = document.getElementById("setting-model");
  const statusEl = document.getElementById("settings-status");

  document.getElementById("btn-toggle-key-visibility").addEventListener("click", (e) => {
    const show = keyInput.type === "password";
    keyInput.type = show ? "text" : "password";
    e.target.textContent = show ? "숨기기" : "보기";
  });

  const save = () => {
    window.RoutyAI.saveSettings({
      apiKey: keyInput.value.trim(),
      model: modelInput.value.trim() || window.RoutyAI.DEFAULT_MODEL
    });
    updateAiNotice();
  };

  const kakaoInput = document.getElementById("setting-kakao-key");
  const kakaoStatus = document.getElementById("kakao-status");
  const naverInput = document.getElementById("setting-naver-key");
  document.getElementById("btn-save-kakao").addEventListener("click", () => {
    const naverKey = naverInput.value.trim();
    const kakaoKey = kakaoInput.value.trim();
    const placesKey = document.getElementById("setting-places-key").value.trim();
    const placesSort = document.getElementById("setting-places-sort").value;
    window.RoutyAI.saveSettings({ naverKey, kakaoKey, placesKey, placesSort });
    const home = document.getElementById("setting-origin").value.trim();
    try { localStorage.setItem("routy_origin", home || DEFAULT_ORIGIN); } catch (e) {}
    renderTemplates();
    topCache.clear();
    failedEngines.delete("naver");
    failedEngines.delete("kakao");
    kakaoStatus.className = "settings-status ok";
    kakaoStatus.textContent = naverKey ? "저장했습니다. 국내 일정은 네이버 지도로 표시돼요."
      : kakaoKey ? "저장했습니다. 국내 일정은 카카오맵으로 표시돼요."
      : "저장했습니다. 모든 일정이 OpenFreeMap으로 표시돼요.";
  });

  document.getElementById("btn-save-settings").addEventListener("click", () => {
    save();
    statusEl.textContent = keyInput.value.trim() ? "✅ 저장했습니다." : "API 키를 지웠습니다. 샘플 일정만 생성됩니다.";
    statusEl.className = "settings-status ok";
    renderSettingsExtras();
  });

  document.getElementById("btn-test-settings").addEventListener("click", async () => {
    save();
    statusEl.textContent = "⏳ 연결 확인 중...";
    statusEl.className = "settings-status";
    try {
      await window.RoutyAI.testApiKey();
      statusEl.textContent = "✅ 연결 성공! 이제 AI 플래너를 사용할 수 있어요.";
      statusEl.className = "settings-status ok";
    } catch (e) {
      statusEl.textContent = `❌ ${e.message}`;
      statusEl.className = "settings-status error";
    }
  });

  // 백업 / 복원
  document.getElementById("btn-export-data").addEventListener("click", () => {
    const payload = {
      app: "routy",
      version: 2,
      exportedAt: new Date().toISOString(),
      trips: state.savedTrips
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `routy-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    showToast(`일정 ${state.savedTrips.length}개를 백업했습니다.`);
  });

  const fileInput = document.getElementById("input-import-file");
  document.getElementById("btn-import-data").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const trips = Array.isArray(data) ? data : data.trips;
      if (!Array.isArray(trips)) throw new Error("형식 오류");
      let added = 0, updated = 0;
      trips.forEach(t => {
        if (!t || !t.id || !Array.isArray(t.places)) return;
        ensureTripShape(t);
        const i = state.savedTrips.findIndex(s => s.id === t.id);
        if (i > -1) { state.savedTrips[i] = t; updated++; }
        else { state.savedTrips.push(t); added++; }
      });
      saveToLocalStorage();
      renderSettingsTab();
      showToast(`불러오기 완료: 새 일정 ${added}개, 갱신 ${updated}개`);
    } catch (e) {
      showToast("백업 파일을 읽지 못했습니다. 어디가(Routy) 백업 파일인지 확인해 주세요.", 4000);
    }
  });

  document.getElementById("btn-clear-data").addEventListener("click", async () => {
    if (!state.savedTrips.length) {
      showToast("삭제할 일정이 없습니다.");
      return;
    }
    if (!(await uiConfirm(`저장된 일정 ${state.savedTrips.length}개를 모두 삭제할까요? 되돌릴 수 없습니다.`, { okText: "모두 삭제", danger: true }))) return;
    state.savedTrips = [];
    saveToLocalStorage();
    renderSettingsTab();
    showToast("모든 일정을 삭제했습니다.");
  });
}

function renderSettingsTab() {
  renderSettingsExtras();
  const s = window.RoutyAI.getSettings();
  document.getElementById("setting-api-key").value = s.apiKey;
  document.getElementById("setting-model").value = s.model;
  document.getElementById("setting-kakao-key").value = s.kakaoKey || "";
  document.getElementById("setting-naver-key").value = s.naverKey || "";
  document.getElementById("setting-places-key").value = s.placesKey || "";
  const ver = document.getElementById("app-version");
  if (ver) ver.textContent = APP_VERSION;
  document.getElementById("setting-places-sort").value = s.placesSort || "rating";
  try { document.getElementById("setting-origin").value = localStorage.getItem("routy_origin") || DEFAULT_ORIGIN; } catch (e) {}
  document.getElementById("places-limit").textContent = window.RoutyAI.PLACES_DAILY_LIMIT;
  document.getElementById("places-usage").textContent = s.placesKey ? `(오늘 ${window.RoutyAI.placesUsage().n}회 사용)` : "";
  const statusEl = document.getElementById("settings-status");
  if (statusEl && !statusEl.textContent) {
    statusEl.textContent = s.apiKey ? "API 키가 등록되어 있습니다." : "";
  }
  const stats = document.getElementById("settings-stats");
  if (stats) {
    const placeCount = state.savedTrips.reduce((n, t) => n + (t.places || []).length, 0);
    stats.innerHTML = `<span>저장된 일정 <strong>${state.savedTrips.length}</strong>개</span><span>장소 <strong>${placeCount}</strong>곳</span>`;
  }
}

function renderSettingsExtras() {
  const ai = document.getElementById("ai-state");
  if (ai) {
    const ok = window.RoutyAI.hasApiKey();
    ai.className = "ai-state " + (ok ? "ok" : "no");
    ai.textContent = ok ? "연결됨" : "키 필요";
  }
  const th = document.getElementById("set-theme-state");
  if (th) th.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "켜짐" : "꺼짐";
  const sn = document.getElementById("set-senior-state");
  if (sn) sn.textContent = ["보통", "크게", "더 크게", "아주 크게", "최대"][state.fontSizeStep || 0] || "보통";
}

function setupSettingsExtras() {
  const t = document.getElementById("btn-set-theme");
  if (t) t.addEventListener("click", () => { document.getElementById("btn-quick-theme").click(); renderSettingsExtras(); });
  const sn = document.getElementById("btn-set-senior");
  if (sn) sn.addEventListener("click", () => { document.getElementById("btn-header-senior").click(); renderSettingsExtras(); });
  const origin = document.getElementById("setting-origin");
  if (origin) origin.addEventListener("change", () => {
    try { localStorage.setItem("routy_origin", origin.value.trim() || DEFAULT_ORIGIN); } catch (e) {}
    renderTemplates();
    showToast(`사는 곳을 '${origin.value.trim() || DEFAULT_ORIGIN}'(으)로 저장했어요.`);
  });
}

function updateAiNotice() {
  const hasKey = window.RoutyAI.hasApiKey();
  const notice = document.getElementById("ai-key-notice");
  const label = document.getElementById("btn-generate-label");
  if (notice) notice.style.display = hasKey ? "none" : "flex";
  if (label) label.textContent = hasKey ? "AI 일정 생성하기" : "샘플 일정 만들기";
}

// --- 마스코트 '구름이' 인사 ---
const MASCOT_TIPS = [
  ["지도에서 핀을 콕 누르면 그곳 코스가 나와요!", "happy"],
  ["식당은 제가 근처 별점 1위로 골라 둘게요 🍜", "wink"],
  ["매운 거 못 드시면 AI 플래너 3단계에서 알려 주세요!", "happy"],
  ["표를 예매했으면 시간만 넣어 주세요. 일정을 맞춰 드려요 🎫", "wink"],
  ["매달 1일엔 새 추천 코스가 도착해요 ✨", "wow"],
  ["일정 카드의 '길안내'를 누르면 네이버 지도로 바로 가요 🧭", "happy"]
];
let mascotTipIdx = -1;
function greetingText() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return ["좋은 아침이에요! 오늘은 어디로 떠나 볼까요?", "happy"];
  if (h >= 11 && h < 17) return ["어디가 볼까요? 지도에서 콕 찍어 봐요!", "wink"];
  if (h >= 17 && h < 23) return ["저녁이에요~ 다음 여행 계획 세워 볼까요?", "happy"];
  return ["늦은 밤엔 여행 상상이 최고죠 ✨", "sleep"];
}
function renderHomeGreet() {
  const box = document.getElementById("home-greet");
  if (!box) return;
  const [text, mood] = mascotTipIdx < 0 ? greetingText() : MASCOT_TIPS[mascotTipIdx];
  box.innerHTML = window.mascotSay(esc(text), mood, 64);
  const btn = box.querySelector(".mascot-btn");
  btn.addEventListener("click", () => {
    mascotTipIdx = (mascotTipIdx + 1) % MASCOT_TIPS.length;
    renderHomeGreet();
    const m = document.querySelector("#home-greet .mascot");
    if (m) { m.classList.remove("hop"); void m.getBoundingClientRect(); m.classList.add("hop"); }
  });
}
function renderPlannerGreet() {
  const box = document.getElementById("planner-greet");
  if (box && !box.innerHTML) box.innerHTML = window.mascotSay("어디로 갈지 알려 주면 제가 일정을 짜 볼게요!", "wink", 56);
}

// --- Explore Tab: Templates Render ---
function renderExploreTab() { renderHomeGreet(); }

function setupExploreSearch() {
  const searchInput = document.getElementById("explore-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderTemplates();
    });
  }
}

// --- 홈 화면: 추천 코스 지도 (해안선 일러스트 + 핀) ---
// 해안선: Natural Earth 1:50m (world-atlas, 공공 데이터)을 단순화해 mapdata.js에 넣어 둠
// 국내 지도(한국 확대) / 해외 지도(일본·중국 동부·대만)
function homeMapOf(region) {
  const d = (window.HOME_MAP_DATA || {})[region] || (window.HOME_MAP_DATA || {}).overseas;
  if (!d) return null;
  if (!d.kx) {
    const [lng0, lng1, lat0, lat1] = d.bbox;
    d.kx = d.W / (lng1 - lng0);
    d.ky = d.kx / Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
    d.lng0 = lng0; d.lat1 = lat1;
  }
  return d;
}
// 사는 곳(출발 도시) 기본값. 2026.7 출범한 전남광주특별시(약칭 광주특별시)
const DEFAULT_ORIGIN = "광주";
function homeOrigin() {
  const name = (() => { try { return localStorage.getItem("routy_origin"); } catch (e) { return ""; } })() || DEFAULT_ORIGIN;
  const key = Object.keys(CITY_COORDS).find(k => name.includes(k)) || DEFAULT_ORIGIN;
  return { name: key, lat: CITY_COORDS[key][0], lng: CITY_COORDS[key][1] };
}
let homeMapPick = null;
let homePage = 1; // 1: 이달의 추천(지도), 2: 지난 추천
let homeRegion = (() => { try { return localStorage.getItem("routy_home_region") || "domestic"; } catch (e) { return "domestic"; } })();

// 코스가 국내인지 해외인지 (지정이 없으면 위치로 판단)
function tplRegion(t) {
  if (t && (t.region === "domestic" || t.region === "overseas")) return t.region;
  const c = templateCenter(t);
  return c && isInKorea(c.lat, c.lng) ? "domestic" : "overseas";
}

// 추천 묶음: 최신 달 묶음이 1페이지, 나머지(+처음 기본 추천)는 2페이지
function recoBatches(region) {
  const inRegion = list => region ? list.filter(t => tplRegion(t) === region) : list;
  const monthly = (window.MONTHLY_RECOS || [])
    .filter(b => b && b.month && Array.isArray(b.templates) && b.templates.length)
    .slice().sort((a, b) => String(b.month).localeCompare(String(a.month)))
    .map(b => Object.assign({}, b, { templates: inRegion(b.templates) }))
    .filter(b => b.templates.length);
  const base = { month: "", label: "처음 추천", templates: inRegion(Object.values(window.PREDEFINED_TEMPLATES || {})) };
  if (!monthly.length) return { current: Object.assign({}, base, { label: "추천 코스" }), past: [] };
  const label = b => `${Number(b.month.slice(5, 7))}월 추천${b.month.slice(0, 4) !== String(new Date().getFullYear()) ? ` (${b.month.slice(0, 4)})` : ""}`;
  const withLabel = monthly.map(b => Object.assign({ label: label(b) }, b));
  return { current: withLabel[0], past: withLabel.slice(1).concat(base.templates.length ? [base] : []) };
}
function tplTheme(t) {
  const th = t && t.theme;
  return th && th.c1 && th.c2 ? { c1: th.c1, c2: th.c2, emoji: th.emoji || "✈️" } : destTheme(t && t.destination);
}

function homeMapXY(lat, lng, map) {
  return [(lng - map.lng0) * map.kx, (map.lat1 - lat) * map.ky];
}
function templateCenter(t) {
  const first = String(t.destination || "").split("/")[0].trim();
  const table = typeof DEFAULT_COORDINATES !== "undefined" ? DEFAULT_COORDINATES : {};
  const known = table[first] || table[t.destination];
  if (known) return known;
  const pts = (t.places || []).filter(p => p.category !== "transit" && isFinite(p.lat) && isFinite(p.lng));
  if (!pts.length) return null;
  return { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length };
}

function templateCardEl(template) {
  const card = document.createElement("div");
  card.className = "template-card";
  const styleText = template.style === "active" ? "액티비티" : "힐링";
  const budgetLabel = template.budget === "high" ? "럭셔리" : template.budget === "low" ? "가성비" : "일반";
  const th = tplTheme(template);
  card.innerHTML = `
    ${state.seniorMode ? "" : `<div class="tpl-cover" style="--c1:${th.c1};--c2:${th.c2}">
      <span class="tpl-art" aria-hidden="true">${th.emoji}</span>
      <span class="tpl-place">${esc(template.destination.replaceAll('/', ' · '))}</span>
      <span class="tpl-days">${template.duration > 1 ? `${template.duration - 1}박 ${template.duration}일` : "당일"}</span>
    </div>`}
    <h3>${esc(template.title.split(' (')[0])}</h3>
    <div class="template-meta-geo">${esc(template.destination.replaceAll('/', ' · '))} · ${template.duration}일</div>
    ${state.seniorMode ? '' : `<p class="template-desc-single">${esc(template.description)}</p>`}
    <div class="template-meta-style">${styleText} · ${budgetLabel}</div>
    <div class="tpl-go">이 코스로 일정 만들기 →</div>
  `;
  // 출발지·날짜·인원·도착 공항·일수를 먼저 정하고 일정 열기
  card.addEventListener("click", () => openTemplateSetup(template));
  return card;
}

function renderHomeMap(list, matchKeys) {
  const wrap = document.getElementById("dest-map-wrap");
  if (!wrap) return;
  const HOME_MAP = homeMapOf(homeRegion);
  if (!HOME_MAP) { wrap.innerHTML = ""; return; }
  const HOME_MAP_ORIGIN = homeOrigin();
  const pins = list.map(t => {
    const c = templateCenter(t);
    if (!c) return null;
    const [x, y] = homeMapXY(c.lat, c.lng, HOME_MAP);
    const manual = Array.isArray(t.pinNudge) ? t.pinNudge : null;
    const [dx, dy] = manual || [0, 0];
    const inside = x > 6 && x < HOME_MAP.W - 6 && y > 6 && y < HOME_MAP.H - 6;
    return { t, x, y, bx: x + dx, by: y + dy, manual: !!manual, inside, th: tplTheme(t), on: !matchKeys || matchKeys.has(t.id) };
  }).filter(Boolean);
  // 지도 밖 코스는 칩으로만. 핀(말풍선+이름표)이 서로·출발 표시와 겹치지 않게 밀어낸다
  const shown = pins.filter(p => p.inside);
  const [ox0, oy0] = homeMapXY(HOME_MAP_ORIGIN.lat, HOME_MAP_ORIGIN.lng, HOME_MAP);
  const fixed = [{ bx: ox0, by: oy0 + 10 }]; // 출발 점 + 위쪽 이름표
  const RX = 64, RY = 86; // 핀 하나가 차지하는 너비·높이(지도 단위)
  const hits = (x, y, others) => others.some(q => Math.hypot((x - q.bx) / RX, (y - q.by) / RY) < 1);
  const fits = (x, y) => x >= 28 && x <= HOME_MAP.W - 28 && y >= 84 && y <= HOME_MAP.H - 4;
  // 실제 위치에서 가까운 빈자리부터: 그대로 → 아래(바다 쪽) → 옆 → 위
  const SPOTS = [[0, 0], [44, 52], [-44, 52], [70, 10], [-70, 10], [0, 92], [80, 70], [-80, 70], [60, -60], [-60, -60], [0, -90], [110, 30], [-110, 30]];
  const placed = fixed.slice();
  shown.forEach(p => {
    if (p.manual) { placed.push(p); return; }
    const spot = SPOTS.find(([dx, dy]) => fits(p.x + dx, p.y + dy) && !hits(p.x + dx, p.y + dy, placed)) || [0, 0];
    p.bx = p.x + spot[0]; p.by = p.y + spot[1];
    placed.push(p);
  });
  const [ox, oy] = homeMapXY(HOME_MAP_ORIGIN.lat, HOME_MAP_ORIGIN.lng, HOME_MAP);
  const arc = (x, y) => {
    const mx = (ox + x) / 2, my = (oy + y) / 2 - Math.min(70, Math.hypot(x - ox, y - oy) * 0.35);
    return `M${ox.toFixed(0)} ${oy.toFixed(0)} Q${mx.toFixed(0)} ${my.toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)}`;
  };
  const { W, H } = HOME_MAP;
  const pct = (v, total) => (v / total * 100).toFixed(2) + "%";
  wrap.innerHTML = `
    <div class="dest-map" style="aspect-ratio:${W}/${H};max-width:min(760px, ${(64 * W / H).toFixed(1)}vh)">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <pattern id="dm-waves" width="28" height="14" patternUnits="userSpaceOnUse">
            <path d="M0 10 Q7 6 14 10 T28 10" fill="none" class="dm-wave"/>
          </pattern>
        </defs>
        <rect width="${W}" height="${H}" class="dm-sea"/>
        <rect width="${W}" height="${H}" fill="url(#dm-waves)"/>
        ${Object.entries(HOME_MAP.land).map(([k, d]) => `<path d="${d}" class="dm-land ${(HOME_MAP.main || ["KR"]).includes(k) ? "main" : "far"}"/>`).join("")}
        ${(HOME_MAP.seas || []).map(([name, lat, lng]) => { const [sx, sy] = homeMapXY(lat, lng, HOME_MAP); return `<text x="${sx.toFixed(0)}" y="${sy.toFixed(0)}" class="dm-sea-name" text-anchor="middle">${esc(name)}</text>`; }).join("")}
        ${shown.map(p => `<path d="${arc(p.x, p.y)}" class="dm-route ${p.on ? "" : "off"} ${homeMapPick === p.t.id ? "pick" : ""}"/>`).join("")}
        ${shown.map(p => (Math.abs(p.bx - p.x) > 1 || Math.abs(p.by - p.y) > 1) ? `<line x1="${p.x.toFixed(0)}" y1="${p.y.toFixed(0)}" x2="${p.bx.toFixed(0)}" y2="${p.by.toFixed(0)}" class="dm-leader"/>` : "").join("")}
        ${shown.map(p => `<circle cx="${p.x.toFixed(0)}" cy="${p.y.toFixed(0)}" r="4" class="dm-dot ${p.on ? "" : "off"}"/>`).join("")}
        <circle cx="${ox.toFixed(0)}" cy="${oy.toFixed(0)}" r="6" class="dm-origin"/>
      </svg>
      <span class="dm-origin-label" style="left:${pct(ox, W)};top:${pct(oy, H)}">${HOME_MAP_ORIGIN.name} 출발</span>
      ${shown.map(p => `
        <button type="button" class="dm-pin ${p.on ? "" : "off"} ${homeMapPick === p.t.id ? "pick" : ""}" data-tpl="${esc(p.t.id)}"
          style="left:${pct(p.bx, W)};top:${pct(p.by, H)};--c1:${p.th.c1};--c2:${p.th.c2}"
          aria-label="${esc(p.t.destination)} 코스 보기">
          <span class="dm-pin-name">${esc(p.t.destination.split("/")[0])}</span>
          <span class="dm-pin-emoji"><i>${p.th.emoji}</i></span>
        </button>`).join("")}
    </div>
    <div class="dm-chips" role="tablist">
      ${pins.map(p => `<button type="button" role="tab" class="dm-chip ${homeMapPick === p.t.id ? "pick" : ""} ${p.on ? "" : "off"}" data-tpl="${esc(p.t.id)}" aria-selected="${homeMapPick === p.t.id}">${p.th.emoji} ${esc(p.t.destination.replaceAll("/", "·"))}</button>`).join("")}
    </div>
  `;
  wrap.querySelectorAll("[data-tpl]").forEach(b => b.addEventListener("click", () => {
    homeMapPick = b.dataset.tpl;
    renderTemplates();
  }));
  const chip = wrap.querySelector(".dm-chip.pick");
  if (chip) chip.parentElement.scrollTo({ left: chip.offsetLeft - 8, behavior: "smooth" });
}

function renderRegionTabs() {
  const box = document.getElementById("home-region");
  if (!box) return;
  const n = r => { const b = recoBatches(r); return b.current.templates.length; };
  box.innerHTML = `
    <button type="button" class="region-tab ${homeRegion === "domestic" ? "on" : ""}" data-region="domestic">🇰🇷 국내 <small>${n("domestic")}</small></button>
    <button type="button" class="region-tab ${homeRegion === "overseas" ? "on" : ""}" data-region="overseas">✈️ 해외 <small>${n("overseas")}</small></button>`;
  box.querySelectorAll("[data-region]").forEach(b => b.addEventListener("click", () => {
    if (homeRegion === b.dataset.region) return;
    homeRegion = b.dataset.region;
    try { localStorage.setItem("routy_home_region", homeRegion); } catch (e) {}
    homePage = 1;
    homeMapPick = null;
    renderTemplates();
  }));
}

function renderHomeTabs(batches) {
  const tabs = document.getElementById("home-tabs");
  const title = document.getElementById("home-section-title");
  if (title) title.textContent = homePage === 2 ? "지난 추천" : (batches.current.label === "추천 코스" ? "지도에서 골라 보기" : batches.current.label);
  const sub = document.getElementById("home-section-sub");
  if (sub) sub.textContent = homePage === 2 ? "예전에 나왔던 코스도 그대로 열 수 있어요" : (batches.current.headline || "핀을 누르면 그곳 코스가 나와요");
  if (!tabs) return;
  if (!batches.past.length) { tabs.innerHTML = ""; tabs.hidden = true; homePage = 1; return; }
  tabs.hidden = false;
  const pastCount = batches.past.reduce((n, b) => n + b.templates.length, 0);
  tabs.innerHTML = `
    <button type="button" class="home-tab ${homePage === 1 ? "on" : ""}" data-page="1">1 · ${esc(batches.current.label)}</button>
    <button type="button" class="home-tab ${homePage === 2 ? "on" : ""}" data-page="2">2 · 지난 추천 <span class="home-tab-n">${pastCount}</span></button>`;
  tabs.querySelectorAll("[data-page]").forEach(b => b.addEventListener("click", () => {
    homePage = Number(b.dataset.page);
    renderTemplates();
  }));
}

function matchesQuery(t, query) {
  return !query || [t.destination, t.title, t.description].some(v => String(v || "").toLowerCase().includes(query));
}

function renderTemplates() {
  const container = document.getElementById("templates-container");
  if (!container) return;
  container.innerHTML = "";
  container.classList.add("single");

  const searchInput = document.getElementById("explore-search-input");
  const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
  renderRegionTabs();
  const batches = recoBatches(homeRegion);
  if (!batches.past.length) homePage = 1;
  renderHomeTabs(batches);
  const mapWrap = document.getElementById("dest-map-wrap");

  if (homePage === 2) {
    if (mapWrap) mapWrap.innerHTML = "";
    container.classList.remove("single");
    container.classList.add("past-list");
    let n = 0;
    batches.past.forEach(b => {
      const list = b.templates.filter(t => matchesQuery(t, query));
      if (!list.length) return;
      const h = document.createElement("h3");
      h.className = "past-month";
      h.textContent = b.label;
      container.appendChild(h);
      list.forEach(t => { container.appendChild(templateCardEl(t)); n++; });
    });
    if (!n) renderNoResult(container, query, searchInput);
    return;
  }
  container.classList.remove("past-list");

  const all = batches.current.templates;
  const matches = all.filter(t => matchesQuery(t, query));
  const matchKeys = query ? new Set(matches.map(t => t.id)) : null;
  if (matches.length && !matches.some(t => t.id === homeMapPick)) homeMapPick = matches[0].id;
  renderHomeMap(all, matchKeys);

  if (matches.length) {
    const pick = matches.find(t => t.id === homeMapPick) || matches[0];
    container.appendChild(templateCardEl(pick));
    return;
  }
  const inPast = query && batches.past.some(b => b.templates.some(t => matchesQuery(t, query)));
  const other = homeRegion === "domestic" ? "overseas" : "domestic";
  const ob = recoBatches(other);
  const inOther = query && [ob.current].concat(ob.past).some(b => b.templates.some(t => matchesQuery(t, query)));
  renderNoResult(container, query, searchInput, inPast, inOther ? other : "");
}

function renderNoResult(container, query, searchInput, inPast, otherRegion) {
  const noResult = document.createElement("div");
  noResult.className = "no-search-results";
  noResult.innerHTML = `
    <div class="no-results-icon">${window.icon("search", 32)}</div>
    <p>"<strong>${esc(query)}</strong>"에 맞는 추천 코스가 여기엔 없어요.</p>
    ${otherRegion ? `<button class="btn btn-sm btn-secondary" style="margin-top:10px" id="btn-search-region">${otherRegion === "overseas" ? "해외" : "국내"} 추천에서 보기</button>` : inPast ? `<button class="btn btn-sm btn-secondary" style="margin-top:10px" id="btn-search-past">지난 추천에서 보기</button>` : `<span>AI 플래너에서 바로 일정을 만들어 보세요!</span>`}
    <button class="btn btn-sm btn-primary" style="margin-top:12px" id="btn-explore-to-planner">"${esc(query)}" AI로 일정 만들기</button>
  `;
  container.appendChild(noResult);
  const reg = document.getElementById("btn-search-region");
  if (reg) reg.addEventListener("click", () => { homeRegion = otherRegion; try { localStorage.setItem("routy_home_region", homeRegion); } catch (e) {} homePage = 1; homeMapPick = null; renderTemplates(); });
  const past = document.getElementById("btn-search-past");
  if (past) past.addEventListener("click", () => { homePage = 2; renderTemplates(); });
  const go = document.getElementById("btn-explore-to-planner");
  if (go) go.addEventListener("click", () => {
    document.getElementById("input-destination").value = searchInput.value.trim();
    switchTab("planner");
  });
}

function loadItineraryTemplate(template, opts = {}) {
  // Setup current active trip deep-cloning places
  const days = opts.days || template.duration;
  let places = JSON.parse(JSON.stringify(template.places)).filter(p => (p.day || 1) <= days);
  state.activeTrip = {
    id: `template-${template.id}-${Date.now()}`,
    source: "template",
    summary: template.description,
    title: template.title,
    destination: template.destination,
    days,
    budget: template.budget,
    style: template.style,
    origin: opts.origin || undefined,
    startDate: opts.startDate || undefined,
    people: opts.people || undefined,
    arrivalAirport: opts.airport || undefined,
    places
  };
  ensurePlacePrices(state.activeTrip);
  if (!state.activeTrip.meals) state.activeTrip.meals = loadMealPref();
  const meals = ensureMeals(state.activeTrip);
  state.activeTripDay = 1;

  // Jump to itinerary view
  showItineraryView();
  const mealNote = meals.length ? ` 빠진 끼니 ${meals.length}개(${mealSummary(meals)})도 넣었어요.` : "";
  showToast(days > template.duration
    ? `${template.destination} 일정을 열었어요. 늘어난 ${days - template.duration}일은 비어 있으니 아래 수정 요청으로 채워 보세요.${mealNote}`
    : `${template.destination} 추천 일정을 열었어요.${mealNote}`, 5000);
}

// --- 추천 테마 설정 창: 출발 도시·출발 날짜·인원·도착 공항·여행 일수 ---
let tplSetupTemplate = null;
const AIRPORT_ALTS = { HND: ["NRT"], NRT: ["HND"], TPE: ["TSA"], TSA: ["TPE"], BKK: ["DMK"], DMK: ["BKK"], KIX: ["ITM"], PVG: ["SHA"], ICN: ["GMP"] };
const AIRPORT_NAMES = { KIX: "간사이", ITM: "이타미(오사카)", NRT: "나리타", HND: "하네다", FUK: "후쿠오카", CTS: "신치토세(삿포로)", OKA: "나하(오키나와)",
  NGO: "주부(나고야)", TPE: "타오위안(타이베이)", TSA: "쑹산(타이베이)", HKG: "홍콩", BKK: "수완나품(방콕)", DMK: "돈므앙(방콕)", DAD: "다낭", CXR: "깜라인(나트랑)",
  HAN: "하노이", SGN: "호치민", CEB: "세부", SIN: "싱가포르", DPS: "발리", GUM: "괌", CJU: "제주", PUS: "김해(부산)", GMP: "김포", ICN: "인천",
  PVG: "푸둥(상하이)", SHA: "훙차오(상하이)", TAO: "칭다오", KHH: "가오슝", PEK: "베이징" };

function templateAirports(template) {
  const texts = [template.destination].concat(template.places.filter(isAirportPlace).map(p => p.name)).join(" ");
  const codes = [];
  WORLD_AIRPORTS.forEach(([re, code]) => { if (re.test(texts) && !codes.includes(code)) codes.push(code); });
  Object.entries(AIRPORT_CODES).forEach(([k, code]) => { if (texts.includes(k) && !codes.includes(code) && code !== "ICN" && code !== "GMP") codes.push(code); });
  // 공항 카드에 나온 공항을 맨 앞으로
  const first = template.places.find(isAirportPlace);
  const firstCode = first ? guessAirport(first.name) : "";
  if (firstCode) codes.splice(codes.indexOf(firstCode), 1), codes.unshift(firstCode);
  (AIRPORT_ALTS[codes[0]] || []).forEach(c => { if (!codes.includes(c)) codes.push(c); });
  return codes;
}

function openTemplateSetup(template) {
  tplSetupTemplate = template;
  const $ = id => document.getElementById(id);
  $("tpl-setup-title").textContent = template.title.split(" (")[0];
  $("tpl-setup-desc").textContent = `${template.destination.replaceAll("/", " · ")} · 기본 ${template.duration}일. 넣은 값으로 항공권·숙소·기차 예매 버튼이 날짜와 인원까지 채워져 열려요.`;
  try { $("tpl-origin").value = localStorage.getItem("routy_origin") || ""; } catch (e) {}
  const t = new Date(); t.setDate(t.getDate() + 14);
  $("tpl-start").value = "";
  $("tpl-start").min = ymd(new Date());
  $("tpl-start").placeholder = ymd(t);
  $("tpl-days").innerHTML = Array.from({ length: 10 }, (_, i) => i + 1)
    .map(n => `<option value="${n}" ${n === template.duration ? "selected" : ""}>${n}일${n === template.duration ? " (기본)" : ""}</option>`).join("");
  $("tpl-people").innerHTML = Array.from({ length: 10 }, (_, i) => i + 1)
    .map(n => `<option value="${n}" ${n === 2 ? "selected" : ""}>${n}명</option>`).join("");
  const tplKind = tripKind({ destination: template.destination, title: template.title, places: template.places });
  const airports = tplKind === "inland" ? [] : templateAirports(template);
  $("tpl-airport-group").style.display = airports.length ? "" : "none";
  $("tpl-airport").innerHTML = airports.map(c => `<option value="${c}">${AIRPORT_NAMES[c] || c} (${c})</option>`).join("");
  updateTplDaysNote();
  $("template-setup-overlay").classList.add("active");
}

function updateTplDaysNote() {
  const t = tplSetupTemplate;
  if (!t) return;
  const n = parseInt(document.getElementById("tpl-days").value, 10);
  const el = document.getElementById("tpl-days-note");
  el.textContent = n < t.duration ? `${t.duration - n}일을 줄이면 뒤쪽 날짜의 일정이 빠져요.`
    : n > t.duration ? `늘어난 ${n - t.duration}일은 빈 날로 추가돼요. 일정을 연 뒤 'AI 수정 요청'으로 채울 수 있어요.` : "";
}

function setupTemplateSetup() {
  const $ = id => document.getElementById(id);
  const overlay = $("template-setup-overlay");
  if (!overlay) return;
  const close = () => overlay.classList.remove("active");
  $("btn-close-tpl-setup").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  $("tpl-days").addEventListener("change", updateTplDaysNote);
  $("btn-tpl-skip").addEventListener("click", () => { close(); loadItineraryTemplate(tplSetupTemplate); });
  $("btn-tpl-apply").addEventListener("click", () => {
    const origin = rememberOrigin($("tpl-origin").value.trim());
    close();
    loadItineraryTemplate(tplSetupTemplate, {
      origin,
      startDate: $("tpl-start").value || undefined,
      people: parseInt($("tpl-people").value, 10) || 2,
      days: parseInt($("tpl-days").value, 10) || tplSetupTemplate.duration,
      airport: $("tpl-airport-group").style.display === "none" ? undefined : $("tpl-airport").value
    });
  });
}

// --- Planner: Destinations Autocomplete Suggestions ---
const POPULAR_DESTINATIONS = ["제주도", "경주", "부산", "서울", "도쿄", "교토", "오사카", "파리", "뉴욕", "다낭", "방콕", "싱가포르", "로마", "바르셀로나"];

function setupSuggestions() {
  const input = document.getElementById("input-destination");
  const suggestionsBox = document.getElementById("destination-suggestions");
  
  if (!input || !suggestionsBox) return;

  input.addEventListener("input", () => {
    const val = input.value.trim().toLowerCase();
    suggestionsBox.innerHTML = "";
    
    if (!val) {
      suggestionsBox.style.display = "none";
      return;
    }

    const matches = POPULAR_DESTINATIONS.filter(dest => dest.toLowerCase().includes(val));
    
    if (matches.length > 0) {
      matches.forEach(match => {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.textContent = match;
        item.addEventListener("click", () => {
          input.value = match;
          suggestionsBox.style.display = "none";
        });
        suggestionsBox.appendChild(item);
      });
      suggestionsBox.style.display = "block";
    } else {
      suggestionsBox.style.display = "none";
    }
  });

  // Close suggestions box on outside click
  document.addEventListener("click", (e) => {
    if (e.target !== input) {
      suggestionsBox.style.display = "none";
    }
  });
}

// --- Planner: Style tags (다중 선택) ---
function setupStyleTags() {
  document.querySelectorAll(".style-tags-container .style-tag").forEach(tag => {
    tag.addEventListener("click", () => {
      tag.classList.toggle("active");
      if (!document.querySelector(".style-tags-container .style-tag.active")) {
        tag.classList.add("active");
      }
    });
  });
}

// --- Planner: AI Itinerary Generator form ---
let generateController = null;
let generateCancelledByUser = false;

const PARTY_PEOPLE = { "혼자": 1, "연인/배우자와 둘이서": 2, "친구들과": 3, "어린 자녀가 있는 가족": 4, "부모님(어르신) 모시고, 걷는 양을 줄여서": 3 };

// --- 플래너: 일정에 넣을 식사 (아침: 숙소 조식/근처 맛집/안 넣음, 점심, 저녁) ---
const MEAL_PREF_KEY = "routy_meal_pref";
function loadMealPref() {
  try {
    const v = JSON.parse(localStorage.getItem(MEAL_PREF_KEY) || "null");
    if (v && typeof v === "object") return { breakfast: v.breakfast === false ? false : (v.breakfast === "out" ? "out" : "hotel"), lunch: v.lunch !== false, dinner: v.dinner !== false };
  } catch (e) {}
  return { breakfast: "hotel", lunch: true, dinner: true };
}
function readMealPicker() {
  const on = k => !!document.querySelector(`#meal-picker [data-meal="${k}"].on`);
  const bf = (document.querySelector("#meal-breakfast-sub .seg-btn.on") || {}).dataset?.bf || "hotel";
  return { breakfast: on("breakfast") ? bf : false, lunch: on("lunch"), dinner: on("dinner") };
}
function renderMealPicker(pref) {
  document.querySelectorAll("#meal-picker [data-meal]").forEach(b => {
    const v = pref[b.dataset.meal];
    b.classList.toggle("on", !!v);
    b.setAttribute("aria-pressed", v ? "true" : "false");
  });
  document.querySelectorAll("#meal-breakfast-sub [data-bf]").forEach(b => b.classList.toggle("on", b.dataset.bf === (pref.breakfast || "hotel")));
  const sub = document.getElementById("meal-breakfast-sub");
  if (sub) sub.hidden = !pref.breakfast;
}
function setupMealPicker() {
  if (!document.getElementById("meal-picker")) return;
  let pref = loadMealPref();
  renderMealPicker(pref);
  const save = () => { try { localStorage.setItem(MEAL_PREF_KEY, JSON.stringify(pref)); } catch (e) {} renderMealPicker(pref); };
  document.querySelectorAll("#meal-picker [data-meal]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.meal;
    pref = readMealPicker();
    pref[k] = k === "breakfast" ? (pref.breakfast ? false : ((document.querySelector("#meal-breakfast-sub .seg-btn.on") || {}).dataset?.bf || "hotel")) : !pref[k];
    save();
  }));
  document.querySelectorAll("#meal-breakfast-sub [data-bf]").forEach(b => b.addEventListener("click", () => {
    pref = readMealPicker();
    pref.breakfast = b.dataset.bf;
    save();
  }));
}

// --- 플래너: '이미 예매했어요' (가는 편·오는 편 시각) ---
function bookedModeFor(dest) {
  const kind = tripKind({ destination: dest || "", title: "", places: [] });
  if (kind !== "inland") return "flight";
  const c = cityStops(String(dest || "").split(/[\/,·]/)[0]);
  if (c && !c.train) return "express";
  // 서울이 아닌 곳에서 다른 노선 도시로 가면(예: 광주→부산) 직통 KTX가 없어 고속버스가 보통
  const origin = originCity(null);
  const oc = /서울/.test(origin) ? null : cityStops(origin);
  if (c && oc && oc.line !== c.line) return "express";
  return "train";
}

function setBookedMode(mode) {
  document.querySelectorAll("#booked-mode .seg-btn").forEach(b => {
    b.classList.toggle("on", b.dataset.mode === mode);
    b.setAttribute("aria-checked", b.dataset.mode === mode ? "true" : "false");
  });
  const ph = { flight: ["편명 (선택) 예: 7C1301", "편명 (선택) 예: 7C1302"], train: ["열차 번호 (선택) 예: KTX 501", "열차 번호 (선택) 예: KTX 520"], express: ["버스 회사·번호 (선택)", "버스 회사·번호 (선택)"] }[mode];
  document.getElementById("bk-out-no").placeholder = ph[0];
  document.getElementById("bk-ret-no").placeholder = ph[1];
}

function setupBookedBox() {
  const box = document.getElementById("booked-box");
  if (!box) return;
  let touched = false;
  document.querySelectorAll("#booked-mode .seg-btn").forEach(b => b.addEventListener("click", () => { touched = true; setBookedMode(b.dataset.mode); }));
  const dest = document.getElementById("input-destination");
  const sync = () => { if (!touched) setBookedMode(bookedModeFor(dest.value)); };
  dest.addEventListener("change", sync);
  dest.addEventListener("blur", sync);
  box.addEventListener("toggle", sync);
  // 자가용이면 예매할 게 없으니 숨김
  document.querySelectorAll("#transport-picker .transport-opt").forEach(b => b.addEventListener("click", () => {
    box.hidden = b.dataset.transport === "car";
  }));
}

function readBookedBox() {
  const box = document.getElementById("booked-box");
  if (!box || box.hidden) return null;
  const v = id => (document.getElementById(id).value || "").trim();
  const leg = k => ({ dep: v(`bk-${k}-dep`), arr: v(`bk-${k}-arr`), no: v(`bk-${k}-no`).toUpperCase() });
  const out = leg("out"), ret = leg("ret");
  if (!out.dep && !out.arr && !ret.dep && !ret.arr) return null;
  const mode = (document.querySelector("#booked-mode .seg-btn.on") || {}).dataset?.mode || "flight";
  return { mode, out, ret };
}

function clearBookedBox() {
  ["out", "ret"].forEach(k => ["dep", "arr", "no"].forEach(f => { const el = document.getElementById(`bk-${k}-${f}`); if (el) el.value = ""; }));
  const box = document.getElementById("booked-box");
  if (box) box.open = false;
}

// 기차·버스 예매 시각을 역·터미널 장소에 반영 (AI 없이, 시간·설명만)
function setGroundTimes(trip, out, ret) {
  const ic = trip.intercity;
  if (!ic) return;
  ic.times = { out, ret };
  const outP = trip.places.find(p => p.intercity === "out");
  const backP = trip.places.find(p => p.intercity === "back");
  if (outP && out && out.arr) {
    const a = hhmmToMin(out.arr);
    outP.time = `${out.arr} - ${minutesToHHMM(a + 20)}`;
    if (outP.move) { outP.move.note = out.no || ""; const dm = a - hhmmToMin(out.dep); if (out.dep && dm > 0) outP.move.minutes = dm; }
    outP.description = `${out.no ? out.no + " · " : ""}${out.dep ? `${ic.from} ${out.dep} 출발 → ` : ""}${out.arr} 도착`;
  }
  if (backP && ret && ret.dep) {
    const dp = hhmmToMin(ret.dep);
    backP.time = `${minutesToHHMM(dp - 20)} - ${ret.dep}`;
    backP.description = `${ret.no ? ret.no + " · " : ""}${ret.dep} 출발${ret.arr ? ` → ${ic.from} ${ret.arr} 도착` : ""}`;
  }
  const pickP = trip.places.find(p => p.intercity === "pick"), dropP = trip.places.find(p => p.intercity === "drop");
  if (pickP && outP) { const r = parseTimeRange(outP.time); if (r) pickP.time = `${minutesToHHMM(r[1])} - ${minutesToHHMM(r[1] + 30)}`; }
  if (dropP && backP) { const r = parseTimeRange(backP.time); if (r) dropP.time = `${minutesToHHMM(r[0] - 40)} - ${minutesToHHMM(r[0] - 10)}`; }
}

// 새로 만든 일정에 플래너에서 넣은 예매 시각을 기록 → 티켓에 '예매 완료', 다시 맞추기 창에도 채워짐
function applyBookedToTrip(trip, booked) {
  if (!trip || !booked) return;
  if (booked.mode === "flight") {
    const legs = flightLegs(trip);
    const ft = legs.length ? flightTrip(trip, legs[0].place) : synthFlightTrip(trip, null);
    if (!ft) return;
    const mk = (b, leg) => leg && b && (b.dep || b.arr) ? Object.assign({}, b, { from: leg.from, to: leg.to, day: leg.day }) : null;
    trip.flights = { out: mk(booked.out, ft.out), ret: mk(booked.ret, ft.ret) };
    if (!trip.flights.out && !trip.flights.ret) delete trip.flights;
    else if (!trip.flights.out) trip.flights.out = { from: ft.out.from, to: ft.out.to, day: ft.out.day };
  } else if (tripKind(trip) === "inland") {
    const dest = cityStops((trip.destination || "").split(/[\/,·]/)[0]);
    if (!dest || !dest[booked.mode]) return;
    applyIntercity(booked.mode);
    setGroundTimes(trip, booked.out, booked.ret);
    sortTripPlaces(trip, 1);
    if (trip.days > 1) sortTripPlaces(trip, trip.days);
    refineUndoTrip = null;
    recentlyChanged = new Set();
    setRefineMode("normal");
  }
  persistActiveTrip();
  renderItineraryAll();
}

function setupPlannerForm() {
  const form = document.getElementById("planner-form");
  const cancelBtn = document.getElementById("btn-cancel-generate");
  if (!form) return;
  setupStyleTags();

  setupSpendPicker("spend-picker");
  setupBudgetInputs("input-budget", () => parseInt(document.getElementById("input-people").value, 10) || 1);

  document.querySelectorAll("#transport-picker .transport-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#transport-picker .transport-opt").forEach(b => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-checked", b === btn ? "true" : "false");
      });
    });
  });

  setupBookedBox();
  setupMealPicker();

  const partySel = document.getElementById("input-party");
  const peopleSel = document.getElementById("input-people");
  partySel.addEventListener("change", () => {
    peopleSel.value = String(PARTY_PEOPLE[partySel.value] || 2);
    updateBudgetSum("input-budget");
  });
  peopleSel.addEventListener("change", () => updateBudgetSum("input-budget"));

  cancelBtn.addEventListener("click", () => {
    if (generateController) {
      generateCancelledByUser = true;
      generateController.abort();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = {
      destination: document.getElementById("input-destination").value.trim(),
      origin: rememberOrigin(document.getElementById("input-origin").value.trim()),
      days: parseInt(document.getElementById("input-duration").value, 10),
      budget: getSpendValue("spend-picker"),
      budgetPlan: readBudgetInputs("input-budget"),
      party: partySel.value,
      people: parseInt(peopleSel.value, 10) || 1,
      transport: (document.querySelector("#transport-picker .transport-opt.active") || {}).dataset?.transport || "auto",
      startDate: document.getElementById("input-start-date").value,
      wake: document.getElementById("input-wake").value || "",
      request: document.getElementById("input-request").value.trim(),
      booked: readBookedBox(),
      meals: readMealPicker(),
      styles: Array.from(document.querySelectorAll(".style-tags-container .style-tag.active")).map(t => t.getAttribute("data-style"))
    };
    if (input.styles.length === 0) input.styles.push("relaxing");
    if (!input.destination) {
      showToast("여행 목적지를 입력해 주세요.");
      return;
    }
    // '골라서 짜기'면 일정 대신 후보 목록부터
    if (window.getPlanMode && window.getPlanMode() === "pick") {
      await window.startPickPlanner(input);
      return;
    }
    const trip = await runGeneration(input);
    if (trip) {
      document.getElementById("input-destination").value = "";
      document.getElementById("input-request").value = "";
      clearBookedBox();
      if (window.plannerGoStep) window.plannerGoStep(1);
      state.activeTrip = trip;
      state.activeTripDay = 1;
      applyBookedToTrip(trip, input.booked);
      saveDraft();
      showItineraryView();
      if (trip.source === "ai") {
        autoPickTop(trip).then(() => verifyCoordinates(trip.id, trip.places.map(p => p.id)));
      }
      showToast(trip.source === "ai" ? "초안이 나왔어요. 마음에 들면 '저장', 아니면 '다시 만들기'를 누르세요." : "샘플 일정을 만들었습니다.", 4000);
    }
  });
}

// 입력값으로 일정 생성 (성공 시 trip, 실패/취소 시 null)
async function runGeneration(input) {
  const loadingOverlay = document.getElementById("planner-loading-overlay");
  const lm = document.getElementById("loading-mascot");
  if (lm && !lm.innerHTML) lm.innerHTML = window.mascotSvg("think", 120);
  const statusText = document.getElementById("loading-status-text");
  const elapsedEl = document.getElementById("loading-elapsed");
  const cancelBtn = document.getElementById("btn-cancel-generate");
  const useAI = window.RoutyAI.hasApiKey();

  // 로딩 화면이 어느 탭에서든 보이도록 body로 옮김
  document.body.appendChild(loadingOverlay);
  loadingOverlay.classList.add("active", "floating");
  cancelBtn.style.display = useAI ? "" : "none";

  const messages = useAI
    ? ["여행지 정보를 모으는 중...", "실제 장소와 동선을 고르는 중...", "시간표와 예상 비용을 계산하는 중...", "거의 다 됐어요. 일정을 다듬는 중..."]
    : ["샘플 일정을 만드는 중..."];
  let msgIdx = 0;
  let progressShown = false;
  statusText.textContent = messages[0];
  elapsedEl.textContent = "";
  const t0 = Date.now();
  const ticker = setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    elapsedEl.textContent = `${sec}초 경과`;
    if (!progressShown && sec > 0 && sec % 6 === 0 && msgIdx < messages.length - 1) {
      msgIdx++;
      statusText.textContent = messages[msgIdx];
    }
  }, 1000);
  const onProgress = (p) => {
    if (p.phase === "thinking" && !progressShown) {
      statusText.textContent = "AI가 동선을 구상하는 중...";
    } else if (p.phase === "writing") {
      progressShown = true;
      statusText.textContent = p.places ? `일정 작성 중 · 장소 ${p.places}곳` : "일정 작성 시작...";
    }
  };

  const base = {
    id: `trip-${Date.now()}`,
    destination: input.destination,
    origin: input.origin || DEFAULT_ORIGIN,
    days: input.days,
    budget: input.budget,
    budgetPlan: input.budgetPlan,
    style: input.styles[0],
    styles: input.styles,
    party: input.party,
    people: input.people,
    transport: input.transport || "auto",
    startDate: input.startDate,
    wake: input.wake ? Object.fromEntries(Array.from({ length: input.days }, (_, i) => [i + 1, input.wake])) : undefined,
    request: input.request,
    meals: input.meals,
    genInput: input,
    createdAt: Date.now()
  };

  try {
    let trip;
    if (useAI) {
      generateController = new AbortController();
      generateCancelledByUser = false;
      try {
        const plan = await window.RoutyAI.generateTrip(input, { signal: generateController.signal, onProgress });
        trip = Object.assign(base, {
          title: plan.title || `${input.destination} ${input.days}일 여행`,
          summary: plan.summary,
          places: plan.places,
          checklistSeed: plan.tips,
          source: "ai"
        });
      } finally {
        /* 타임아웃은 ai.js가 응답 끊김 기준으로 처리 */
      }
    } else {
      await sleep(900);
      trip = Object.assign(base, {
        title: `[샘플] ${input.destination} ${input.days}일 여행`,
        summary: "API 키 없이 만든 샘플 일정입니다. 설정에서 Gemini 키를 등록하면 실제 장소로 일정을 짜 줍니다.",
        places: window.generateItinerary(input.destination, input.days, input.budget, input.styles[0]),
        source: "sample"
      });
    }
    ensureTripShape(trip);
    ensurePlacePrices(trip);
    ensureMeals(trip);
    return trip;
  } catch (err) {
    if (generateCancelledByUser) showToast("일정 생성을 취소했습니다.");
    else {
      console.error(err);
      showToast(err.message || "일정 생성 중 오류가 발생했습니다.", 5000);
    }
    return null;
  } finally {
    clearInterval(ticker);
    generateController = null;
    loadingOverlay.classList.remove("active", "floating");
  }
}

// 같은 조건으로 다시 생성 (초안 상태에서)
async function regenerateActiveTrip() {
  const t = state.activeTrip;
  if (!t || !t.genInput) return;
  const ok = await uiConfirm("같은 조건으로 일정을 새로 만들까요? 지금 초안은 바뀝니다. (되돌리기 가능)", { okText: "다시 만들기" });
  if (!ok) return;
  const before = cloneTrip(t);
  const input = Object.assign({}, t.genInput, { startDate: t.startDate, people: t.people, transport: t.transport || "auto", budget: t.budget, budgetPlan: t.budgetPlan });
  const fresh = await runGeneration(input);
  if (!fresh) return;
  fresh.id = t.id;
  state.activeTrip = fresh;
  state.activeTripDay = 1;
  renderItineraryAll();
  persistActiveTrip();
  if (fresh.source === "ai") autoPickTop(fresh).then(() => verifyCoordinates(fresh.id, fresh.places.map(p => p.id)));
  showToast("새 일정을 만들었어요.", 6000, {
    label: "이전 초안으로",
    onClick: () => {
      state.activeTrip = before;
      renderItineraryAll();
      persistActiveTrip();
    }
  });
}

// Helper: Parse time string (e.g. "14:00 - 15:00", "오전 9:30", "오후 2시") into absolute minutes for sorting
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 9999;
  
  let str = timeStr.trim();
  
  // Extract start time only if duration range exists
  if (str.includes('-')) {
    str = str.split('-')[0].trim();
  }
  if (str.includes('~')) {
    str = str.split('~')[0].trim();
  }
  
  let isPM = false;
  if (str.includes("오후") || str.toUpperCase().includes("PM")) {
    isPM = true;
  }
  
  // Extract digits
  const numbers = str.match(/\d+/g);
  if (!numbers) return 9999; // Default to end of day if no numbers found
  
  let hours = parseInt(numbers[0], 10);
  let minutes = numbers[1] ? parseInt(numbers[1], 10) : 0;
  
  // Convert 12-hour format to 24-hour minutes
  if (isPM && hours < 12) {
    hours += 12;
  } else if (!isPM && hours === 12 && (str.includes("오전") || str.toUpperCase().includes("AM"))) {
    hours = 0;
  }
  
  return hours * 60 + minutes;
}

// --- 장소 검색 UI (OpenStreetMap) ---
function setupPlaceSearch({ inputId, buttonId, resultsId, pickedId }) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(buttonId);
  const results = document.getElementById(resultsId);
  const pickedEl = document.getElementById(pickedId);
  let picked = null;

  const renderPicked = () => {
    pickedEl.innerHTML = picked
      ? `위치 지정됨: ${esc(picked.address || picked.name)} <button type="button" class="link-btn" data-clear>해제</button>`
      : "";
  };

  pickedEl.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-clear")) {
      picked = null;
      renderPicked();
    }
  });

  const run = async () => {
    const q = input.value.trim();
    if (!q) {
      showToast("검색할 장소 이름을 입력해 주세요.");
      return;
    }
    results.innerHTML = `<div class="place-search-msg">검색 중...</div>`;
    const near = state.activeTrip && state.activeTrip.places.length
      ? { lat: state.activeTrip.places[0].lat, lng: state.activeTrip.places[0].lng }
      : null;
    try {
      let list = await window.RoutyAI.searchPlaces(q, near);
      if (!list.length && state.activeTrip && state.activeTrip.destination) {
        list = await window.RoutyAI.searchPlaces(`${q} ${state.activeTrip.destination}`, near);
      }
      if (!list.length) {
        results.innerHTML = `<div class="place-search-msg">검색 결과가 없어요. 영어/현지어 이름으로도 시도해 보세요.</div>`;
        return;
      }
      results.innerHTML = "";
      list.forEach(r => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "place-search-item";
        item.innerHTML = `<strong>${esc(r.name)}</strong><span>${esc(r.address)}</span>`;
        item.addEventListener("click", () => {
          picked = r;
          results.innerHTML = "";
          renderPicked();
        });
        results.appendChild(item);
      });
    } catch (e) {
      results.innerHTML = `<div class="place-search-msg">${esc(e.message)}</div>`;
    }
  };

  btn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });

  return {
    getPicked: () => picked,
    reset: () => {
      picked = null;
      results.innerHTML = "";
      renderPicked();
    }
  };
}

let addPlaceSearch = null;
let editPlaceSearch = null;
let refineUndoTrip = null;

// AI 수정 요청을 적용 (scopeDay가 있으면 그날만 교체). 바뀐 장소 id 집합을 돌려준다
async function applyAIRefine(instruction, scopeDay, opts = {}) {
  const plan = await window.RoutyAI.refineTrip(state.activeTrip, instruction, { day: scopeDay, onProgress: opts.onProgress });
  const t = state.activeTrip;
  if (!opts.keepUndo) refineUndoTrip = cloneTrip(t);
  const oldPlaces = scopeDay ? t.places.filter(p => p.day === scopeDay) : t.places;
  const oldKeys = new Set(oldPlaces.map(p => `${p.day}|${p.name}|${p.time}`));
  let incoming = plan.places;
  if (scopeDay) {
    // AI가 다른 날까지 돌려주면 그 날 것만 사용
    const sameDay = incoming.filter(p => p.day === scopeDay);
    if (sameDay.length) incoming = sameDay;
    incoming.forEach(p => { p.day = scopeDay; });
    // 그 날만 교체하고 나머지 날은 그대로
    const merged = [];
    let inserted = false;
    t.places.forEach(p => {
      if (p.day === scopeDay) {
        if (!inserted) { merged.push(...incoming); inserted = true; }
      } else merged.push(p);
    });
    if (!inserted) merged.push(...incoming);
    t.places = merged;
    sortTripPlaces(t, scopeDay);
  } else {
    // 전체 수정: 이름이 같은 장소는 기존 id·메모를 유지
    const byName = new Map(t.places.map(p => [p.name, p]));
    incoming.forEach(p => {
      const prev = byName.get(p.name);
      if (prev) {
        p.id = prev.id;
        if (prev.coordFixed && !p.coordMissing) { p.lat = prev.lat; p.lng = prev.lng; p.coordFixed = true; }
      }
    });
    t.places = incoming;
    // AI가 일수를 늘렸으면 반영
    const maxDay = Math.max(...incoming.map(p => p.day));
    if (maxDay > t.days) t.days = maxDay;
  }
  if (plan.summary && !scopeDay) t.summary = plan.summary;
  if (plan.tips && plan.tips.length) t.checklistSeed = plan.tips;
  ensureTripShape(t);
  ensurePlacePrices(t);
  markIntercityEdges(t);
  return new Set(incoming.filter(p => !oldKeys.has(`${p.day}|${p.name}|${p.time}`)).map(p => p.id));
}

function setRefineMode(mode) {
  const btn = document.getElementById("btn-ai-refine");
  if (!btn) return;
  btn.dataset.mode = mode === "undo" ? "undo" : "";
  btn.textContent = mode === "undo" ? "되돌리기" : "수정";
  btn.classList.toggle("btn-undo", mode === "undo");
}

// --- Itinerary View: Back, Save & Tab actions ---
function setupItineraryControls() {
  document.getElementById("btn-itinerary-back").addEventListener("click", () => {
    const fallback = isActiveTripSaved() ? "trips" : (state.activeTrip && state.activeTrip.source === "template" ? "explore" : "planner");
    goBack(fallback);
  });

  const toggleEditBtn = document.getElementById("btn-toggle-edit-mode");
  if (toggleEditBtn) {
    toggleEditBtn.addEventListener("click", () => {
      state.editMode = !state.editMode;
      const timelineContainer = document.getElementById("timeline-places-container");
      if (timelineContainer) timelineContainer.classList.toggle("edit-mode-active", state.editMode);
      toggleEditBtn.classList.toggle("active", state.editMode);
      toggleEditBtn.textContent = state.editMode ? "완료" : "편집";
    });
  }

  document.getElementById("btn-save-itinerary").addEventListener("click", () => {
    if (!state.activeTrip) return;
    const wasSaved = isActiveTripSaved();
    if (wasSaved) {
      persistActiveTrip();
    } else {
      if (state.activeTrip.source === "template" || state.activeTrip.source === "shared") {
        // 템플릿/공유 일정은 새 id로 내 일정에 복사
        state.activeTrip.id = `trip-${Date.now()}`;
        state.activeTrip.source = state.activeTrip.source === "shared" ? "shared-saved" : "template-saved";
      }
      state.activeTrip.createdAt = state.activeTrip.createdAt || Date.now();
      state.savedTrips.unshift(cloneTrip(state.activeTrip));
      saveToLocalStorage();
      clearDraft();
      history.replaceState({ routy: true }, "", currentRouteFor("itinerary"));
      renderItineraryAll();
    }
    renderSidebarTrips();
    showToast(wasSaved ? "변경 사항은 자동으로 저장되고 있어요." : "내 일정에 저장했어요. 이제부터 수정하면 자동 저장됩니다.", 3000);
  });

  // 빠른 도구
  setupTripMenu();

  // AI 수정 요청
  const refineForm = document.getElementById("ai-refine-form");
  const refineInput = document.getElementById("ai-refine-input");
  const refineBtn = document.getElementById("btn-ai-refine");
  refineForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (refineBtn.dataset.mode === "undo") return;
    const instruction = refineInput.value.trim();
    if (!instruction || !state.activeTrip) return;
    if (!window.RoutyAI.hasApiKey()) {
      showToast("AI 수정은 설정에서 Gemini API 키를 등록해야 사용할 수 있어요.", 3500);
      return;
    }
    refineBtn.disabled = true;
    refineInput.disabled = true;
    refineBtn.textContent = "수정 중...";
    refineForm.classList.add("loading");
    const scopeDay = refineScope === "day" ? state.activeTripDay : null;
    try {
      recentlyChanged = await applyAIRefine(instruction, scopeDay, {
        onProgress: (p) => {
          if (p.phase === "writing" && p.places) refineBtn.textContent = `${p.places}곳…`;
          else if (p.phase === "thinking") refineBtn.textContent = "구상 중…";
        }
      });
      const t = state.activeTrip;
      const changedCount = recentlyChanged.size;
      refineInput.value = "";
      renderItineraryAll();
      persistActiveTrip();
      setRefineMode("undo");
      verifyCoordinates(t.id, Array.from(recentlyChanged));
      showToast(changedCount ? `${changedCount}곳이 바뀌었어요 ('AI 변경' 표시). 마음에 안 들면 '되돌리기'를 누르세요.` : "바뀐 장소가 없어요. 요청을 조금 더 구체적으로 적어 보세요.", 4000);
    } catch (err) {
      showToast(err.message || "수정 중 오류가 발생했습니다.", 5000);
    } finally {
      refineBtn.disabled = false;
      refineInput.disabled = false;
      refineForm.classList.remove("loading");
      if (refineBtn.dataset.mode !== "undo") setRefineMode("normal");
    }
  });

  const scopeBtn = document.getElementById("btn-refine-scope");
  scopeBtn.addEventListener("click", () => {
    refineScope = refineScope === "day" ? "all" : "day";
    updateRefineScopeLabel();
  });

  refineBtn.addEventListener("click", (ev) => {
    if (refineBtn.dataset.mode !== "undo") return;
    ev.preventDefault();
    if (refineUndoTrip) {
      state.activeTrip = refineUndoTrip;
      refineUndoTrip = null;
      recentlyChanged = new Set();
      renderItineraryAll();
      persistActiveTrip();
      showToast("수정 전 일정으로 되돌렸습니다.");
    }
    setRefineMode("normal");
  });
  refineInput.addEventListener("input", () => {
    if (refineBtn.dataset.mode === "undo") setRefineMode("normal");
  });

  // 장소 추가 Drawer
  const toggleBtn = document.getElementById("btn-toggle-add-place");
  const drawer = document.getElementById("add-place-drawer");
  addPlaceSearch = setupPlaceSearch({
    inputId: "add-place-name",
    buttonId: "btn-add-place-search",
    resultsId: "add-place-results",
    pickedId: "add-place-picked"
  });

  toggleBtn.addEventListener("click", () => {
    drawer.classList.add("active");
    toggleBtn.classList.add("hidden");
    document.getElementById("add-place-name").focus();
  });
  document.getElementById("btn-cancel-add-place").addEventListener("click", closeAddPlaceDrawer);

  document.getElementById("btn-confirm-add-place").addEventListener("click", () => {
    const name = document.getElementById("add-place-name").value.trim();
    const time = window.RoutyAI.normalizeTime(document.getElementById("add-place-time").value.trim()) || "시간 미정";
    const category = document.getElementById("add-place-cat").value;
    const desc = document.getElementById("add-place-desc").value.trim();
    const priceInput = document.getElementById("add-place-price").value.trim();

    if (!name) {
      showToast("장소 이름을 입력해주세요.");
      return;
    }

    let price = priceInput ? parseInt(priceInput, 10) : NaN;
    if (isNaN(price) || price < 0) price = getDeterministicPrice(name, category, state.activeTrip.budget);

    const picked = addPlaceSearch.getPicked();
    let lat, lng, coordMissing = false;
    if (picked) {
      lat = picked.lat;
      lng = picked.lng;
    } else {
      const ref = state.activeTrip.places.find(p => p.day === state.activeTripDay) || state.activeTrip.places[0];
      lat = ref ? ref.lat : 37.5665;
      lng = ref ? ref.lng : 126.978;
      coordMissing = true;
    }

    const newPlace = {
      day: state.activeTripDay,
      id: `custom-${Date.now()}`,
      name, time, lat, lng, coordMissing, category, price,
      priceUnit: category === "hotel" ? "group" : "person",
      description: desc
    };

    // 시간 순서에 맞게 삽입 (숙소는 항상 마지막)
    const activeDayPlaces = state.activeTrip.places.filter(p => p.day === state.activeTripDay);
    const newTimeVal = parseTimeToMinutes(newPlace.time);
    let target = null;
    for (const p of activeDayPlaces) {
      if (category !== "hotel" && p.category === "hotel") { target = p; break; }
      const pt = parseTimeToMinutes(p.time);
      if (newTimeVal !== 9999 && pt !== 9999 && newTimeVal < pt) { target = p; break; }
    }
    if (target) {
      state.activeTrip.places.splice(state.activeTrip.places.indexOf(target), 0, newPlace);
    } else {
      const last = activeDayPlaces[activeDayPlaces.length - 1];
      const idx = last ? state.activeTrip.places.indexOf(last) + 1 : state.activeTrip.places.length;
      state.activeTrip.places.splice(idx, 0, newPlace);
    }

    closeAddPlaceDrawer();
    renderTimeline();
    updateMapMarkers();
    persistActiveTrip();
    showToast(picked ? "장소를 추가했습니다." : "장소를 추가했습니다. (위치 미지정 — 지도에는 대략적으로 표시)", 3000);
  });
}

function closeAddPlaceDrawer() {
  const toggleBtn = document.getElementById("btn-toggle-add-place");
  const drawer = document.getElementById("add-place-drawer");
  drawer.classList.remove("active");
  toggleBtn.classList.remove("hidden");
  ["add-place-name", "add-place-time", "add-place-price", "add-place-desc"].forEach(id => {
    document.getElementById(id).value = "";
  });
  if (addPlaceSearch) addPlaceSearch.reset();
}

// --- 장소 편집 모달 ---
let editingPlaceId = null;

function setupPlaceEditModal() {
  const overlay = document.getElementById("place-edit-modal-overlay");
  editPlaceSearch = setupPlaceSearch({
    inputId: "edit-place-name",
    buttonId: "btn-edit-place-search",
    resultsId: "edit-place-results",
    pickedId: "edit-place-picked"
  });
  const close = () => {
    overlay.classList.remove("active");
    editingPlaceId = null;
  };
  document.getElementById("btn-close-place-edit").addEventListener("click", close);
  document.getElementById("btn-cancel-place-edit").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  document.getElementById("btn-confirm-place-edit").addEventListener("click", () => {
    const place = state.activeTrip && state.activeTrip.places.find(p => p.id === editingPlaceId);
    if (!place) return close();
    const name = document.getElementById("edit-place-name").value.trim();
    if (!name) {
      showToast("장소 이름을 입력해 주세요.");
      return;
    }
    const before = cloneTrip(state.activeTrip);
    const oldTime = place.time;
    const oldDay = place.day;
    place.name = name;
    place.time = window.RoutyAI.normalizeTime(document.getElementById("edit-place-time").value.trim()) || "시간 미정";
    place.priceUnit = document.getElementById("edit-place-price-unit").value;
    const moveMode = document.getElementById("edit-move-mode").value;
    const moveMin = parseInt(document.getElementById("edit-move-min").value, 10);
    if (moveMode) {
      const moveCost = parseInt(document.getElementById("edit-move-cost").value, 10);
      place.move = {
        mode: moveMode,
        minutes: isFinite(moveMin) && moveMin > 0 ? moveMin : undefined,
        cost: isFinite(moveCost) && moveCost >= 0 ? moveCost : undefined,
        note: place.move && place.move.mode === moveMode ? place.move.note : ""
      };
      if (place.move && before.places) {
        const old = before.places.find(p => p.id === place.id);
        if (old && old.move && old.move.mode === moveMode) {
          ["from", "to", "service"].forEach(k => { if (old.move[k]) place.move[k] = old.move[k]; });
        }
      }
    } else {
      delete place.move;
    }
    place.day = parseInt(document.getElementById("edit-place-day").value, 10) || place.day;
    place.category = document.getElementById("edit-place-cat").value;
    const price = parseInt(document.getElementById("edit-place-price").value, 10);
    place.price = isNaN(price) || price < 0 ? 0 : price;
    place.description = document.getElementById("edit-place-desc").value.trim();
    const picked = editPlaceSearch.getPicked();
    if (picked) {
      place.lat = picked.lat;
      place.lng = picked.lng;
      place.coordMissing = false;
    }
    // 시간 변경분만큼 이후 일정 이동
    const shiftFollowing = document.getElementById("edit-shift-following").checked;
    const oldR = parseTimeRange(oldTime), newR = parseTimeRange(place.time);
    if (shiftFollowing && place.day === oldDay && oldR && newR && oldR[0] !== newR[0]) {
      const delta = newR[0] - oldR[0];
      const dayPlaces = state.activeTrip.places.filter(p => p.day === place.day);
      dayPlaces.slice(dayPlaces.indexOf(place) + 1).forEach(p => { p.time = shiftTimeString(p.time, delta); });
    }
    if (place.day !== oldDay || place.time !== oldTime) {
      // 다른 날로 옮기면 그날 맨 끝으로
      if (place.day !== oldDay) {
        state.activeTrip.places.splice(state.activeTrip.places.indexOf(place), 1);
        state.activeTrip.places.push(place);
      }
      sortTripPlaces(state.activeTrip, place.day);
    }
    close();
    renderItineraryAll();
    persistActiveTrip();
    showToast("장소 정보를 수정했습니다.", 6000, {
      label: "되돌리기",
      onClick: () => {
        state.activeTrip = before;
        renderItineraryAll();
        persistActiveTrip();
      }
    });
  });
}

function openPlaceEdit(placeId) {
  const place = state.activeTrip && state.activeTrip.places.find(p => p.id === placeId);
  if (!place) return;
  editingPlaceId = placeId;
  if (window.closeSeniorDetailModal) window.closeSeniorDetailModal();
  document.getElementById("edit-place-name").value = place.name || "";
  document.getElementById("edit-place-time").value = place.time || "";
  document.getElementById("edit-place-cat").value = place.category || "sightseeing";
  document.getElementById("edit-place-price").value = place.price || 0;
  document.getElementById("edit-place-price-unit").value = place.priceUnit === "group" ? "group" : "person";
  document.getElementById("edit-move-mode").value = place.move && place.move.mode ? place.move.mode : "";
  document.getElementById("edit-move-min").value = place.move && place.move.minutes ? place.move.minutes : "";
  document.getElementById("edit-move-cost").value = place.move && place.move.cost !== undefined ? place.move.cost : "";
  document.getElementById("edit-place-desc").value = place.description || "";
  const daySel = document.getElementById("edit-place-day");
  daySel.innerHTML = "";
  for (let d = 1; d <= state.activeTrip.days; d++) {
    const date = getTripDate(state.activeTrip, d);
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = `Day ${d}${date ? ` · ${formatShortDate(date)}` : ""}`;
    if (d === place.day) opt.selected = true;
    daySel.appendChild(opt);
  }
  editPlaceSearch.reset();
  document.getElementById("place-edit-modal-overlay").classList.add("active");
}

// 하루 일정을 시간순 정렬 (시간 미정은 상대 순서 유지, 숙소는 맨 끝)
function sortTripPlaces(trip, day) {
  const dayPlaces = trip.places.filter(p => p.day === day);
  const order = dayPlaces.map((p, i) => ({ p, i }));
  order.sort((a, b) => {
    const ah = a.p.category === "hotel" ? 1 : 0;
    const bh = b.p.category === "hotel" ? 1 : 0;
    if (ah !== bh) return ah - bh;
    const at = parseTimeToMinutes(a.p.time);
    const bt = parseTimeToMinutes(b.p.time);
    if (at !== 9999 && bt !== 9999 && at !== bt) return at - bt;
    return a.i - b.i;
  });
  const others = trip.places.filter(p => p.day !== day);
  const sorted = order.map(o => o.p);
  // 날짜 순서대로 재구성
  const result = [];
  for (let d = 1; d <= trip.days; d++) {
    if (d === day) result.push(...sorted);
    else result.push(...others.filter(p => p.day === d));
  }
  result.push(...others.filter(p => p.day < 1 || p.day > trip.days));
  trip.places = result;
}

function movePlace(placeId, dir) {
  const places = state.activeTrip.places;
  const place = places.find(p => p.id === placeId);
  if (!place) return;
  const dayPlaces = places.filter(p => p.day === place.day);
  const i = dayPlaces.indexOf(place);
  const j = i + dir;
  if (j < 0 || j >= dayPlaces.length) return;
  const a = places.indexOf(place);
  const b = places.indexOf(dayPlaces[j]);
  places[a] = dayPlaces[j];
  places[b] = place;
  renderTimeline();
  updateMapMarkers();
  persistActiveTrip();
}

function deletePlaceById(placeId) {
  const place = state.activeTrip.places.find(p => p.id === placeId);
  if (!place) return;
  if (window.closeSeniorDetailModal) window.closeSeniorDetailModal();
  let note = "";
  withUndo(() => `"${place.name}"을(를) 뺐어요.${note ? " " + note : ""}`, () => {
    note = redistributeAfterRemoval(state.activeTrip, place);
    state.activeTrip.places.splice(state.activeTrip.places.indexOf(place), 1);
  });
}

// 뺀 일정의 시간을 앞뒤 일정에 나눠 주기 (앞은 더 머물고, 뒤는 일찍 시작)
function redistributeAfterRemoval(trip, place) {
  const dayPlaces = trip.places.filter(p => p.day === place.day);
  const idx = dayPlaces.indexOf(place);
  const r = parseTimeRange(place.time);
  if (idx < 0 || !r) return "";
  const prev = dayPlaces[idx - 1], next = dayPlaces[idx + 1];
  const hasRange = p => p && ((p.time || "").match(/\d{1,2}:\d{2}/g) || []).length > 1;
  const flex = p => p && hasRange(p) && !["transit", "hotel"].includes(p.category) && !p.intercity;
  const prevR = prev && parseTimeRange(prev.time), nextR = next && parseTimeRange(next.time);
  const start = prevR ? prevR[1] : r[0];
  const end = nextR ? nextR[0] : r[1];
  const travel = prev && next ? 20 : 0; // 앞→뒤 장소로 바로 이동하는 시간
  let free = end - start - travel;
  if (free <= 0) return "";
  const CAP = 90; // 한 장소에 최대 1시간 30분까지만 늘리기
  let addPrev = 0, addNext = 0;
  if (flex(prev) && flex(next)) { addPrev = Math.min(CAP, Math.round(free / 2 / 5) * 5); addNext = Math.min(CAP, free - addPrev); }
  else if (flex(prev)) addPrev = Math.min(CAP, free);
  else if (flex(next)) addNext = Math.min(CAP, free);
  const parts = [];
  if (addPrev > 0) {
    prev.time = `${minutesToHHMM(prevR[0])} - ${minutesToHHMM(prevR[1] + addPrev)}`;
    parts.push(`앞 '${prev.name}' ${formatMinutes(addPrev)} 더 머물고`);
  }
  if (addNext > 0) {
    next.time = `${minutesToHHMM(nextR[0] - addNext)} - ${minutesToHHMM(nextR[1])}`;
    parts.push(`뒤 '${next.name}'은 ${formatMinutes(addNext)} 일찍 시작해요`);
  }
  // 뒤 장소의 이동 정보는 뺀 장소에서 오는 기준이라 지우고 길찾기로 확인
  if (next && next.move && !["flight", "train", "express", "ferry"].includes(next.move.mode)) delete next.move;
  const left = free - addPrev - addNext;
  return parts.join(", ") + (parts.length ? "." : "") + (left >= 30 ? ` ${formatMinutes(left)}은 자유 시간으로 남겨 뒀어요.` : "");
}

// 타임라인 / 상세 모달 버튼 공통 처리
function setupPlaceActionDelegation() {
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-action=wake]") && state.activeTrip) { e.stopPropagation(); openWakeDialog(); return; }
    const dvb = e.target.closest("[data-action=driveblock], [data-action=drivefit], [data-action=drivenaver]");
    if (dvb && state.activeTrip) {
      e.stopPropagation();
      const a = dvb.getAttribute("data-action");
      if (a === "driveblock") {
        const key = `drive-${state.activeTrip.id}`;
        if (expandedFlights.has(key)) expandedFlights.delete(key); else expandedFlights.add(key);
        renderTimeline();
        ensureDriveEstimate(state.activeTrip).then(m => {
          const el = document.getElementById("drive-preview"), inp = document.getElementById("drive-min");
          if (el && m) el.textContent = `예상 운전 시간 약 ${formatMinutes(m)} (휴게소 포함, 교통 상황에 따라 달라요). 실제 시간은 아래 네이버 지도로 확인하고 고쳐 주세요.`;
          if (inp && m && !inp.value) inp.value = m;
        });
      } else if (a === "drivefit") fitTripToDrive();
      else openDriveNaver();
      return;
    }
    const lmb = e.target.closest("[data-action=localmode]");
    if (lmb && state.activeTrip) { e.stopPropagation(); setLocalMode(lmb.getAttribute("data-mode")); return; }
    const rs = e.target.closest("[data-action=rentalsite]");
    if (rs && state.activeTrip) { e.stopPropagation(); openRentalSite(rs.getAttribute("data-site")); return; }
    const gf = e.target.closest("[data-action=groundfit]");
    if (gf && state.activeTrip) { e.stopPropagation(); openGroundFit(); return; }
    const icm = e.target.closest("[data-action=icmode]");
    if (icm && state.activeTrip) {
      e.stopPropagation();
      applyIntercity(icm.getAttribute("data-mode"));
      return;
    }
    const pib = e.target.closest("[data-action=pinfo]");
    if (pib && state.activeTrip) {
      e.stopPropagation();
      const gid = pib.getAttribute("data-gid");
      const shown = expandedInfo.has(gid) || (placeInfo.get(gid) && !placeInfo.get(gid).error && !collapsedInfo.has(gid));
      if (shown) { expandedInfo.delete(gid); collapsedInfo.add(gid); } else { expandedInfo.add(gid); collapsedInfo.delete(gid); }
      renderTimeline();
      return;
    }
    const rb = e.target.closest("[data-action=railblock], [data-action=railsite]");
    if (rb && state.activeTrip) {
      e.stopPropagation();
      const day = parseInt(rb.getAttribute("data-day"), 10);
      if (rb.getAttribute("data-action") === "railblock") {
        const key = `rail-${state.activeTrip.id}-${day}`;
        if (expandedFlights.has(key)) expandedFlights.delete(key); else expandedFlights.add(key);
        renderTimeline();
      } else openRailSite(day, rb.getAttribute("data-site"));
      return;
    }
    const btn = e.target.closest("[data-action][data-id]");
    if (!btn || !state.activeTrip) return;
    e.stopPropagation();
    const id = btn.getAttribute("data-id");
    const place = state.activeTrip.places.find(p => p.id === id);
    if (!place) return;
    const action = btn.getAttribute("data-action");
    if (action === "map") window.open(getPlaceLinks(place).mapUrl, "_blank", "noopener");
    else if (action === "route" || action === "navi") startNavigation(place);
    else if (action === "search") window.open(getPlaceLinks(place).searchUrl, "_blank", "noopener");
    else if (action === "edit") openPlaceEdit(id);
    else if (action === "up") movePlace(id, -1);
    else if (action === "down") movePlace(id, 1);
    else if (action === "delete" || action === "remove") {
      deletePlaceById(id);
    }
    else if (action === "delay") askDelay(id);
    else if (action === "alts") toggleAlternatives(id);
    else if (action === "suggest") suggestAlternatives(id, btn);
    else if (action === "pick") pickAlternative(id, parseInt(btn.getAttribute("data-alt"), 10));
    else if (action === "more") {
      if (expandedMore.has(place.id)) expandedMore.delete(place.id); else expandedMore.add(place.id);
      renderTimeline();
    }
    else if (action === "ticket") openTicketSite(place);
    else if (action === "flights") {
      if (expandedFlights.has(place.id)) expandedFlights.delete(place.id); else expandedFlights.add(place.id);
      renderTimeline();
    }
    else if (action === "flightsite") openFlightSite(place, btn.getAttribute("data-site"));
    else if (action === "flightfit") openFlightFit(place);
    else if (action === "stays") {
      if (expandedStays.has(place.id)) expandedStays.delete(place.id); else expandedStays.add(place.id);
      renderTimeline();
    }
    else if (action === "staysite") openStaySite(place, btn.getAttribute("data-site"));
    else if (action === "naviroute") {
      const from = state.activeTrip.places.find(p => p.id === btn.getAttribute("data-from"));
      if (from) openNaverRoute(from, place);
    }
    else if (action === "top5") toggleTopPanel(id, btn);
    else if (action === "topsort") setTopSort(btn.getAttribute("data-sort"));
    else if (action === "toppick") pickTopPlace(id, btn.getAttribute("data-pid"));
    else if (action === "topmap") {
      const item = findTopItem(btn.getAttribute("data-pid"));
      if (item) window.open(item.mapsUri || getPlaceLinks(Object.assign({ category: "restaurant" }, item)).mapUrl, "_blank", "noopener");
    }
    else if (action === "altmap") {
      const alt = (place.alternatives || [])[parseInt(btn.getAttribute("data-alt"), 10)];
      if (alt) window.open(getPlaceLinks(Object.assign({ category: "restaurant" }, alt)).mapUrl, "_blank", "noopener");
    }
  });
}

// --- Itinerary: Screen Activation ---
function renderTripMeta() {
  const el = document.getElementById("trip-meta-row");
  if (!el || !state.activeTrip) return;
  const t = state.activeTrip;
  const start = getTripDate(t, 1);
  const range = start && t.days > 1 ? `~ ${formatShortDate(getTripDate(t, t.days))} · ` : "";
  const badge = t.source === "ai" ? `<span class="trip-source-badge ai">AI 생성</span>`
    : t.source === "sample" ? `<span class="trip-source-badge sample">샘플</span>`
    : t.source === "shared" ? `<span class="trip-source-badge shared">공유받음</span>`
    : t.source === "template" ? `<span class="trip-source-badge sample">템플릿</span>` : "";
  const th = destTheme(t.destination || t.title);
  const end = start && t.days > 1 ? getTripDate(t, t.days) : null;
  const dateTxt = start ? `${formatShortDate(start)}${end ? ` ~ ${formatShortDate(end)}` : ""} · ${t.days}일` : `날짜 정하기 · ${t.days}일`;
  const people = parseInt(t.people, 10) || 0;
  const cost = getTripCost(t);
  const total = cost.total;
  const moneyShort = total >= 10000 ? `₩${(Math.round(total / 1000) / 10).toLocaleString("ko-KR")}만` : formatWon(total);
  const transportEmoji = { car: "🚗", rental: "🚙", taxi: "🚕", walk: "🚶", transit: "🚌", auto: "🧭" }[t.transport || "auto"];
  el.innerHTML = `
    <div class="trip-cover" style="--c1:${th.c1};--c2:${th.c2}">
      <span class="cover-art" aria-hidden="true">${th.emoji}</span>
      <div class="cover-top">${badge}<span class="cover-kicker">${t.days > 1 ? `${t.days - 1}박 ${t.days}일` : "당일치기"}${t.party ? ` · ${esc(t.party.split(",")[0])}` : ""}</span></div>
      <div class="cover-dest">${esc((t.destination || t.title || "").replaceAll("/", " · "))}</div>
      <div class="cover-chips">
        <label class="cover-chip" title="출발일 지정">📅 <span>${dateTxt}</span><input type="date" id="trip-start-date-input" value="${esc(t.startDate || "")}" aria-label="출발일"></label>
        ${(people || cost.people) ? `<span class="cover-chip static">👥 <span>${people || cost.people}명</span></span>` : ""}
        <label class="cover-chip" title="이동 수단">${transportEmoji} <span>${TRANSPORT_LABELS[t.transport || "auto"]}</span><select id="trip-transport-select" aria-label="이동 수단">
          ${Object.entries(TRANSPORT_LABELS).map(([k, v]) => `<option value="${k}" ${(t.transport || "auto") === k ? "selected" : ""}>${v}</option>`).join("")}
        </select></label>
        <button type="button" class="cover-chip" id="cover-budget-chip">💰 <span>${moneyShort}</span></button>
      </div>
    </div>
    ${t.summary ? `<p class="trip-summary">${esc(t.summary)}</p>` : ""}
    ${!isActiveTripSaved() ? `
      <div class="draft-banner compact">
        <span>📝 ${t.source === "shared" ? "공유받은 일정" : t.source === "template" ? "추천 코스" : "저장 전 초안"}이에요. 마음에 들면 <b>저장</b>해서 내 여행에 담아요.</span>
        <div class="draft-actions">
          ${t.genInput && window.RoutyAI.hasApiKey() ? `<button type="button" class="chip-btn" id="btn-regenerate">${window.icon("undo", 16)}다시 만들기</button>` : ""}
          <button type="button" class="chip-btn chip-primary" id="btn-draft-save">${window.icon("check", 16)}저장</button>
        </div>
      </div>` : ""}
    <details class="budget-card ${budgetCardOpen ? "" : "cover-hidden"}" id="budget-card" ${budgetCardOpen ? "open" : ""}>${budgetCardHtml(t)}</details>
    <div class="verify-status" id="verify-status"></div>
  `;
  document.getElementById("cover-budget-chip").addEventListener("click", () => {
    budgetCardOpen = !budgetCardOpen;
    const bc = document.getElementById("budget-card");
    bc.open = budgetCardOpen;
    bc.classList.toggle("cover-hidden", !budgetCardOpen);
  });
  document.getElementById("btn-edit-budget").addEventListener("click", (e) => { e.preventDefault(); openBudgetModal(); });
  document.getElementById("budget-card").addEventListener("toggle", (e) => { budgetCardOpen = e.target.open; e.target.classList.toggle("cover-hidden", !e.target.open); });
  document.getElementById("trip-transport-select").addEventListener("change", (e) => changeTripTransport(e.target.value));
  const regen = document.getElementById("btn-regenerate");
  if (regen) regen.addEventListener("click", regenerateActiveTrip);
  const dsave = document.getElementById("btn-draft-save");
  if (dsave) dsave.addEventListener("click", () => document.getElementById("btn-save-itinerary").click());
  renderVerifyStatus();
  document.getElementById("trip-start-date-input").addEventListener("change", (e) => {
    state.activeTrip.startDate = e.target.value;
    renderItineraryAll();
    persistActiveTrip();
  });
}

// 오늘이 여행 기간이면 해당 Day 번호
function getTodayDay(trip) {
  const start = getTripDate(trip, 1);
  if (!start) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - start) / 86400000);
  return diff >= 0 && diff < trip.days ? diff + 1 : 0;
}

// 오늘 일정 중 지금 이후(또는 진행 중) 첫 장소
function getNextPlace(trip, day) {
  if (getTodayDay(trip) !== day) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const list = trip.places.filter(p => p.day === day);
  for (const p of list) {
    const r = parseTimeRange(p.time);
    if (r && r[1] > nowMin) return p;
  }
  return null;
}

function renderNextUp() {
  const box = document.getElementById("next-up-card");
  if (!box || !state.activeTrip) return;
  const next = getNextPlace(state.activeTrip, state.activeTripDay);
  if (!next) {
    box.innerHTML = "";
    return;
  }
  const r = parseTimeRange(next.time);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const label = r && r[0] <= nowMin ? "지금 일정" : "다음 일정";
  box.innerHTML = `
    <div class="nu-body">
      <div class="nu-label">${label}</div>
      <div class="nu-name">${esc(next.name)}</div>
      <div class="nu-time">${esc(next.time)}</div>
    </div>
    <div class="nu-buttons">
      <button class="nu-go" data-action="route" data-id="${esc(next.id)}">${window.icon("navigate", 18)}길찾기</button>
      <button class="nu-delay" data-action="delay" data-id="${esc(next.id)}">늦어짐</button>
    </div>
  `;
}

function renderSidebarTrips() {
  const box = document.getElementById("sidebar-trips");
  if (!box) return;
  if (!state.savedTrips.length) {
    box.innerHTML = "";
    return;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = state.savedTrips
    .filter(t => {
      const end = getTripDate(t, t.days);
      return !end || end >= today;
    })
    .sort((a, b) => (a.startDate || "9999").localeCompare(b.startDate || "9999"))
    .slice(0, 8);
  if (!upcoming.length) {
    box.innerHTML = "";
    return;
  }
  const activeId = state.activeTab === "itinerary" && state.activeTrip ? state.activeTrip.id : "";
  box.innerHTML = `<h4>다가오는 여행</h4>` + upcoming.map(t => {
    const start = getTripDate(t, 1);
    const when = start ? formatShortDate(start) : "날짜 미정";
    return `<button class="sidebar-trip ${t.id === activeId ? "active" : ""}" data-trip-id="${esc(t.id)}"><strong>${esc(t.title)}</strong><span>${when} · ${t.days}일</span></button>`;
  }).join("");
  box.querySelectorAll("[data-trip-id]").forEach(b => {
    b.addEventListener("click", () => loadSavedTrip(b.getAttribute("data-trip-id")));
  });
}

// 더보기 메뉴
function setupTripMenu() {
  const btn = document.getElementById("btn-trip-menu");
  const menu = document.getElementById("trip-menu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("menu-edit-mode").classList.toggle("on", !!state.editMode);
    menu.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target)) menu.classList.remove("open");
  });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-menu]");
    if (!item) return;
    menu.classList.remove("open");
    const act = item.getAttribute("data-menu");
    if (act === "share") shareItinerary();
    else if (act === "calendar") downloadCalendarIcs();
    else if (act === "checklist") openChecklistModal();
    else if (act === "print") openPdfPreview();
    else if (act === "flights") openTripFlights();
    else if (act === "top1") {
      if (!window.RoutyAI.hasPlacesKey()) showToast("Google Places 키가 없어 쓸 수 없어요.", 4000);
      else autoPickTop(state.activeTrip, { force: true });
    }
    else if (act === "delete-day") deleteActiveDay();
    else if (act === "edit") {
      state.editMode = !state.editMode;
      renderTimeline();
      showToast(state.editMode ? "순서 편집 모드: ▲▼로 순서를 바꾸고 삭제할 수 있어요." : "순서 편집을 마쳤어요.");
    }
  });
}

// --- 예산 ---
let budgetCardOpen = false;
const SPEND_LABELS = { low: "가성비", medium: "적당히", high: "고급" };
const BUDGET_ITEMS = [["food", "식비"], ["transport", "교통비"], ["lodging", "숙박비"]];

function setupSpendPicker(id) {
  document.querySelectorAll(`#${id} .spend-opt`).forEach(btn => {
    btn.addEventListener("click", () => setSpendValue(id, btn.dataset.budget));
  });
}
function setSpendValue(id, value) {
  document.querySelectorAll(`#${id} .spend-opt`).forEach(b => {
    const on = b.dataset.budget === value;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}
function getSpendValue(id) {
  const b = document.querySelector(`#${id} .spend-opt.active`);
  return b ? b.dataset.budget : "medium";
}

// 만원 단위 입력 → 원 단위 { food, transport, lodging } (빈 칸은 제외)
function readBudgetInputs(prefix) {
  const plan = {};
  BUDGET_ITEMS.forEach(([k]) => {
    const v = parseFloat(document.getElementById(`${prefix}-${k}`).value);
    if (isFinite(v) && v > 0) plan[k] = Math.round(v * 10000);
  });
  return Object.keys(plan).length ? plan : undefined;
}
function fillBudgetInputs(prefix, plan) {
  BUDGET_ITEMS.forEach(([k]) => {
    const v = plan && plan[k] ? plan[k] / 10000 : "";
    document.getElementById(`${prefix}-${k}`).value = v === "" ? "" : Math.round(v * 10) / 10;
  });
  updateBudgetSum(prefix);
}
let budgetPeopleGetters = {};
function updateBudgetSum(prefix) {
  const plan = readBudgetInputs(prefix);
  const el = document.getElementById(`${prefix}-sum`);
  if (!el) return;
  if (!plan) {
    el.textContent = "";
    return;
  }
  const total = Object.values(plan).reduce((a, b) => a + b, 0);
  const people = budgetPeopleGetters[prefix] ? budgetPeopleGetters[prefix]() : 1;
  el.innerHTML = `합계 <strong>${formatManwon(total)}</strong>${people > 1 ? ` · 1인 ${formatManwon(total / people)}` : ""}`;
}
function setupBudgetInputs(prefix, getPeopleFn) {
  budgetPeopleGetters[prefix] = getPeopleFn;
  BUDGET_ITEMS.forEach(([k]) => {
    document.getElementById(`${prefix}-${k}`).addEventListener("input", () => updateBudgetSum(prefix));
  });
}
function formatManwon(won) {
  const m = won / 10000;
  return m >= 1 ? `${(Math.round(m * 10) / 10).toLocaleString()}만원` : formatWon(won);
}

function budgetCardHtml(t) {
  const c = getCategoryCosts(t);
  const plan = t.budgetPlan || {};
  const hasPlan = BUDGET_ITEMS.some(([k]) => plan[k] > 0);
  const row = (key, label, est, budget, note) => {
    const over = budget > 0 && est > budget;
    const pct = budget > 0 ? Math.min(100, Math.round((est / budget) * 100)) : 0;
    return `
      <div class="budget-row ${over ? "over" : ""}">
        <span class="b-label">${label}</span>
        <span class="b-values"><strong>${formatWon(est)}</strong>${budget > 0 ? `<span class="b-budget"> / ${formatWon(budget)}</span>` : ""}${note ? `<span class="b-note">${note}</span>` : ""}</span>
        ${budget > 0 ? `<span class="b-bar"><span style="width:${pct}%"></span></span>` : ""}
      </div>`;
  };
  const planTotal = BUDGET_ITEMS.reduce((s, [k]) => s + (plan[k] || 0), 0);
  // 예산을 정한 항목끼리만 합계 비교
  const estForPlanned = BUDGET_ITEMS.reduce((s, [k]) => s + (plan[k] > 0 ? c[k] : 0), 0);
  const overAll = hasPlan && estForPlanned > planTotal;
  const overItems = BUDGET_ITEMS.filter(([k]) => plan[k] > 0 && c[k] > plan[k]).map(([, label]) => label);
  const status = !hasPlan ? ""
    : overAll ? `<span class="b-status over">예산 ${formatWon(estForPlanned - planTotal)} 초과</span>`
    : overItems.length ? `<span class="b-status warn">${overItems.join("·")} 초과</span>`
    : `<span class="b-status ok">예산 안</span>`;
  return `
    <summary class="budget-head">
      <span class="b-sum">${window.icon("wallet", 16)}<strong>${formatWon(c.total)}</strong>${c.people > 1 ? `<small>${c.people}명 · 1인 ${formatWon(c.total / c.people)}</small>` : ""}</span>
      ${status}
      <span class="b-chevron">${window.icon("down", 16)}</span>
    </summary>
    <div class="budget-sub">
      <span>${SPEND_LABELS[t.budget] || "적당히"} · 일행 전체 예상</span>
      <button type="button" class="link-btn budget-edit" id="btn-edit-budget">${hasPlan ? "예산 수정" : "예산 정하기"}</button>
    </div>
    ${row("food", "식비", c.food, plan.food)}
    ${row("transport", "교통비", c.transport, plan.transport, c.transportIncomplete ? "이동 요금 정보 부족" : "")}
    ${row("lodging", "숙박비", c.lodging, plan.lodging)}
    ${c.other ? row("other", "기타 (입장료·쇼핑)", c.other, 0) : ""}

    ${hasPlan ? `<div class="budget-foot">정한 예산 ${formatWon(planTotal)} 중 ${formatWon(estForPlanned)} 예상${estForPlanned > planTotal ? ` · <b>${formatWon(estForPlanned - planTotal)} 초과</b>` : ` · ${formatWon(planTotal - estForPlanned)} 여유`}${overItems.length && !overAll ? ` (${overItems.join("·")}는 항목 예산 초과)` : ""}</div>` : ""}
  `;
}

function openBudgetModal() {
  const t = state.activeTrip;
  if (!t) return;
  setSpendValue("edit-spend-picker", t.budget || "medium");
  fillBudgetInputs("edit-budget", t.budgetPlan);
  document.getElementById("budget-modal-overlay").classList.add("active");
}

function setupBudgetModal() {
  const overlay = document.getElementById("budget-modal-overlay");
  setupSpendPicker("edit-spend-picker");
  setupBudgetInputs("edit-budget", () => getPeople(state.activeTrip));
  const close = () => overlay.classList.remove("active");
  document.getElementById("btn-close-budget").addEventListener("click", close);
  document.getElementById("btn-cancel-budget").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.getElementById("btn-confirm-budget").addEventListener("click", () => {
    const t = state.activeTrip;
    if (!t) return close();
    withUndo("예산을 저장했어요.", () => {
      t.budget = getSpendValue("edit-spend-picker");
      const plan = readBudgetInputs("edit-budget");
      if (plan) t.budgetPlan = plan;
      else delete t.budgetPlan;
    });
    close();
  });
}

// 여행 이동 수단 변경 → (AI 키가 있으면) 이동 방법·동선 다시 짜기
async function changeTripTransport(value, opts = {}) {
  const t = state.activeTrip;
  if (!t) return;
  // KTX·버스로 가는 일정에서 렌터카로 바꾸거나 렌터카를 그만두면 인수·반납 장소도 함께
  if (!opts.fromLocal && t.intercity) {
    if (value === "rental" && t.localMode !== "rental") return setLocalMode("rental");
    if (value === "car") {
      // 자가용은 집에서 바로 운전해 가므로 KTX·버스 구간과 역·렌터카 장소를 뺀다
      t.places = t.places.filter(p => !p.intercity);
      delete t.intercity;
      t.localMode = null;
      renderItineraryAll();
    } else if (value !== "rental" && t.localMode === "rental") {
      t.localMode = value === "taxi" ? "taxi" : value === "transit" ? "transit" : null;
      t.places = t.places.filter(p => p.intercity !== "pick" && p.intercity !== "drop");
      renderItineraryAll();
    }
  }
  const prev = t.transport || "auto";
  t.transport = value;
  persistActiveTrip();
  renderTripMeta();
  if (!window.RoutyAI.hasApiKey() || !t.places.length) {
    showToast(`현지 이동을 '${opts.label || TRANSPORT_LABELS[value]}'(으)로 바꿨어요. 길찾기 링크에 반영돼요.`);
    return;
  }
  const ok = await uiConfirm(`현지 이동을 '${opts.label || TRANSPORT_LABELS[value]}'(으)로 바꿨어요.\nAI가 이 기준으로 장소 사이 이동 방법과 동선을 다시 짜 드릴까요?`, { okText: "다시 짜기", cancelText: "설정만 바꾸기" });
  if (!ok) return;
  refineScope = "all";
  updateRefineScopeLabel();
  const input = document.getElementById("ai-refine-input");
  const keep = t.intercity ? ` 첫날 맨 앞 '${t.intercity.stop}' 도착${t.localMode === "rental" ? "·렌터카 인수" : ""} 장소와 마지막 날 끝 ${t.localMode === "rental" ? "렌터카 반납·" : ""}'${t.intercity.stop}' 출발 장소는 이름·시간 그대로 두고, 그 사이 현지 이동만 바꿔 줘.` : "";
  input.value = `현지 이동 수단을 '${opts.label || TRANSPORT_LABELS[value]}' 기준으로 바꿔 줘 (이전: ${TRANSPORT_LABELS[prev]}). 각 장소의 move(이동 방법·소요 시간)를 새로 정하고, 필요하면 동선과 시간도 조정해 줘.${keep}`;
  document.getElementById("ai-refine-form").requestSubmit();
}

function moveConnectorHtml(move, from, to) {
  if (move && move.mode === "flight" && to) return flightConnectorHtml(move, to);
  const routeBtn = from && to ? naverRouteBtnHtml(from, to, move && move.mode) : "";
  if (!move || !move.mode) return routeBtn ? `<div class="move-connector">${routeBtn}</div>` : "";
  const ticket = ticketInfo(move, from, to);
  const label = ticket && move.service ? move.service : (MOVE_LABELS[move.mode] || "이동");
  const costTxt = move.cost ? ` · ${ticket ? "약 " : ""}${formatWon(move.cost)}${GROUP_MOVE_MODES.includes(move.mode) ? "" : "/인"}${ticket ? " (예상)" : ""}` : "";
  const mins = (move.minutes ? ` ${formatMinutes(move.minutes)}` : "") + costTxt;
  const leg = ticket && (move.from || move.to) ? `<span class="move-leg">${esc(move.from || "출발")} → ${esc(move.to || "도착")}</span>` : "";
  const note = move.note && !leg ? `<span class="move-note">${esc(move.note)}</span>` : "";
  const ticketBtn = ticket ? `<button class="move-ticket" data-action="ticket" data-id="${esc(to.id)}">${window.icon("ticket", 14)}${ticket.label} 예매</button>` : "";
  return `<div class="move-connector">${window.icon(MOVE_ICONS[move.mode] || "walk", 15)}<span class="move-main">${esc(label)}${mins}</span>${leg}${note}${ticketBtn}${ticket ? "" : routeBtn}</div>`;
}

function formatMinutes(m) {
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}`;
}



const APP_VERSION = "v63";

// --- 목적지별 표지 색·그림 (사진 대신 저작권 걱정 없는 색과 이모지) ---
const DEST_THEMES = [
  [/교토|나라|오사카|간사이|고베/, "#FF7E5F", "#F7B267", "⛩️"],
  [/도쿄|요코하마|하코네/, "#5B6CFF", "#8EC5FC", "🗼"],
  [/후쿠오카|규슈|오키나와|나하/, "#00A3C4", "#7EE8C9", "🏝️"],
  [/삿포로|홋카이도/, "#74B9FF", "#C8E6FF", "❄️"],
  [/제주|서귀포|우도/, "#00A3C4", "#FFB547", "🍊"],
  [/부산|해운대|광안리|여수|통영|거제/, "#0077B6", "#48CAE4", "🌊"],
  [/강릉|속초|양양|동해|삼척/, "#2E86DE", "#7FD3F7", "🌅"],
  [/경주|안동|전주|공주|부여/, "#B5651D", "#F2C14E", "🪷"],
  [/서울|인천|수원/, "#4A4E9C", "#7F8CE0", "🏙️"],
  [/칭다오/, "#0E7C66", "#9BE15D", "🍺"],
  [/가오슝/, "#F39C12", "#FFE29F", "🌅"],
  [/대만|타이베이|홍콩|마카오|상하이/, "#E84A5F", "#FF847C", "🏮"],
  [/방콕|태국|치앙마이|푸껫|다낭|베트남|나트랑|세부|발리|괌|사이판/, "#F7971E", "#FFD200", "🌴"],
  [/파리|런던|로마|유럽|스페인|바르셀로나|이탈리아/, "#6D5BD0", "#C4A1FF", "🏰"],
  [/뉴욕|미국|하와이|LA|로스앤젤레스/, "#11998E", "#38EF7D", "🗽"]
];
function destTheme(text) {
  const t = String(text || "");
  const hit = DEST_THEMES.find(([re]) => re.test(t));
  return hit ? { c1: hit[1], c2: hit[2], emoji: hit[3] } : { c1: "#00A3C4", c2: "#007E9C", emoji: "✈️" };
}

// --- 식성: 매운 음식·못 먹는 음식 ---
const SPICY_RE = /개미집|낙곱새|엽기|배떡|청년다방|불타는|홍짜장|교동짬뽕|마라|훠궈|떡볶이|엽떡|짬뽕|닭발|쭈꾸미|주꾸미|낙지|매운|불닭|아구찜|아귀찜|해물찜|닭갈비|찜닭|김치찜|김치찌개|부대찌개|육개장|감자탕|탄탄|쓰촨|사천|똠얌|커리|카레|태국 음식|인도 음식|麻辣|火锅|辣|spicy|sichuan|szechuan|hot ?pot|curry|thai|indian/i;

// 흔한 표현은 가게 이름에 나오는 단어로 넓혀서 찾는다
const DIET_SYNONYMS = {
  "날것": ["회", "횟집", "스시", "초밥", "사시미", "육회", "오마카세", "물회"],
  "회": ["횟집", "스시", "초밥", "사시미", "물회", "오마카세"],
  "해산물": ["해물", "횟집", "수산", "조개", "대게", "킹크랩", "굴", "생선", "스시", "초밥", "랍스터", "새우", "seafood"],
  "생선": ["횟집", "스시", "초밥", "생선구이", "수산"],
  "돼지고기": ["돼지", "삼겹", "돈까스", "돈카츠", "보쌈", "족발", "국밥", "순대"],
  "소고기": ["소고기", "한우", "갈비", "스테이크", "규카츠", "야키니쿠"],
  "닭고기": ["치킨", "닭", "삼계탕"],
  "고수": ["베트남", "쌀국수", "태국", "멕시칸", "타코"]
};

function dietWords() {
  const s = window.RoutyAI.getSettings();
  const words = (s.avoidFoods || "").split(/[,，、\/\s]+/).map(w => w.trim()).filter(w => w.length >= 1);
  return words.flatMap(w => [w].concat(DIET_SYNONYMS[w] || []));
}

// 이 가게가 식성에 안 맞을 수 있는지 (이름·종류로 추정)
function dietConflict(it) {
  const s = window.RoutyAI.getSettings();
  const text = `${it.name || ""} ${it.typeLabel || ""}`;
  if (s.noSpicy && SPICY_RE.test(text)) return "매울 수 있음";
  const words = (s.avoidFoods || "").split(/[,，、\/\s]+/).map(w => w.trim()).filter(Boolean);
  const base = words.find(w => [w].concat(DIET_SYNONYMS[w] || []).some(k => k.length > 1 ? text.includes(k) : new RegExp(`(^|\\s)${k}(\\s|$)`).test(text)));
  return base ? `${base} 주의` : "";
}

function dietSort(ranked) {
  return ranked.filter(i => !dietConflict(i)).concat(ranked.filter(i => dietConflict(i)));
}

// AI 플래너의 식성 입력: 바꾸는 즉시 저장해서 다음 일정에도 그대로 쓴다
function setupDietInputs() {
  const btn = document.getElementById("input-no-spicy");
  const input = document.getElementById("input-avoid-foods");
  if (!btn || !input) return;
  const sync = () => {
    const s = window.RoutyAI.getSettings();
    btn.setAttribute("aria-pressed", s.noSpicy ? "true" : "false");
    btn.classList.toggle("on", !!s.noSpicy);
    if (document.activeElement !== input) input.value = s.avoidFoods || "";
  };
  try {
    const o = localStorage.getItem("routy_origin");
    if (o) document.getElementById("input-origin").value = o;
  } catch (e) {}
  btn.addEventListener("click", () => {
    window.RoutyAI.saveSettings({ noSpicy: !window.RoutyAI.getSettings().noSpicy });
    sync();
  });
  input.addEventListener("change", () => {
    window.RoutyAI.saveSettings({ avoidFoods: input.value.trim() });
    sync();
  });
  sync();
}


// --- 식당 Google 정보 줄 + 이름 눌러 Google 지도 ---
const placeInfo = new Map();      // googlePlaceId → 정보 (이번 실행 동안만, 저장 안 함)
const placeInfoPending = new Set();
const expandedInfo = new Set();     // '정보 더보기'를 펼친 식당 (googlePlaceId)
const collapsedInfo = new Set();    // 자동으로 보이던 정보를 접은 식당
// 앱을 다시 열 때마다 같은 식당 정보를 또 조회하지 않도록, 열려 있는 동안(세션)만 잠깐 보관
const PLACE_INFO_SESSION = "routy_place_info";
try {
  const saved = JSON.parse(sessionStorage.getItem(PLACE_INFO_SESSION) || "{}");
  Object.entries(saved).forEach(([id, v]) => { if (v && !v.error) placeInfo.set(id, v); });
} catch (e) {}
function rememberPlaceInfo(id, info) {
  placeInfo.set(id, info);
  if (!info || info.error) return;
  try {
    const keep = {};
    [...placeInfo.entries()].filter(([, v]) => v && !v.error).slice(-60).forEach(([k, v]) => { keep[k] = v; });
    sessionStorage.setItem(PLACE_INFO_SESSION, JSON.stringify(keep));
  } catch (e) {}
}
const PRICE_SIGNS = { PRICE_LEVEL_INEXPENSIVE: "₩", PRICE_LEVEL_MODERATE: "₩₩", PRICE_LEVEL_EXPENSIVE: "₩₩₩", PRICE_LEVEL_VERY_EXPENSIVE: "₩₩₩₩" };

function googlePlaceUrl(place) {
  const trip = state.activeTrip || {};
  const name = place.searchName || place.name;
  if (place.googlePlaceId) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${encodeURIComponent(place.googlePlaceId)}`;
  }
  const q = hasCoords(place) ? `${name} ${trip.destination || ""}`.trim() : `${place.name} ${trip.destination || ""}`.trim();
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function placeNameHtml(place) {
  if (place.category === "transit") return `<span class="timeline-place-name">${esc(place.name)}</span>`;
  return `<a class="timeline-place-name place-name-link" href="${esc(googlePlaceUrl(place))}" target="_blank" rel="noopener" title="Google 지도에서 자세히 보기">${esc(place.name)}<span class="name-arrow" aria-hidden="true">↗</span></a>`;
}

function hhmm(t) {
  return `${String(t.hour || 0).padStart(2, "0")}:${String(t.minute || 0).padStart(2, "0")}`;
}

// 그날(여행 날짜, 없으면 오늘) 영업시간과 방문 시간대 영업 여부
function openingStatus(info, place) {
  if (!info.periods || !info.periods.length) return null;
  const date = getTripDate(state.activeTrip, place.day);
  const d = date || new Date();
  const wd = d.getDay();
  const label = date ? "그날" : "오늘";
  if (info.periods.length === 1 && !info.periods[0].close) return { text: `${label} 24시간`, warn: false };
  const today = info.periods.filter(p => p.open && p.open.day === wd);
  if (!today.length) return { text: `${label} 휴무`, warn: true };
  const ranges = today.map(p => `${hhmm(p.open)}–${p.close ? hhmm(p.close) : "?"}`);
  // 방문 시작 시각이 영업시간 안인지
  const start = parseTimeToMinutes(place.time);
  let inside = true;
  if (isFinite(start) && start < 24 * 60) {
    inside = today.some(p => {
      const o = (p.open.hour || 0) * 60 + (p.open.minute || 0);
      let c = p.close ? (p.close.hour || 0) * 60 + (p.close.minute || 0) : 24 * 60;
      if (p.close && p.close.day !== p.open.day) c += 24 * 60;
      return start >= o && start < c;
    });
  }
  return { text: `${label} ${ranges.join(", ")}${inside ? "" : " · 방문 시간엔 영업 안 함"}`, warn: !inside };
}

function placeInfoHtml(place) {
  // 끼니 자리가 아직 식당으로 안 바뀐 경우: 이유를 알려 준다
  if (!place.googlePlaceId && place.mealSlot && place.category === "restaurant") {
    if (!window.RoutyAI.hasPlacesKey()) return `<div class="place-info loading">설정에 Google Places 키를 넣으면 주변 1위 식당으로 바뀌어요.</div>`;
    const u = window.RoutyAI.placesUsage();
    if (u.n >= window.RoutyAI.PLACES_DAILY_LIMIT) return `<div class="place-info loading">오늘 Google 조회 한도를 다 써서, 내일 앱을 열면 1위 식당으로 바꿔요. 'TOP 5'는 내일 쓸 수 있어요.</div>`;
    return `<div class="place-info loading">주변 1위 식당 찾는 중…</div>`;
  }
  if (!place.googlePlaceId || !["restaurant", "cafe"].includes(place.category)) return "";
  // 1위를 고를 때 받은 정보가 있으면 바로 보여 주고(추가 조회 없음),
  // 없으면(앱을 다시 연 뒤) 이름만 두고 '보기'를 눌렀을 때만 Google에서 불러온다
  const gid = esc(place.googlePlaceId);
  const known = placeInfo.get(place.googlePlaceId);
  const autoShow = known && !known.error && !collapsedInfo.has(place.googlePlaceId);
  if (!autoShow && !expandedInfo.has(place.googlePlaceId)) {
    return `<button type="button" class="pi-more" data-action="pinfo" data-gid="${gid}">ⓘ 별점·영업시간 보기</button>`;
  }
  const info = placeInfo.get(place.googlePlaceId);
  const fold = `<button type="button" class="pi-more on" data-action="pinfo" data-gid="${gid}">접기</button>`;
  if (!info) {
    queuePlaceInfo(place.googlePlaceId);
    return `<div class="place-info loading">Google 정보 불러오는 중…</div>`;
  }
  if (info.error) return `<div class="place-info loading">${esc(info.error)}</div>${fold}`;
  const bits = [];
  if (info.rating) bits.push(`<b class="pi-rating">★ ${info.rating.toFixed(1)}</b> <span class="pi-count">(${info.count.toLocaleString("ko-KR")})</span>`);
  if (PRICE_SIGNS[info.priceLevel]) bits.push(PRICE_SIGNS[info.priceLevel]);
  if (info.typeLabel) bits.push(esc(info.typeLabel));
  const open = openingStatus(info, place);
  if (open) bits.push(`<span class="${open.warn ? "pi-warn" : "pi-open"}">${esc(open.text)}</span>`);
  return `
    <div class="place-info">
      <div class="pi-line">${bits.join(" · ")}</div>
      ${info.summary ? `<div class="pi-summary">${esc(info.summary)}</div>` : ""}
      ${info.address ? `<div class="pi-addr">${window.icon("pin", 13)}${esc(info.address)}</div>` : ""}
    </div>${fold}`;
}

let placeInfoTimer = null;
function queuePlaceInfo(id) {
  if (placeInfoPending.has(id)) return;
  placeInfoPending.add(id);
  clearTimeout(placeInfoTimer);
  placeInfoTimer = setTimeout(runPlaceInfoQueue, 50);
}

async function runPlaceInfoQueue() {
  const ids = [...placeInfoPending].filter(id => !placeInfo.has(id));
  for (const id of ids) {
    try {
      rememberPlaceInfo(id, await window.RoutyAI.placeDetails(id));
    } catch (e) {
      placeInfo.set(id, { error: e.message });
      setTimeout(() => { if (placeInfo.get(id) && placeInfo.get(id).error) placeInfo.delete(id); }, 60000);
    }
    placeInfoPending.delete(id);
  }
  if (ids.length) renderTimeline();
}

// --- 숙소 최저가 바로가기 ---
// 실시간 가격 API는 개인에게 열려 있지 않아, 날짜·인원을 채운 '가격 낮은 순' 검색 화면을 연다.
const expandedStays = new Set();

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function stayInfo(place) {
  const trip = state.activeTrip;
  const people = Math.max(1, parseInt(trip.people, 10) || 2);
  // 같은 이름 숙소가 이어지는 날들을 한 번의 숙박으로 본다 (연박이면 첫날부터)
  const hotels = trip.places.filter(p => p.category === "hotel");
  const same = d => hotels.some(p => p.day === d && p.name === place.name);
  let firstDay = place.day, lastDay = place.day;
  while (same(firstDay - 1)) firstDay--;
  while (same(lastDay + 1)) lastDay++;
  const totalDays = trip.days || lastDay + 1;
  const nights = Math.max(1, Math.min(lastDay, totalDays - 1) - firstDay + 1);
  const checkin = getTripDate(trip, firstDay);
  const checkout = checkin ? new Date(checkin.getFullYear(), checkin.getMonth(), checkin.getDate() + nights) : null;
  const domestic = hasCoords(place) ? isInKorea(place.lat, place.lng) : /한국|서울|부산|제주|강릉|경주|여수|전주|대구|인천|속초/.test(trip.destination || "");
  const area = (trip.destination || "").split(/[\/,·]/)[0].trim() || place.name;
  return { people, nights, checkin, checkout, domestic, area, rooms: people <= 2 ? 1 : Math.ceil(people / 2) };
}

function stayLinks(place, info) {
  const enc = encodeURIComponent;
  const dates = info.checkin ? `&checkin=${ymd(info.checkin)}&checkout=${ymd(info.checkout)}` : "";
  const booking = q => `https://www.booking.com/searchresults.ko.html?ss=${enc(q)}${dates}&group_adults=${info.people}&no_rooms=${info.rooms}&group_children=0&order=price&selected_currency=KRW`;
  const links = [
    { key: "booking-area", label: `${info.area} 최저가순`, sub: "부킹닷컴 · 가격 낮은 순", url: booking(info.area), main: true },
    { key: "booking-this", label: "이 숙소 가격", sub: "부킹닷컴", url: booking(place.name) },
    { key: "google", label: "가격 비교", sub: "Google 호텔", url: `https://www.google.com/travel/search?q=${enc(info.area + " 호텔")}&hl=ko&gl=kr&curr=KRW` }
  ];
  if (info.domestic) {
    // 여기어때: 지역·날짜·인원·낮은가격순까지 주소로 채워짐 (2026-11 확인)
    const yeogiDates = info.checkin ? `&checkIn=${ymd(info.checkin)}&checkOut=${ymd(info.checkout)}` : "";
    links.push({ key: "goodchoice", label: "여기어때", sub: "낮은 가격순", url: `https://www.yeogi.com/domestic-accommodations?keyword=${enc(info.area)}${yeogiDates}&personal=${info.people}&sortType=LOWPRICE` });
    // 야놀자(NOL): 지역·낮은 가격순만 주소로 가능, 날짜·인원은 화면에서 선택
    links.push({ key: "yanolja", label: "야놀자", sub: "낮은 가격순 · 날짜는 직접", url: `https://nol.yanolja.com/discovery/list/search/PRODUCT_CATEGORY_KOREA_ACCOMMODATION?q=${enc(info.area)}&sort=SORT_PRICE_ASC`, copy: !!info.checkin });
  } else {
    links.push({ key: "agoda", label: "아고다", sub: "해외 숙소", url: `https://www.agoda.com/ko-kr/search?textToSearch=${enc(info.area)}${info.checkin ? `&checkIn=${ymd(info.checkin)}&los=${info.nights}` : ""}&adults=${info.people}&rooms=${info.rooms}&sort=priceLowToHigh`, copy: true });
  }
  return links;
}

function stayPanelHtml(place) {
  const info = stayInfo(place);
  const id = esc(place.id);
  const when = info.checkin
    ? `${info.checkin.getMonth() + 1}/${info.checkin.getDate()} 체크인 · ${info.nights}박`
    : `${info.nights}박 · 날짜 미정`;
  const est = place.price ? ` · AI 예상 1박 약 ${formatWon(place.price)}` : "";
  const links = stayLinks(place, info);
  return `
    <div class="stay-panel">
      <div class="tickets">${ticketHtml({ kind: "hotel", label: `${info.nights}박${info.rooms > 1 ? ` · 객실 ${info.rooms}개` : ""}`, fromCode: "", toCode: "", fromName: place.name, toName: "", date: info.checkin, dep: info.checkout ? `${info.checkout.getMonth() + 1}/${info.checkout.getDate()}` : "", arr: `${info.people}명` })}</div>
      ${est ? `<div class="stay-hint">${est.replace(/^ · /, "")}</div>` : ""}
      ${info.checkin ? "" : `<div class="stay-hint warn">여행 시작일이 없어 날짜 없이 열려요. 위쪽 날짜 칸에서 출발일을 정하면 체크인·체크아웃까지 채워져요.</div>`}
      <div class="stay-links">
        ${links.map(l => `<button class="stay-link ${l.main ? "main" : ""}" data-action="staysite" data-site="${l.key}" data-id="${id}"><b>${esc(l.label)}</b><small>${esc(l.sub)}</small></button>`).join("")}
      </div>
      <div class="stay-hint">가격은 사이트에서 실시간으로 확인돼요. 세금·수수료 포함 여부는 사이트마다 달라요.</div>
    </div>`;
}

async function openStaySite(place, key) {
  const info = stayInfo(place);
  const link = stayLinks(place, info).find(l => l.key === key);
  if (!link) return;
  window.open(link.url, "_blank", "noopener");
  if (link.copy) {
    const when = info.checkin ? ` ${info.checkin.getMonth() + 1}/${info.checkin.getDate()}~${info.checkout.getMonth() + 1}/${info.checkout.getDate()}` : "";
    try { if (navigator.clipboard) await navigator.clipboard.writeText(info.area); } catch (e) {}
    showToast(link.key === "yanolja"
      ? `야놀자 화면 위쪽에서 날짜를${when}, 인원을 ${info.people}명으로 바꿔 주세요.`
      : `${link.label}에서 '${info.area}'${when}, ${info.people}명으로 검색한 뒤 '낮은 가격순'으로 정렬하세요.`, 6000);
  }
}



// --- 여행 종류: 해외 / 국내 섬 / 국내 내륙 (교통 예매 버튼을 다르게) ---
const ISLAND_RE = /제주|서귀포|우도|가파도|마라도|추자|울릉|독도|백령|대청도|소청도|연평|덕적|자월|흑산|홍도|청산도|보길도|거문도|비금|도초|욕지도|사량도|연화도|매물도|외연도|관매도|조도/;
const KOREA_RE = /한국|서울|부산|인천|대구|대전|광주|울산|세종|경기|강원|충북|충남|충청|전북|전남|전라|경북|경남|경상|제주|강릉|속초|양양|춘천|평창|경주|포항|안동|여수|순천|목포|전주|군산|통영|거제|남해|담양|보성|공주|부여|단양|제천|가평|파주|수원|용인|울릉|태안|보령|하동|진주|창원|김해|포천|정선|영월|삼척|동해|고성|남원|구례|광양|완도|해남/;

function tripKind(trip) {
  if (!trip) return "overseas";
  const text = `${trip.destination || ""} ${trip.title || ""}`;
  const pts = trip.places.filter(hasCoords);
  const korean = pts.length ? pts.filter(p => isInKorea(p.lat, p.lng)).length >= pts.length / 2 : KOREA_RE.test(text);
  if (!korean) return "overseas";
  const island = ISLAND_RE.test(text) || pts.some(p => p.lat < 33.62 || p.lng > 130.6);
  return island ? "island" : "inland";
}

function needsFlight(trip) {
  return tripKind(trip) !== "inland";
}

function originCity(trip) {
  return (trip && trip.origin) || (() => { try { return localStorage.getItem("routy_origin"); } catch (e) { return ""; } })() || DEFAULT_ORIGIN;
}

// 국내 내륙: 출발 도시 ↔ 목적지 기차·버스 예매 블록 (대중교통·알아서·택시일 때)
// 출발 도시 노선에 따라 도착 터미널이 다른 경우 (예: 광주→부산은 서부터미널)
function expressAltOf(trip, destStops) {
  const origin = originCity(trip);
  if (!destStops || !destStops.expressAlt || /서울/.test(origin)) return null;
  const oLine = (cityStops(origin) || {}).line;
  return (oLine && destStops.expressAlt[oLine]) || null;
}

// 티켓에 쓸 짧은 역·터미널 이름 (예: 광주종합버스터미널(유스퀘어) → 광주, 부산서부시외버스터미널(사상) → 부산서부)
function shortStop(name) {
  return String(name || "").replace(/\(.*\)/g, "").replace(/(종합|고속|시외)?(버스)?(터미널|복합환승센터)$|역$/g, "").replace(/종합$|시외$/, "").slice(0, 6);
}

function railBlockHtml(trip, day) {
  if (!trip || tripKind(trip) !== "inland") return "";
  // 자가용으로 집에서 바로 가는 여행·도보 여행이면 숨김 (렌터카는 KTX·버스로 가서 빌리므로 표시)
  if (["car", "walk"].includes(trip.transport) && !trip.intercity) return "";
  const origin = originCity(trip);
  const dest = (trip.destination || "").split(/[\/,·]/)[0].trim();
  if (!dest || dest.includes(origin) || origin.includes(dest)) return "";
  const lastDay = trip.days || 1;
  const isOut = day === 1, isBack = day === lastDay && lastDay > 1;
  if (!isOut && !isBack) return "";
  // AI가 이미 기차·고속버스 구간을 넣은 날(직접 고른 구간 제외)은 그 이동 칸의 예매 버튼을 쓰면 됨
  const dayPlaces = trip.places.filter(p => p.day === day);
  if (!trip.intercity && dayPlaces.some(p => p.move && ["train", "express"].includes(p.move.mode))) return "";
  const date = getTripDate(trip, day);
  const people = Math.max(1, parseInt(trip.people, 10) || 1);
  const ic = trip.intercity;
  const destStops = cityStops(dest);
  const icFrom = ic ? (isOut ? ic.from : ic.stop) : (isOut ? origin : dest);
  const icTo = ic ? (isOut ? ic.stop : ic.from) : (isOut ? dest : origin);
  const key = `rail-${trip.id}-${day}`;
  const open = expandedFlights.has(key) || (!ic && isOut && !!destStops);
  const when = date ? `${date.getMonth() + 1}/${date.getDate()}` : "날짜 미정";
  const trainSites = [
    { k: "korail", label: "코레일", sub: "KTX·ITX·무궁화" },
    { k: "srt", label: "SRT", sub: "수서·동탄 출발" }
  ];
  const busSites = [
    { k: "kobus", label: "고속버스", sub: "고속버스 통합예매" },
    { k: "bustago", label: "시외버스", sub: "버스타고" }
  ];
  const sites = ic ? (ic.mode === "train" ? trainSites : busSites) : trainSites.concat(busSites);
  const modeBtns = destStops && isOut ? `
      <div class="ic-modes">
        <span>어떻게 갈까요?</span>
        ${destStops.train ? `<button class="seg-btn ${ic && ic.mode === "train" ? "on" : ""}" data-action="icmode" data-mode="train" data-day="${day}">🚄 KTX·기차 (${esc(destStops.train[0])})</button>` : ""}
        <button class="seg-btn ${ic && ic.mode === "express" ? "on" : ""}" data-action="icmode" data-mode="express" data-day="${day}">🚌 ${expressAltOf(trip, destStops) ? "시외버스" : "고속버스"} (${esc((expressAltOf(trip, destStops) || destStops.express)[0])})</button>
      </div>` : "";
  return `
    <div class="move-connector rail-block">${window.icon(ic && ic.mode === "express" ? "bus" : "train", 15)}<span class="move-main">${isOut ? "가는 길" : "돌아오는 길"} · ${when} · ${people}명${ic ? ` · ${esc(ic.service)}` : ""}</span><span class="move-leg">${esc(icFrom)} → ${esc(icTo)}</span>
      <button class="move-ticket" data-action="railblock" data-day="${day}">${window.icon("ticket", 14)}${open ? "접기" : "예매"}</button></div>
    ${open ? `<div class="stay-panel flight-panel rail-panel">
      ${modeBtns}
      <div class="stay-links">${sites.map(x => `<button class="stay-link" data-action="railsite" data-day="${day}" data-site="${x.k}"><b>${x.label}</b><small>${x.sub}</small></button>`).join("")}</div>
      ${ic && isOut ? localModeHtml(trip) : ""}
      ${ic ? `<div class="tickets">
        ${ticketHtml({ kind: ic.mode, label: `가는 ${ic.service}`, fromCode: shortStop(ic.from), toCode: shortStop(ic.stop), fromName: ic.from, toName: ic.stop, date: getTripDate(trip, 1), dep: ic.times && ic.times.out.dep, arr: ic.times && ic.times.out.arr, no: ic.times && ic.times.out.no, sugDep: legSuggest(trip.places.find(p => p.intercity === "out")).dep, sugArr: legSuggest(trip.places.find(p => p.intercity === "out")).arr })}
        ${trip.places.some(p => p.intercity === "back") ? ticketHtml({ kind: ic.mode, label: `오는 ${ic.service}`, fromCode: shortStop(ic.stop), toCode: shortStop(ic.from), fromName: ic.stop, toName: ic.from, date: getTripDate(trip, trip.days || 1), dep: ic.times && ic.times.ret && ic.times.ret.dep, arr: ic.times && ic.times.ret && ic.times.ret.arr, no: ic.times && ic.times.ret && ic.times.ret.no, sugDep: legSuggest(trip.places.find(p => p.intercity === "back"), "depart").dep }) : ""}
      </div>
      <button class="btn btn-sm ff-open" data-action="groundfit" data-day="${day}">${window.icon("calendar", 16)}${ic.times ? "예매 시간 고치기" : "예매 시간 넣고 일정 맞추기"}</button>` : ""}
      <div class="stay-hint">${ic ? "" : "수단을 고르면 타는 곳·내리는 곳에 맞춰 첫날 시작과 마지막 날 끝이 바뀌어요. "}예매 사이트는 역·날짜를 미리 채울 수 없어서, 누르면 '${when} ${esc(icFrom)} → ${esc(icTo)}'를 복사해 두고 안내해요.</div>
    </div>` : ""}`;
}

async function openRailSite(day, key) {
  const trip = state.activeTrip;
  const site = TICKET_SITES[key];
  if (!site) return;
  window.open(site.url, "_blank", "noopener");
  const origin = originCity(trip);
  const dest = (trip.destination || "").split(/[\/,·]/)[0].trim();
  const isOut = day === 1;
  const date = getTripDate(trip, day);
  const ic = trip.intercity;
  const a = ic ? (isOut ? ic.from : ic.stop) : (isOut ? origin : dest);
  const b = ic ? (isOut ? ic.stop : ic.from) : (isOut ? dest : origin);
  const txt = `${date ? `${date.getMonth() + 1}월 ${date.getDate()}일 ` : ""}${a} → ${b}`;
  try { if (navigator.clipboard) await navigator.clipboard.writeText(txt); } catch (e) {}
  showToast(`${site.label}에서 ${txt}, ${Math.max(1, parseInt(trip.people, 10) || 1)}명으로 검색하세요.`, 6000);
}


// --- 국내 내륙: KTX / 고속버스에 따라 타는 곳·내리는 곳이 다르므로 일정 시작·끝을 그 역/터미널로 ---
// [이름, 위도, 경도]
const CITY_STOPS = {
  "부산": { train: ["부산역", 35.1151, 129.0422], express: ["부산종합버스터미널(노포)", 35.2840, 129.0953], expressAlt: { honam: ["부산서부시외버스터미널(사상)", 35.1636, 128.9838] }, line: "gyeongbu", t: [150, 59800], b: [260, 36000] },
  "경주": { train: ["신경주역", 35.7983, 129.1390], express: ["경주고속버스터미널", 35.8390, 129.2040], line: "gyeongbu", t: [125, 49300], b: [230, 30000] },
  "강릉": { train: ["강릉역", 37.7638, 128.8994], express: ["강릉고속버스터미널", 37.7640, 128.9180], line: "gangwon", t: [115, 27600], b: [170, 22000] },
  "여수": { train: ["여수엑스포역", 34.7530, 127.7488], express: ["여수종합버스터미널", 34.7556, 127.7206], line: "honam", t: [170, 47200], b: [290, 35000] },
  "전주": { train: ["전주역", 35.8499, 127.1617], express: ["전주고속버스터미널", 35.8372, 127.1291], line: "honam", t: [100, 34000], b: [160, 20000] },
  "대구": { train: ["동대구역", 35.8797, 128.6286], express: ["동대구복합환승센터", 35.8781, 128.6287], line: "gyeongbu", t: [105, 43500], b: [220, 26000] },
  "광주": { train: ["광주송정역", 35.1374, 126.7915], express: ["광주종합버스터미널(유스퀘어)", 35.1600, 126.8790], line: "honam", t: [110, 46800], b: [200, 25000] },
  "대전": { train: ["대전역", 36.3323, 127.4346], express: ["대전복합터미널", 36.3506, 127.4382], line: "gyeongbu", t: [60, 23700], b: [120, 14000] },
  "목포": { train: ["목포역", 34.7914, 126.3868], express: ["목포종합버스터미널", 34.8127, 126.4154], line: "honam", t: [140, 52800], b: [230, 29000] },
  "순천": { train: ["순천역", 34.9459, 127.5034], express: ["순천종합버스터미널", 34.9566, 127.5227], line: "honam", t: [150, 44000], b: [240, 29000] },
  "포항": { train: ["포항역", 36.0716, 129.3423], express: ["포항시외버스터미널", 36.0195, 129.3497], line: "gyeongbu", t: [140, 52600], b: [250, 32000] },
  "안동": { train: ["안동역", 36.5626, 128.7330], express: ["안동터미널", 36.5555, 128.7303], line: "jungang", t: [125, 24100], b: [180, 22000] },
  "울산": { train: ["울산역(통도사)", 35.5517, 129.1385], express: ["울산고속버스터미널", 35.5364, 129.3383], line: "gyeongbu", t: [140, 53700], b: [250, 33000] },
  "창원": { train: ["창원중앙역", 35.2373, 128.6957], express: ["창원종합버스터미널", 35.2547, 128.6262], line: "gyeongbu", t: [170, 55000], b: [250, 32000] },
  "진주": { train: ["진주역", 35.1648, 128.1186], express: ["진주고속버스터미널", 35.1871, 128.0828], line: "gyeongbu", t: [185, 61000], b: [220, 30000] },
  "춘천": { train: ["춘천역", 37.8847, 127.7167], express: ["춘천시외버스터미널", 37.8637, 127.7215], line: "gangwon", t: [75, 9800], b: [80, 10000] },
  "속초": { train: null, express: ["속초고속버스터미널", 38.1904, 128.6010], line: "gangwon", b: [150, 23000] },
  "통영": { train: null, express: ["통영종합버스터미널", 34.8854, 128.4232], line: "gyeongbu", b: [250, 33000] }
};
const SEOUL_STOPS = {
  train: { gyeongbu: ["서울역", 37.5547, 126.9707], honam: ["용산역", 37.5299, 126.9648], gangwon: ["서울역", 37.5547, 126.9707], jungang: ["청량리역", 37.5804, 127.0470] },
  express: { gyeongbu: ["서울경부고속버스터미널", 37.5049, 127.0049], honam: ["센트럴시티터미널", 37.5049, 127.0049], gangwon: ["동서울터미널", 37.5345, 127.0947], jungang: ["동서울터미널", 37.5345, 127.0947] }
};

function cityStops(name) {
  const key = Object.keys(CITY_STOPS).find(k => String(name || "").includes(k));
  return key ? Object.assign({ city: key }, CITY_STOPS[key]) : null;
}

function originStop(trip, mode, line) {
  const origin = originCity(trip);
  if (/서울/.test(origin)) return SEOUL_STOPS[mode][line] || SEOUL_STOPS[mode].gyeongbu;
  const c = cityStops(origin);
  return c && c[mode] ? c[mode] : null;
}

const STOP_RE = /역|터미널|공항|정류장|환승센터/;

// 고른 수단(KTX/고속버스)으로 첫날 시작·마지막 날 끝을 그 역/터미널로 맞춘다
function applyIntercity(mode) {
  const trip = state.activeTrip;
  const destName = (trip.destination || "").split(/[\/,·]/)[0].trim();
  const dest = cityStops(destName);
  if (!dest || !dest[mode]) {
    showToast(mode === "train" ? `${destName}은(는) 기차역 정보가 없어요. 고속버스를 골라 보세요.` : `${destName} 터미널 정보가 없어요.`, 4000);
    return;
  }
  const from = originStop(trip, mode, dest.line);
  // 호남(광주 등)에서 오는 버스는 부산 서부(사상)처럼 도착 터미널이 다른 경우
  const oLine = (cityStops(originCity(trip)) || {}).line;
  const altStop = mode === "express" && dest.expressAlt && oLine && !/서울/.test(originCity(trip)) ? dest.expressAlt[oLine] : null;
  const [stopName, lat, lng] = altStop || dest[mode];
  const est = mode === "train" ? dest.t : dest.b;
  const fromSeoul = /서울/.test(originCity(trip));
  const service = mode === "train" ? (dest.line === "jungang" ? "KTX-이음" : dest.city === "춘천" ? "ITX-청춘" : "KTX") : (altStop ? "시외버스" : "고속버스");
  const before = cloneTrip(trip);
  const lastDay = trip.days || 1;
  const mkMove = (fromStop, toStop) => ({
    mode, minutes: fromSeoul && est ? est[0] : undefined, cost: fromSeoul && est ? est[1] : undefined,
    from: fromStop, to: toStop, service, note: ""
  });
  // 기존에 넣었던 가는/오는 구간·렌터카 장소 제거 (다시 고를 때)
  trip.places = trip.places.filter(p => !p.intercity);
  // 템플릿·AI가 넣어 둔 첫날 맨 앞 / 마지막 날 맨 끝의 역·터미널·공항도 고른 수단으로 대체
  const lead = trip.places.filter(p => p.day === 1);
  for (const p of lead) { if (p.category === "transit" && STOP_RE.test(p.name)) trip.places.splice(trip.places.indexOf(p), 1); else break; }
  if (lastDay > 1) {
    const tail = trip.places.filter(p => p.day === lastDay && p.category !== "hotel").reverse();
    for (const p of tail) { if (p.category === "transit" && STOP_RE.test(p.name)) trip.places.splice(trip.places.indexOf(p), 1); else break; }
  }
  // 첫날: 도착역/터미널을 맨 앞에
  const d1 = trip.places.filter(p => p.day === 1);
  const firstStart = d1.length ? parseTimeToMinutes(d1[0].time) : 10 * 60;
  const arriveAt = isFinite(firstStart) && firstStart < 24 * 60 ? firstStart - 30 : 9 * 60 + 30;
  const outPlace = {
    id: `ic-${Date.now()}-out`, day: 1, intercity: "out", category: "transit", name: `${stopName} 도착`,
    time: `${minutesToHHMM(arriveAt)} - ${minutesToHHMM(arriveAt + 20)}`, lat, lng, price: 0,
    description: `${originCity(trip)}에서 ${service}로 도착${from ? ` (${from[0]} 출발)` : ""}`,
    move: mkMove(from ? from[0] : originCity(trip), stopName), coordChecked: true
  };
  // 마지막 날: 출발역/터미널을 맨 끝에 (숙소 앞)
  const dl = trip.places.filter(p => p.day === lastDay && p.category !== "hotel");
  const lastEnd = dl.length ? (parseTimeRange(dl[dl.length - 1].time) || [0, 17 * 60])[1] : 17 * 60;
  const backPlace = lastDay > 1 ? {
    id: `ic-${Date.now()}-back`, day: lastDay, intercity: "back", category: "transit", name: `${stopName} 출발 (${originCity(trip)}행)`,
    time: `${minutesToHHMM(lastEnd + 40)} - ${minutesToHHMM(lastEnd + 60)}`, lat, lng, price: 0,
    description: `${service}로 ${originCity(trip)}${from ? ` ${from[0]}` : ""} 도착${fromSeoul && est ? ` · 약 ${formatMinutes(est[0])}` : ""}`,
    coordChecked: true
  } : null;
  const idx = trip.places.findIndex(p => p.day === 1);
  trip.places.splice(idx < 0 ? 0 : idx, 0, outPlace);
  if (backPlace) {
    let at = -1;
    trip.places.forEach((p, i) => { if (p.day === lastDay && p.category !== "hotel") at = i; });
    trip.places.splice(at + 1, 0, backPlace);
  }
  // 첫날 다음 장소의 이동은 역/터미널에서 출발하므로 다시 계산되게 비움
  const nextAfterOut = trip.places.filter(p => p.day === 1)[1];
  if (nextAfterOut && nextAfterOut.move && ["train", "express", "flight"].includes(nextAfterOut.move.mode)) delete nextAfterOut.move;
  trip.intercity = { mode, stop: stopName, from: from ? from[0] : originCity(trip), service };
  ensureTripShape(trip);
  if (!trip.localMode && trip.transport === "rental") trip.localMode = "rental";
  if (trip.localMode === "rental") {
    // 역·터미널이 바뀌었으니 렌터카 인수·반납 장소도 새 위치로
    const lm = trip.localMode; trip.localMode = null;
    trip.places = trip.places.filter(p => p.intercity !== "pick" && p.intercity !== "drop");
    trip.localMode = lm;
    const op = trip.places.find(p => p.intercity === "out"), bp = trip.places.find(p => p.intercity === "back");
    if (op) { const r = parseTimeRange(op.time) || [600, 620]; trip.places.splice(trip.places.indexOf(op) + 1, 0, { id: `ic-${Date.now()}-pick`, day: op.day, intercity: "pick", category: "transit", name: `${stopName} 렌터카 인수`, time: `${minutesToHHMM(r[1])} - ${minutesToHHMM(r[1] + 30)}`, lat, lng, price: 0, description: "역·터미널 근처 렌터카 지점에서 차량 인수 (면허증 지참)", coordChecked: true }); }
    if (bp) { const r = parseTimeRange(bp.time) || [960, 980]; trip.places.splice(trip.places.indexOf(bp), 0, { id: `ic-${Date.now()}-drop`, day: bp.day, intercity: "drop", category: "transit", name: `${stopName} 렌터카 반납`, time: `${minutesToHHMM(r[0] - 40)} - ${minutesToHHMM(r[0] - 10)}`, lat, lng, price: 0, description: "주유·반납 시간 여유 있게", coordChecked: true }); }
  }
  refineUndoTrip = before;
  recentlyChanged = new Set([outPlace.id].concat(backPlace ? [backPlace.id] : []));
  renderItineraryAll();
  persistActiveTrip();
  setRefineMode("undo");
  showToast(`${service}: ${from ? from[0] : originCity(trip)} → ${stopName}. 첫날은 ${stopName}에서 시작하고${backPlace ? ` 마지막 날은 ${stopName}에서 끝나요` : ""}. 시간은 편집에서 바꿀 수 있어요.`, 6000);
}


// AI가 일정을 다시 짠 뒤에도 역·터미널·렌터카 장소를 다시 알아보게 표시
function markIntercityEdges(trip) {
  const ic = trip && trip.intercity;
  if (!ic) return;
  const lastDay = trip.days || 1;
  trip.places.forEach(p => {
    if (p.category !== "transit" || !p.name.includes(ic.stop)) return;
    if (/렌터카 인수/.test(p.name)) p.intercity = "pick";
    else if (/렌터카 반납/.test(p.name)) p.intercity = "drop";
    else if (p.day === 1 && /도착/.test(p.name)) p.intercity = "out";
    else if (p.day === lastDay && /출발/.test(p.name)) p.intercity = "back";
    else return;
    p.coordChecked = true;
  });
}

// --- 도착해서 현지 이동: 렌터카 / 버스 / 택시 ---
const LOCAL_MODES = {
  rental: { label: "렌터카", transport: "rental", icon: "car" },
  transit: { label: "버스·대중교통", transport: "transit", icon: "bus" },
  taxi: { label: "택시", transport: "taxi", icon: "taxi" }
};
const RENTAL_SITES = [
  { k: "socar", label: "쏘카", sub: "카셰어링·역 앞 대여", url: "https://www.socar.kr/" },
  { k: "lotte", label: "롯데렌터카", sub: "역·터미널 지점", url: "https://www.lotterentacar.net/" },
  { k: "carmore", label: "카모아", sub: "렌터카 가격 비교", url: "https://www.carmore.kr/" }
];

function setLocalMode(mode) {
  const trip = state.activeTrip;
  const ic = trip.intercity;
  const lm = LOCAL_MODES[mode];
  if (!ic || !lm) return;
  trip.localMode = mode;
  // 렌터카 인수·반납 장소 넣기/빼기
  trip.places = trip.places.filter(p => p.intercity !== "pick" && p.intercity !== "drop");
  if (mode === "rental") {
    const outP = trip.places.find(p => p.intercity === "out");
    const backP = trip.places.find(p => p.intercity === "back");
    if (outP) {
      const r = parseTimeRange(outP.time) || [600, 620];
      const pick = { id: `ic-${Date.now()}-pick`, day: outP.day, intercity: "pick", category: "transit", name: `${ic.stop} 렌터카 인수`,
        time: `${minutesToHHMM(r[1])} - ${minutesToHHMM(r[1] + 30)}`, lat: outP.lat, lng: outP.lng, price: 0,
        description: "역·터미널 근처 렌터카 지점에서 차량 인수 (면허증 지참)", coordChecked: true };
      trip.places.splice(trip.places.indexOf(outP) + 1, 0, pick);
    }
    if (backP) {
      const r = parseTimeRange(backP.time) || [960, 980];
      const drop = { id: `ic-${Date.now()}-drop`, day: backP.day, intercity: "drop", category: "transit", name: `${ic.stop} 렌터카 반납`,
        time: `${minutesToHHMM(r[0] - 40)} - ${minutesToHHMM(r[0] - 10)}`, lat: backP.lat, lng: backP.lng, price: 0,
        description: "주유·반납 시간 여유 있게", coordChecked: true };
      trip.places.splice(trip.places.indexOf(backP), 0, drop);
    }
  }
  renderItineraryAll();
  persistActiveTrip();
  changeTripTransport(lm.transport, { label: lm.label, fromLocal: true });
}

function rentalHint(trip) {
  const pick = trip.places.find(p => p.intercity === "pick") || trip.places.find(p => /렌터카 인수/.test(p.name));
  const drop = trip.places.find(p => p.intercity === "drop") || trip.places.find(p => /렌터카 반납/.test(p.name));
  const where = trip.intercity ? trip.intercity.stop
    : pick ? pick.name.replace(/\s*렌터카 인수.*/, "")
    : ((trip.places.find(isAirportPlace) || {}).name || (trip.destination || "").split(/[\/,·]/)[0]);
  const d = (p, day) => { const dt = getTripDate(trip, p ? p.day : day); return dt ? `${dt.getMonth() + 1}/${dt.getDate()} ` : ""; };
  const t = (p) => p && parseTimeRange(p.time) ? minutesToHHMM(parseTimeRange(p.time)[0]) : "";
  return `${where} ${d(pick, 1)}${t(pick)} 인수 ~ ${d(drop, trip.days || 1)}${t(drop)} 반납`.replace(/\s+/g, " ");
}

async function openRentalSite(key) {
  const site = RENTAL_SITES.find(x => x.k === key);
  if (!site) return;
  window.open(site.url, "_blank", "noopener");
  const txt = rentalHint(state.activeTrip);
  try { if (navigator.clipboard) await navigator.clipboard.writeText(txt); } catch (e) {}
  showToast(`${site.label}에서 '${txt}'로 검색하세요. (복사해 뒀어요)`, 6000);
}

function localModeHtml(trip) {
  const ic = trip.intercity;
  if (!ic) return "";
  const cur = trip.localMode || (trip.transport === "rental" ? "rental" : trip.transport === "taxi" ? "taxi" : trip.transport === "transit" ? "transit" : "");
  return `
      <div class="ic-modes local-modes">
        <span>도착해서는요?</span>
        ${Object.entries(LOCAL_MODES).map(([k, m]) => `<button class="seg-btn ${cur === k ? "on" : ""}" data-action="localmode" data-mode="${k}">${window.icon(m.icon, 14)} ${m.label}</button>`).join("")}
      </div>
      ${cur === "rental" ? `<div class="stay-links rental-links">${RENTAL_SITES.map(x => `<button class="stay-link" data-action="rentalsite" data-site="${x.k}"><b>${x.label}</b><small>${x.sub}</small></button>`).join("")}</div>
      <div class="stay-hint">렌터카: ${esc(rentalHint(trip))}</div>` : ""}`;
}


// --- 자가용: 집 출발 시각 → 현지 도착 예정에 맞춰 일정 ---
const CITY_COORDS = {
  "서울": [37.5665, 126.978], "인천": [37.4563, 126.7052], "수원": [37.2636, 127.0286], "성남": [37.42, 127.1265], "용인": [37.2411, 127.1776],
  "고양": [37.6584, 126.832], "부천": [37.5035, 126.766], "안양": [37.3943, 126.9568], "화성": [37.1995, 126.8312], "평택": [36.9921, 127.1129],
  "부산": [35.1796, 129.0756], "대구": [35.8714, 128.6014], "대전": [36.3504, 127.3845], "광주": [35.1595, 126.8526], "울산": [35.5384, 129.3114],
  "세종": [36.48, 127.289], "청주": [36.6424, 127.489], "천안": [36.8151, 127.1139], "전주": [35.8242, 127.148], "창원": [35.2281, 128.6811],
  "포항": [36.019, 129.3435], "김해": [35.2285, 128.8894], "춘천": [37.8813, 127.7298], "원주": [37.3422, 127.9202], "강릉": [37.7519, 128.8761],
  "목포": [34.8118, 126.3922], "순천": [34.9507, 127.4872], "여수": [34.7604, 127.6622], "나주": [35.016, 126.7108], "무안": [34.9904, 126.4817], "광양": [34.9407, 127.6959], "제주": [33.4996, 126.5312]
};

async function originCoords(trip) {
  if (trip.originCoord) return trip.originCoord;
  const o = originCity(trip);
  const key = Object.keys(CITY_COORDS).find(k => o.includes(k));
  if (key) return (trip.originCoord = { lat: CITY_COORDS[key][0], lng: CITY_COORDS[key][1] });
  try {
    const r = await window.RoutyAI.searchPlaces(o, null, { limit: 1 });
    if (r && r[0]) return (trip.originCoord = { lat: r[0].lat, lng: r[0].lng });
  } catch (e) {}
  return null;
}

function destCenter(trip) {
  const pts = trip.places.filter(p => hasCoords(p) && p.category !== "transit");
  return medianCenter(pts.length ? pts : trip.places.filter(hasCoords));
}

// 직선거리 × 도로 계수 ÷ 평균 속도 + 2시간 넘으면 휴게소 20분 (예상치, 서울→경주 약 4시간 30분)
function estimateDriveMin(a, b) {
  if (!a || !b) return null;
  const km = distanceMeters(a, b) / 1000 * 1.25;
  const min = km / 85 * 60 + 15; // 고속도로 위주 평균 속도 + 도심 진출입
  return Math.round((min + (min > 120 ? 20 : 0)) / 5) * 5;
}

function driveBlockHtml(trip, day) {
  if (!trip || trip.transport !== "car" || tripKind(trip) !== "inland") return "";
  const lastDay = trip.days || 1;
  const isOut = day === 1, isBack = day === lastDay && lastDay > 1;
  if (!isOut && !isBack) return "";
  const origin = originCity(trip);
  const dest = (trip.destination || "").split(/[\/,·]/)[0].trim();
  if (!dest || dest.includes(origin) || origin.includes(dest)) return "";
  const dv = trip.drive || {};
  const est = dv.minutes;
  const date = getTripDate(trip, day);
  const when = date ? `${date.getMonth() + 1}/${date.getDate()}` : "";
  const key = `drive-${trip.id}`;
  const open = expandedFlights.has(key);
  const info = isOut
    ? (dv.dep ? `${dv.dep} 집 출발 → ${dv.arr || "?"} 도착 예정` : `${origin} → ${dest}${est ? ` · 약 ${formatMinutes(est)}` : ""}`)
    : (dv.backDep ? `${dv.backDep} 출발 → ${dv.backArr || "?"} 집 도착 예정` : `${dest} → ${origin}${est ? ` · 약 ${formatMinutes(est)}` : ""}`);
  const panel = open && isOut ? `
    <div class="stay-panel flight-panel rail-panel drive-panel">
      <div class="tpl-grid drive-grid">
        <div class="form-group"><label for="drive-dep">집 출발 (Day 1)</label><input type="time" id="drive-dep" value="${esc(dv.dep || "")}"></div>
        <div class="form-group"><label for="drive-back">현지 출발 (Day ${lastDay}, 선택)</label><input type="time" id="drive-back" value="${esc(dv.backDep || "")}"></div>
        <div class="form-group"><label>운전 시간 (분)</label><input type="number" id="drive-min" min="10" max="900" step="5" value="${est || ""}" placeholder="자동"></div>
      </div>
      <div class="stay-hint" id="drive-preview">${est ? `예상 운전 시간 약 ${formatMinutes(est)} (휴게소 포함, 교통 상황에 따라 달라요). 실제 시간은 아래 네이버 지도로 확인하고 고쳐 주세요.` : "운전 시간을 계산하는 중…"}</div>
      <div class="stay-links">
        <button class="stay-link" data-action="drivenaver"><b>네이버 지도</b><small>실제 소요시간 보기</small></button>
        <button class="stay-link main" data-action="drivefit"><b>이 시간에 맞춰 일정 짜기</b><small>첫날 도착 뒤부터 · 마지막 날 출발 전까지</small></button>
      </div>
    </div>` : "";
  return `
    <div class="move-connector rail-block">${window.icon("car", 15)}<span class="move-main">${isOut ? "가는 길" : "돌아오는 길"}${when ? ` · ${when}` : ""} · 자가용</span><span class="move-leg">${esc(info)}</span>
      ${isOut ? `<button class="move-ticket" data-action="driveblock">${window.icon("calendar", 14)}${open ? "접기" : dv.dep ? "출발 시간 고치기" : "출발 시간 정하기"}</button>` : ""}</div>${panel}`;
}

async function ensureDriveEstimate(trip) {
  if (trip.drive && trip.drive.minutes) return trip.drive.minutes;
  const a = await originCoords(trip);
  const b = destCenter(trip);
  const m = estimateDriveMin(a, b);
  if (m) { trip.drive = Object.assign({}, trip.drive, { minutes: m }); persistActiveTrip(); }
  return m;
}

async function openDriveNaver() {
  const trip = state.activeTrip;
  const a = await originCoords(trip);
  const b = destCenter(trip);
  if (!a || !b) { showToast("출발 도시 위치를 찾지 못했어요.", 3000); return; }
  const from = { lat: a.lat, lng: a.lng, name: originCity(trip) };
  const to = { lat: b.lat, lng: b.lng, name: (trip.destination || "").split(/[\/,·]/)[0] };
  if (isTouchDevice()) location.href = naverRouteUrl(from, to, "car");
  else window.open(`https://map.kakao.com/link/to/${encodeURIComponent(to.name)},${to.lat},${to.lng}`, "_blank", "noopener");
}

async function fitTripToDrive() {
  const trip = state.activeTrip;
  const $ = id => document.getElementById(id);
  const dep = $("drive-dep").value;
  const backDep = $("drive-back").value;
  const typed = parseInt($("drive-min").value, 10);
  const minutes = typed > 0 ? typed : await ensureDriveEstimate(trip);
  if (!dep && !backDep) { showToast("집 출발 시각이나 현지 출발 시각 중 하나는 넣어 주세요.", 3500); return; }
  if (!minutes) { showToast("운전 시간을 계산하지 못했어요. 분 단위로 직접 넣어 주세요.", 3500); return; }
  const arr = dep ? minutesToHHMM(hhmmToMin(dep) + minutes) : "";
  const backArr = backDep ? minutesToHHMM(hhmmToMin(backDep) + minutes) : "";
  trip.drive = { dep, arr, backDep, backArr, minutes };
  expandedFlights.delete(`drive-${trip.id}`);
  const origin = originCity(trip), dest = (trip.destination || "").split(/[\/,·]/)[0].trim();
  const lastDay = trip.days || 1;
  const instr = {};
  if (dep) instr[1] = `자가용으로 집(${origin})에서 ${dep}에 출발해 약 ${formatMinutes(minutes)} 운전, ${arr}경 ${dest}에 도착합니다. Day 1 첫 장소는 ${arr} 이후(주차 시간 포함 20분 여유)부터 시작하도록 일정을 다시 배치하고, 시간이 모자라면 장소를 빼거나 줄이세요. 장소 사이 이동은 car, 숙소는 유지하세요.`;
  if (backDep && lastDay > 1) instr[lastDay] = `마지막 날 ${backDep}에 ${dest}에서 자가용으로 출발해 ${backArr}경 집(${origin})에 도착합니다. Day ${lastDay}의 마지막 장소가 ${backDep} 전에 끝나도록 줄이거나 앞당기고, 그 뒤 일정은 넣지 마세요.`;
  const before = cloneTrip(trip);
  const days = Object.keys(instr).map(Number).sort((a, b) => a - b);
  if (!window.RoutyAI.hasApiKey()) {
    if (dep) {
      const first = trip.places.filter(p => p.day === 1)[0];
      const st = first ? parseTimeToMinutes(first.time) : NaN;
      const need = hhmmToMin(arr) + 20;
      if (first && isFinite(st) && st < need) shiftDayFrom(first.id, need - st);
    }
    if (backDep && lastDay > 1) {
      const dl = trip.places.filter(p => p.day === lastDay && p.category !== "hotel");
      const end = dl.length ? (parseTimeRange(dl[dl.length - 1].time) || [0, 0])[1] : 0;
      const limit = hhmmToMin(backDep);
      if (dl.length && end > limit) {
        const delta = Math.max(limit - end, 8 * 60 - parseTimeToMinutes(dl[0].time));
        if (delta < 0) dl.forEach(p => { p.time = shiftTimeString(p.time, delta); });
      }
    }
    refineUndoTrip = before;
    renderItineraryAll();
    persistActiveTrip();
    setRefineMode("undo");
    showToast(`${dep ? `${arr} 도착 예정에 맞춰 첫날을 밀었어요. ` : ""}장소를 줄이거나 바꾸는 것까지 하려면 설정에서 Gemini 키를 넣어 주세요.`, 5000);
    return;
  }
  const refineBtn = document.getElementById("btn-ai-refine");
  const form = document.getElementById("ai-refine-form");
  form.classList.add("loading");
  refineBtn.disabled = true;
  const changed = new Set();
  try {
    for (const d of days) {
      refineBtn.textContent = `Day ${d} 맞추는 중…`;
      (await applyAIRefine(instr[d], d, { keepUndo: true })).forEach(id => changed.add(id));
      renderItineraryAll();
    }
    refineUndoTrip = before;
    recentlyChanged = changed;
    renderItineraryAll();
    persistActiveTrip();
    setRefineMode("undo");
    verifyCoordinates(trip.id, Array.from(changed));
    autoPickTop(trip);
    showToast(`${dep ? `${arr} 도착 예정` : ""}${dep && backDep ? "·" : ""}${backDep ? `${backDep} 출발` : ""}에 맞춰 일정을 다시 짰어요. 마음에 안 들면 '되돌리기'를 누르세요.`, 5000);
  } catch (e) {
    renderItineraryAll();
    persistActiveTrip();
    showToast(e.message || "일정을 다시 짜지 못했어요.", 5000);
  } finally {
    refineBtn.disabled = false;
    form.classList.remove("loading");
    if (refineBtn.dataset.mode !== "undo") setRefineMode("normal");
  }
}



// --- AI 플래너 단계형 입력: ① 어디로·언제 → ② 누구와·어떻게 → ③ 스타일·식성 ---
function setupPlannerSteps() {
  const form = document.getElementById("planner-form");
  if (!form) return;
  const go = (n) => {
    if (n > 1 && !document.getElementById("input-destination").value.trim()) {
      n = 1;
      showToast("어디로 갈지 먼저 적어 주세요.", 2500);
      document.getElementById("input-destination").focus();
    }
    form.querySelectorAll(".pstep").forEach(el => el.classList.toggle("active", el.dataset.step === String(n)));
    form.querySelectorAll(".pstep-tab").forEach(el => {
      el.classList.toggle("active", el.dataset.goto === String(n));
      el.classList.toggle("done", parseInt(el.dataset.goto, 10) < n);
    });
    const scroller = form.closest(".scrollable");
    if (scroller) scroller.scrollTo({ top: 0, behavior: "smooth" });
  };
  window.plannerGoStep = go;
  form.querySelectorAll("[data-goto]").forEach(b => b.addEventListener("click", () => go(parseInt(b.dataset.goto, 10))));
  form.querySelectorAll("[data-next]").forEach(b => b.addEventListener("click", () => go(parseInt(b.dataset.next, 10))));
  form.querySelectorAll("[data-quick]").forEach(b => b.addEventListener("click", () => {
    if (!document.getElementById("input-destination").value.trim()) { go(1); return; }
    document.getElementById("btn-generate-itinerary").click();
  }));
  // 목적지에서 엔터 → 다음 단계
  document.getElementById("input-destination").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(2); }
  });
}

// --- 날마다 기상 시간: 그 시간에 맞춰 그날 일정 다시 짜기 ---
function openWakeDialog() {
  const trip = state.activeTrip;
  const day = state.activeTripDay;
  const cur = (trip.wake || {})[day] || "08:00";
  let ov = document.getElementById("wake-overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "wake-overlay";
    ov.className = "modal-overlay";
    ov.innerHTML = `
      <div class="place-edit-modal wake-modal">
        <div class="checklist-modal-header"><h3 id="wake-title">기상 시간</h3><button class="btn-close-modal" id="wake-close" aria-label="닫기">✕</button></div>
        <div class="place-edit-body">
          <p class="budget-help">일어나는 시간에 맞춰 준비·아침 식사와 숙소에서 이동하는 시간을 두고 그날 첫 일정을 시작해요.</p>
          <div class="form-group"><label for="wake-time">일어나는 시간</label><input type="time" id="wake-time"></div>
          <label class="check-row"><input type="checkbox" id="wake-all"> 모든 날에 같은 시간 적용</label>
          <div class="wake-presets">${["06:30", "07:30", "08:30", "09:30", "10:30"].map(t => `<button type="button" class="seg-btn" data-wake="${t}">${t}</button>`).join("")}</div>
        </div>
        <div class="drawer-actions" style="padding: 0 20px 20px;">
          <button class="btn btn-sm btn-secondary" id="wake-cancel">취소</button>
          <button class="btn btn-sm btn-primary" id="wake-apply">이 시간에 맞춰 일정 짜기</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.classList.remove("active");
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    ov.querySelector("#wake-close").addEventListener("click", close);
    ov.querySelector("#wake-cancel").addEventListener("click", close);
    ov.querySelectorAll("[data-wake]").forEach(b => b.addEventListener("click", () => { ov.querySelector("#wake-time").value = b.dataset.wake; }));
    ov.querySelector("#wake-apply").addEventListener("click", () => {
      const v = ov.querySelector("#wake-time").value;
      if (!v) return;
      close();
      applyWake(v, ov.querySelector("#wake-all").checked);
    });
  }
  ov.querySelector("#wake-title").textContent = `Day ${day} 기상 시간`;
  ov.querySelector("#wake-time").value = cur;
  ov.querySelector("#wake-all").checked = false;
  ov.classList.add("active");
}

async function applyWake(time, all) {
  const trip = state.activeTrip;
  const totalDays = trip.days || 1;
  const days = all ? Array.from({ length: totalDays }, (_, i) => i + 1) : [state.activeTripDay];
  trip.wake = Object.assign({}, trip.wake);
  days.forEach(d => { trip.wake[d] = time; });
  const before = cloneTrip(trip);
  const start = minutesToHHMM(hhmmToMin(time) + 60);
  // 이동(역·공항·렌터카 등)으로 시작이 정해진 날은 그 장소를 건드리지 않음
  const fixed = p => p.intercity || (p.category === "transit" && STOP_RE.test(p.name));
  if (!window.RoutyAI.hasApiKey()) {
    days.forEach(d => {
      const list = trip.places.filter(p => p.day === d && !fixed(p) && p.category !== "hotel");
      if (!list.length) return;
      const st = parseTimeToMinutes(list[0].time);
      if (!isFinite(st) || st >= 24 * 60) return;
      const delta = hhmmToMin(start) - st;
      if (delta) list.forEach(p => { p.time = shiftTimeString(p.time, delta); });
    });
    refineUndoTrip = before;
    renderItineraryAll();
    persistActiveTrip();
    setRefineMode("undo");
    showToast(`${days.length > 1 ? "모든 날" : `Day ${days[0]}`} 첫 일정을 ${start}에 맞춰 옮겼어요. 장소를 늘리거나 줄이려면 설정에서 Gemini 키를 넣어 주세요.`, 5000);
    return;
  }
  const refineBtn = document.getElementById("btn-ai-refine");
  const form = document.getElementById("ai-refine-form");
  form.classList.add("loading");
  refineBtn.disabled = true;
  const changed = new Set();
  try {
    for (const d of days) {
      refineBtn.textContent = `Day ${d} 맞추는 중…`;
      const instr = `Day ${d}에는 ${time}에 일어납니다. 준비·아침 식사와 숙소에서 첫 장소까지 이동 시간을 고려해 첫 일정은 ${start} 이후에 시작하도록 그날 일정을 다시 짜 주세요. ` +
        `늦게 일어나 시간이 모자라면 덜 중요한 장소를 빼거나 줄이고, 일찍 일어나 시간이 남으면 근처 장소를 하나 더 넣어도 됩니다. ` +
        `그날 맨 앞이나 맨 끝의 역·공항·터미널·렌터카 장소와 숙소는 이름·시간 그대로 두세요.`;
      (await applyAIRefine(instr, d, { keepUndo: true })).forEach(id => changed.add(id));
      renderItineraryAll();
    }
    refineUndoTrip = before;
    recentlyChanged = changed;
    renderItineraryAll();
    persistActiveTrip();
    setRefineMode("undo");
    verifyCoordinates(trip.id, Array.from(changed));
    autoPickTop(trip);
    showToast(`${days.length > 1 ? "모든 날" : `Day ${days[0]}`}을 ${time} 기상에 맞춰 다시 짰어요. 마음에 안 들면 '되돌리기'를 누르세요.`, 5000);
  } catch (e) {
    renderItineraryAll();
    persistActiveTrip();
    showToast(e.message || "일정을 다시 짜지 못했어요.", 5000);
  } finally {
    refineBtn.disabled = false;
    form.classList.remove("loading");
    if (refineBtn.dataset.mode !== "undo") setRefineMode("normal");
  }
}


// --- 탑승권 모양 티켓 (항공·기차·버스·숙소) ---
// 아직 예매 전인 구간: 일정에 잡힌 도착·출발 시각을 '추천 시간'으로
function legSuggest(place, which) {
  if (!place) return {};
  const r = parseTimeRange(place.time);
  if (!r) return {};
  const mins = place.move && place.move.minutes;
  if (which === "depart") return { dep: minutesToHHMM(r[1]) };
  return { arr: minutesToHHMM(r[0]), dep: mins ? minutesToHHMM(r[0] - mins) : "" };
}

function ticketHtml(o) {
  const icon = { flight: "✈", train: "🚄", express: "🚌", bus: "🚌", hotel: "🏨" }[o.kind] || "✈";
  const d = o.date ? `${o.date.getMonth() + 1}/${o.date.getDate()}(${WEEKDAYS[o.date.getDay()]})` : "날짜 미정";
  const booked = o.kind !== "hotel" && !!(o.dep || o.arr);
  const sug = !booked && o.kind !== "hotel" && (o.sugDep || o.sugArr);
  const cell = (v, s2) => v ? esc(v) : (sug && s2 ? `<span class="tk-sug">~${esc(s2)}</span>` : "--:--");
  return `
    <div class="ticket ${booked ? "booked" : ""}">
      <div class="tk-main">
        <div class="tk-label">${esc(o.label || "")}${sug ? ` <span class="tk-sug-tag">추천 시간 · 이 시간대 표를 고르세요</span>` : ""}</div>
        ${o.kind === "hotel" ? `<div class="tk-hotel"><span>${icon}</span><b>${esc(o.fromName || "")}</b></div>` : `<div class="tk-route">
          <div class="tk-end"><b>${esc(o.fromCode || "")}</b><small>${esc(o.fromName || "")}</small></div>
          <div class="tk-mid"><span>${icon}</span></div>
          <div class="tk-end right"><b>${esc(o.toCode || "")}</b><small>${esc(o.toName || "")}</small></div>
        </div>`}
      </div>
      <div class="tk-stub">
        <div><small>${o.kind === "hotel" ? "체크인" : "날짜"}</small><b>${d}</b></div>
        <div><small>${o.kind === "hotel" ? "체크아웃" : "출발"}</small><b>${o.kind === "hotel" ? esc(o.dep || "--:--") : cell(o.dep, o.sugDep)}</b></div>
        <div><small>${o.kind === "hotel" ? "인원" : "도착"}</small><b>${o.kind === "hotel" ? esc(o.arr || "--:--") : cell(o.arr, o.sugArr)}</b></div>
        ${o.no ? `<div><small>${o.kind === "flight" ? "편명" : "번호"}</small><b>${esc(o.no)}</b></div>` : ""}
      </div>
      ${booked && o.kind !== "hotel" ? `<span class="tk-stamp">예매 완료</span>` : ""}
    </div>`;
}

// --- 항공권: 날짜·인원·구간을 채운 검색 화면 열기 ---
const expandedFlights = new Set();
const AIRPORT_CODES = {
  "인천": "ICN", "김포": "GMP", "김해": "PUS", "부산": "PUS", "제주": "CJU", "대구": "TAE", "청주": "CJJ",
  "광주": "KWJ", "목포": "KWJ", "순천": "RSU", "여수": "RSU", "무안": "MWX", "여수": "RSU", "양양": "YNY", "울산": "USN", "포항": "KPO", "사천": "HIN", "군산": "KUV", "원주": "WJU"
};
const KOREA_CODES = new Set(Object.values(AIRPORT_CODES));
// 해외 공항·도시 이름 → 코드 (템플릿·예전 일정처럼 코드가 없을 때 추정용)
const WORLD_AIRPORTS = [
  [/간사이|오사카|교토|고베|나라/, "KIX"], [/나리타/, "NRT"], [/하네다|도쿄/, "HND"], [/후쿠오카|규슈/, "FUK"],
  [/신치토세|삿포로|홋카이도/, "CTS"], [/나하|오키나와/, "OKA"], [/주부|나고야/, "NGO"], [/마쓰야마/, "MYJ"], [/시즈오카/, "FSZ"],
  [/쑹산|송산/, "TSA"], [/타오위안|타이베이|대만/, "TPE"], [/가오슝/, "KHH"], [/홍콩/, "HKG"], [/마카오/, "MFM"],
  [/돈므앙/, "DMK"], [/수완나품|방콕/, "BKK"], [/치앙마이/, "CNX"], [/푸껫|푸켓/, "HKT"],
  [/다낭/, "DAD"], [/깜라인|나트랑|냐짱/, "CXR"], [/하노이/, "HAN"], [/호치민|호찌민/, "SGN"], [/푸꾸옥/, "PQC"],
  [/세부/, "CEB"], [/보홀/, "TAG"], [/마닐라/, "MNL"], [/창이|싱가포르/, "SIN"], [/코타키나발루/, "BKI"], [/쿠알라룸푸르/, "KUL"],
  [/발리|덴파사르/, "DPS"], [/괌/, "GUM"], [/사이판/, "SPN"], [/푸동|상하이/, "PVG"], [/베이징/, "PEK"], [/칭다오/, "TAO"],
  [/울란바토르|몽골/, "UBN"], [/호놀룰루|하와이/, "HNL"], [/시드니/, "SYD"], [/샤를|파리/, "CDG"], [/히드로|런던/, "LHR"],
  [/로마/, "FCO"], [/바르셀로나/, "BCN"], [/프랑크푸르트/, "FRA"], [/뉴욕|JFK/, "JFK"], [/로스앤젤레스|LA\b/, "LAX"],
  [/샌프란시스코/, "SFO"], [/밴쿠버/, "YVR"], [/두바이/, "DXB"], [/이스탄불/, "IST"]
];
const DOMESTIC_ONLY_AIRPORTS = new Set(["KWJ", "RSU", "USN", "HIN", "KPO", "WJU", "KUV"]);
const ORIGIN_CODES = { "서울": "ICN", "인천": "ICN", "김포": "GMP", "부산": "PUS", "대구": "TAE", "청주": "CJJ", "광주": "KWJ", "제주": "CJU", "무안": "MWX", "양양": "YNY" };

function isAirportPlace(p) {
  return p && p.category === "transit" && /공항|airport/i.test(p.name || "");
}

function guessAirport(text) {
  const t = String(text || "");
  const code = airportCode(t);
  if (code) return code;
  const hit = WORLD_AIRPORTS.find(([re]) => re.test(t));
  return hit ? hit[1] : "";
}

function originAirport(trip, toCode) {
  const o = trip.origin || (() => { try { return localStorage.getItem("routy_origin"); } catch (e) { return ""; } })() || DEFAULT_ORIGIN;
  const key = Object.keys(ORIGIN_CODES).find(k => o.includes(k));
  let code = key ? ORIGIN_CODES[key] : (airportCode(o) || "ICN");
  // 국내선(예: 서울→제주)은 김포 출발
  if (code === "ICN" && KOREA_CODES.has(toCode)) code = "GMP";
  // 광주공항(KWJ) 등 국내선 전용 공항에서는 해외로 바로 못 가므로 인천 출발
  if (DOMESTIC_ONLY_AIRPORTS.has(code) && toCode && !KOREA_CODES.has(toCode)) code = "ICN";
  return code;
}

function rememberOrigin(v) {
  try {
    if (v) localStorage.setItem("routy_origin", v);
    return v || localStorage.getItem("routy_origin") || DEFAULT_ORIGIN;
  } catch (e) { return v || DEFAULT_ORIGIN; }
}

function airportCode(text) {
  const t = String(text || "");
  const m = t.match(/\(([A-Z]{3})\)/) || t.match(/\b([A-Z]{3})\b/);
  if (m) return m[1];
  const key = Object.keys(AIRPORT_CODES).find(k => t.includes(k));
  return key ? AIRPORT_CODES[key] : "";
}

function airportShort(text) {
  return String(text || "").replace(/\s*\([A-Z]{3}\)/, "").replace(/국제공항|공항/, "") || text;
}

// 이 일정의 비행 구간들 (코드가 있는 것만)
function flightLegs(trip) {
  const legs = [];
  for (let d = 1; d <= (trip.days || 1); d++) {
    trip.places.filter(p => p.day === d).forEach(p => {
      if (p.move && p.move.mode === "flight") {
        const from = airportCode(p.move.from), to = airportCode(p.move.to);
        if (from && to) legs.push({ place: p, from, to, day: d, date: getTripDate(trip, d) });
      }
    });
  }
  return legs;
}

// 이 구간과 짝이 되는 왕복 구간 찾기 (가는 편 ↔ 오는 편)
function flightTrip(trip, place) {
  const legs = flightLegs(trip);
  const leg = legs.find(l => l.place === place);
  if (!leg) return synthFlightTrip(trip, place);
  const back = legs.find(l => l !== leg && l.from === leg.to && l.to === leg.from);
  const out = back && back.day < leg.day ? back : leg;
  const ret = back ? (out === leg ? back : leg) : null;
  return { out, ret, people: Math.max(1, parseInt(trip.people, 10) || 1) };
}

// 비행 구간 정보가 없는 일정(템플릿·예전 일정): 출발 도시 ↔ 목적지 공항으로 첫날 가고 마지막 날 오는 왕복을 만든다
function synthFlightTrip(trip, place) {
  const airportPlace = place && isAirportPlace(place) ? place : trip.places.find(isAirportPlace);
  const dest = trip.arrivalAirport || guessAirport(airportPlace && airportPlace.name) || guessAirport(trip.destination);
  if (!dest) return null;
  const from = originAirport(trip, dest);
  if (from === dest) return null;
  const lastDay = trip.days || Math.max(...trip.places.map(p => p.day || 1));
  return {
    out: { from, to: dest, day: 1, date: getTripDate(trip, 1) },
    ret: lastDay > 1 ? { from: dest, to: from, day: lastDay, date: getTripDate(trip, lastDay) } : null,
    people: Math.max(1, parseInt(trip.people, 10) || 1),
    guessed: true
  };
}

function yymmdd(d) { return ymd(d).slice(2).replace(/-/g, ""); }

function flightLinks(ft) {
  const { out, ret, people } = ft;
  const enc = encodeURIComponent;
  const domestic = KOREA_CODES.has(out.from) && KOREA_CODES.has(out.to);
  const links = [];
  // 네이버 항공권
  if (out.date) {
    const seg = `${out.from}-${out.to}-${ymd(out.date).replace(/-/g, "")}` + (ret && ret.date ? `/${ret.from}-${ret.to}-${ymd(ret.date).replace(/-/g, "")}` : "");
    links.push({ key: "naver", label: "네이버 항공권", sub: domestic ? "국내선" : "여러 항공사 비교", url: `https://flight.naver.com/flights/${domestic ? "domestic" : "international"}/${seg}?adult=${people}&fareType=${domestic ? "YC" : "Y"}`, main: true });
  } else {
    links.push({ key: "naver", label: "네이버 항공권", sub: "날짜는 직접", url: "https://flight.naver.com/", main: true });
  }
  // 스카이스캐너
  const sk = out.date
    ? `${out.from.toLowerCase()}/${out.to.toLowerCase()}/${yymmdd(out.date)}/${ret && ret.date ? yymmdd(ret.date) + "/" : ""}`
    : `${out.from.toLowerCase()}/${out.to.toLowerCase()}/`;
  links.push({ key: "skyscanner", label: "스카이스캐너", sub: "최저가 비교", url: `https://www.skyscanner.co.kr/transport/flights/${sk}?adultsv2=${people}&cabinclass=economy&rtn=${ret && ret.date ? 1 : 0}` });
  // Google 항공편 (자연어 검색: 날짜·인원·왕복 인식 확인됨)
  const q = `Flights to ${out.to} from ${out.from}` + (out.date ? ` on ${ymd(out.date)}` : "") + (ret && ret.date ? ` through ${ymd(ret.date)}` : (out.date ? " oneway" : "")) + ` for ${people} adult${people > 1 ? "s" : ""}`;
  links.push({ key: "google", label: "Google 항공편", sub: "가격 추적", url: `https://www.google.com/travel/flights?q=${enc(q)}&hl=ko&curr=KRW` });
  if (state.activeTrip && tripKind(state.activeTrip) === "island") {
    links.push({ key: "ferry", label: "여객선", sub: "KSA 여객선예매(가보고싶은섬)", url: "https://island.haewun.co.kr/" });
  }
  return links;
}

function flightConnectorHtml(move, to) {
  const id = esc(to.id);
  const from = move.from ? airportShort(move.from) : "출발";
  const dest = move.to ? airportShort(move.to) : "도착";
  const codes = airportCode(move.from) && airportCode(move.to) ? ` (${airportCode(move.from)}→${airportCode(move.to)})` : "";
  const cost = move.cost ? ` · 약 ${formatWon(move.cost)}/인 (예상)` : "";
  const mins = move.minutes ? ` ${formatMinutes(move.minutes)}` : "";
  const ft = state.activeTrip && needsFlight(state.activeTrip) ? flightTrip(state.activeTrip, to) : null;
  const open = expandedFlights.has(to.id);
  const btn = ft ? `<button class="move-ticket" data-action="flights" data-id="${id}">${window.icon("flight", 14)}${open ? "접기" : "항공권 찾기"}</button>` : "";
  const panel = ft && open ? flightPanelHtml(ft, id) : "";
  return `<div class="move-connector move-flight">${window.icon("flight", 15)}<span class="move-main">비행기${move.note && /^[A-Z0-9]{2}\s?\d{2,4}$/.test(move.note) ? ` ${esc(move.note)}` : ""}${mins}${cost}</span><span class="move-leg">${esc(from)} → ${esc(dest)}${codes}</span>${btn}</div>${panel}`;
}

function flightPanelHtml(ft, id) {
  const { out, ret, people } = ft;
  const d = x => x.date ? `${x.date.getMonth() + 1}/${x.date.getDate()}` : "날짜 미정";
  const head = `${ret ? "왕복" : "편도"} · 가는 날 ${d(out)}${ret ? ` · 오는 날 ${d(ret)}` : ""} · ${people}명`;
  const fl = (state.activeTrip && state.activeTrip.flights) || {};
  const fo = fl.out && fl.out.from === out.from ? fl.out : {};
  const fr = fl.ret && ret && fl.ret.from === ret.from ? fl.ret : {};
  const nm = c => (AIRPORT_NAMES[c] || "").replace(/\(.*\)/, "");
  const sugOf = p => { const x = legSuggest(p); return { sugDep: x.dep, sugArr: x.arr }; };
  return `
      <div class="stay-panel flight-panel">
        <div class="stay-head"><span>${head}</span></div>
        <div class="tickets">
          ${ticketHtml(Object.assign({ kind: "flight", label: "가는 편", fromCode: out.from, toCode: out.to, fromName: nm(out.from), toName: nm(out.to), date: out.date, dep: fo.dep, arr: fo.arr, no: fo.no }, sugOf(out.place)))}
          ${ret ? ticketHtml(Object.assign({ kind: "flight", label: "오는 편", fromCode: ret.from, toCode: ret.to, fromName: nm(ret.from), toName: nm(ret.to), date: ret.date, dep: fr.dep, arr: fr.arr, no: fr.no }, sugOf(ret.place))) : ""}
        </div>
        ${ft.guessed ? `<div class="stay-hint">출발 도시와 여행 날짜로 첫날 가는 편·마지막 날 오는 편을 잡았어요. 공항이 다르면 사이트에서 바꿔 주세요.</div>` : ""}
        ${out.date ? "" : `<div class="stay-hint warn">여행 시작일이 없어 날짜 없이 열려요. 위쪽 날짜 칸에서 출발일을 정하면 날짜까지 채워져요.</div>`}
        <div class="stay-links">
          ${flightLinks(ft).map(l => `<button class="stay-link ${l.main ? "main" : ""}" data-action="flightsite" data-site="${l.key}" data-id="${id}"><b>${esc(l.label)}</b><small>${esc(l.sub)}</small></button>`).join("")}
        </div>
        ${state.activeTrip && state.activeTrip.transport === "rental" ? `<div class="ic-modes local-modes"><span>렌터카 (도착 공항에서 인수)</span></div>
        <div class="stay-links rental-links">${RENTAL_SITES.map(x => `<button class="stay-link" data-action="rentalsite" data-site="${x.k}"><b>${x.label}</b><small>${x.sub}</small></button>`).join("")}</div>
        <div class="stay-hint">렌터카: ${esc(rentalHint(state.activeTrip))}</div>` : ""}
        <button class="btn btn-sm ff-open" data-action="flightfit" data-id="${id}">${window.icon("calendar", 16)}${state.activeTrip && state.activeTrip.flights ? "항공편 시간 고치기" : "예약한 항공편 시간 넣고 일정 맞추기"}</button>
        <div class="stay-hint">항공권 가격은 사이트에서 실시간으로 확인돼요. 수하물 포함 여부는 항공사마다 달라요.</div>
      </div>`;
}

function bookedFlightsHtml(trip) {
  const f = trip && trip.flights;
  if (!f) return "";
  const line = (l, label) => l && (l.dep || l.arr) ? `<div>✈ ${label} ${l.no ? `<b>${esc(l.no)}</b> ` : ""}${esc(l.from)} ${esc(l.dep || "?")} → ${esc(l.to)} ${esc(l.arr || "?")}</div>` : "";
  return `<div class="ff-booked">${line(f.out, "가는 편")}${line(f.ret, "오는 편")}</div>`;
}

// ⋯ 메뉴: 일정 전체 기준 항공권 찾기 (비행 구간이나 공항 카드로 이동해 패널 펼치기)
function openTripFlights() {
  const trip = state.activeTrip;
  if (!needsFlight(trip)) {
    // 국내 내륙: 가는 길 기차·버스 예매 블록 열기
    expandedFlights.add(`rail-${trip.id}-1`);
    if (state.activeTripDay !== 1) { state.activeTripDay = 1; renderItineraryAll(); } else renderTimeline();
    setTimeout(() => {
      const el = document.querySelector(".rail-block");
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      else showToast("이미 일정에 기차·버스 구간이 있어요. 그 이동 칸의 예매 버튼을 눌러 주세요.", 4500);
    }, 100);
    return;
  }
  const leg = flightLegs(trip)[0];
  const target = leg ? leg.place : trip.places.find(isAirportPlace);
  if (!target && !synthFlightTrip(trip, null)) {
    showToast("목적지 공항을 알 수 없어요. 국내 기차·버스 여행이면 이동 칸의 예매 버튼을 써 주세요.", 4500);
    return;
  }
  if (target) {
    expandedFlights.add(target.id);
    if (state.activeTripDay !== target.day) { state.activeTripDay = target.day; renderItineraryAll(); } else renderTimeline();
    setTimeout(() => document.querySelector(".flight-panel")?.scrollIntoView({ block: "center", behavior: "smooth" }), 100);
  } else {
    const ft = synthFlightTrip(trip, null);
    window.open(flightLinks(ft)[0].url, "_blank", "noopener");
  }
}

function openFlightSite(place, key) {
  const ft = flightTrip(state.activeTrip, place);
  if (!ft) return;
  const link = flightLinks(ft).find(l => l.key === key);
  if (link) window.open(link.url, "_blank", "noopener");
}


// --- 예약한 항공편 시간에 맞춰 첫날·마지막 날 다시 짜기 ---
let flightFitFt = null;

function openFlightFit(place) {
  const trip = state.activeTrip;
  const ft = flightTrip(trip, place);
  if (!ft) return;
  ft.kind = "flight";
  ft.est = { out: (ft.out.place && ft.out.place.move && ft.out.place.move.minutes) || 120, ret: (ft.ret && ft.ret.place && ft.ret.place.move && ft.ret.place.move.minutes) || 120 };
  flightFitFt = ft;
  const $ = id => document.getElementById(id);
  setFitModalTexts("flight");
  const f = trip.flights || {};
  const d = x => x && x.date ? ` · ${x.date.getMonth() + 1}/${x.date.getDate()}` : "";
  $("ff-out-title").textContent = `가는 편 ${ft.out.from} → ${ft.out.to}${d(ft.out)} (Day ${ft.out.day})`;
  ["no", "dep", "arr"].forEach(k => { $(`ff-out-${k}`).value = (f.out && f.out[k]) || ""; $(`ff-ret-${k}`).value = (f.ret && f.ret[k]) || ""; });
  $("ff-ret").style.display = ft.ret ? "" : "none";
  if (ft.ret) $("ff-ret-title").textContent = `오는 편 ${ft.ret.from} → ${ft.ret.to}${d(ft.ret)} (Day ${ft.ret.day})`;
  $("flight-fit-overlay").classList.add("active");
}

function setFitModalTexts(kind) {
  const $ = id => document.getElementById(id);
  const ground = kind === "ground";
  $("ff-heading").textContent = ground ? "예매한 기차·버스 시간" : "예약한 항공편 시간";
  $("ff-help").innerHTML = ground
    ? "예매한 시간을 넣거나 '자동으로 정하기'를 누르면, 첫날은 도착 뒤부터·마지막 날은 출발 전에 끝나도록 일정을 다시 맞춰요."
    : "고른 항공편의 시간을 넣으면 첫날은 도착 뒤부터, 마지막 날은 공항에 늦지 않게 일정을 AI가 다시 짜요. 시간은 모두 <b>현지 시각</b>이에요.";
  document.querySelectorAll(".ff-no-label").forEach(l => { l.textContent = ground ? "열차·버스 번호 (선택)" : "편명 (선택)"; });
  $("ff-out-no").placeholder = ground ? "예: KTX 011" : "예: 7C1301";
  $("ff-ret-no").placeholder = ground ? "예: KTX 038" : "예: 7C1302";
  $("ff-mode-manual").classList.add("on");
  $("ff-mode-auto").classList.remove("on");
  $("ff-auto-note").textContent = "";
}

// 일정에 맞는 시간 자동 계산: 첫날 첫 일정 30분 전 도착, 마지막 날 마지막 일정 끝나고 40분 뒤 출발
function autoFitTimes(ft) {
  const trip = state.activeTrip;
  const round5 = m => Math.round(m / 5) * 5;
  const isEdge = p => p.intercity || (p.category === "transit" && STOP_RE.test(p.name));
  const out = {}, ret = {};
  const d1 = trip.places.filter(p => p.day === ft.out.day && !isEdge(p));
  const firstStart = d1.length ? parseTimeToMinutes(d1[0].time) : 10 * 60;
  const lead = ft.kind === "flight" ? 120 : 30; // 비행기는 입국·공항 이동 포함
  out.arr = minutesToHHMM(round5((isFinite(firstStart) && firstStart < 1440 ? firstStart : 600) - lead));
  out.dep = minutesToHHMM(round5(hhmmToMin(out.arr) - (ft.est.out || 120)));
  if (ft.ret) {
    const dl = trip.places.filter(p => p.day === ft.ret.day && !isEdge(p) && p.category !== "hotel");
    const lastEnd = dl.length ? ((parseTimeRange(dl[dl.length - 1].time) || [0, 17 * 60])[1]) : 17 * 60;
    const tail = ft.kind === "flight" ? 180 : 40; // 비행기는 공항 이동 + 출국 수속
    ret.dep = minutesToHHMM(Math.ceil((lastEnd + tail) / 10) * 10);
    ret.arr = minutesToHHMM(round5(hhmmToMin(ret.dep) + (ft.est.ret || 120)));
  }
  return { out, ret };
}

// 국내 기차·버스: 예매 시간 입력 창 열기
function openGroundFit() {
  const trip = state.activeTrip;
  const ic = trip.intercity;
  if (!ic) { showToast("먼저 '가는 길'에서 KTX·기차 또는 고속버스를 골라 주세요.", 3500); return; }
  const outP = trip.places.find(p => p.intercity === "out");
  const backP = trip.places.find(p => p.intercity === "back");
  const destStops = cityStops((trip.destination || "").split(/[\/,·]/)[0]);
  const est = destStops ? (ic.mode === "train" ? destStops.t : destStops.b) : null;
  const ft = {
    kind: "ground",
    out: { from: ic.from, to: ic.stop, day: 1, date: getTripDate(trip, 1), place: outP },
    ret: backP ? { from: ic.stop, to: ic.from, day: backP.day, date: getTripDate(trip, backP.day), place: backP } : null,
    est: { out: (est && est[0]) || 120, ret: (est && est[0]) || 120 }
  };
  flightFitFt = ft;
  const $ = id => document.getElementById(id);
  setFitModalTexts("ground");
  const d = x => x && x.date ? ` · ${x.date.getMonth() + 1}/${x.date.getDate()}` : "";
  $("ff-out-title").textContent = `가는 ${ic.service} ${ft.out.from} → ${ft.out.to}${d(ft.out)}`;
  const t = ic.times || {};
  ["no", "dep", "arr"].forEach(k => { $(`ff-out-${k}`).value = (t.out && t.out[k]) || ""; $(`ff-ret-${k}`).value = (t.ret && t.ret[k]) || ""; });
  $("ff-ret").style.display = ft.ret ? "" : "none";
  if (ft.ret) $("ff-ret-title").textContent = `오는 ${ic.service} ${ft.ret.from} → ${ft.ret.to}${d(ft.ret)}`;
  $("flight-fit-overlay").classList.add("active");
}

// 기차·버스 예매 시간에 맞춰 역·터미널 시간과 첫날·마지막 날 일정 조율
async function fitTripToGround(out, ret, opts = {}) {
  const trip = state.activeTrip;
  const ic = trip.intercity;
  const before = cloneTrip(trip);
  setGroundTimes(trip, out, ret);
  const outP = trip.places.find(p => p.intercity === "out");
  const backP = trip.places.find(p => p.intercity === "back");
  const pickP = trip.places.find(p => p.intercity === "pick"), dropP = trip.places.find(p => p.intercity === "drop");
  const rentalKeep = pickP || dropP ? " 렌터카 인수·반납 장소도 이름·시간 그대로 두세요." : "";
  const instr = {};
  if (out.arr) instr[1] = `예매한 ${ic.service}: ${ic.from} ${out.dep || ""} 출발 → ${ic.stop} ${out.arr} 도착. Day 1 맨 앞의 "${outP ? outP.name : ic.stop + " 도착"}"(category transit, time "${out.arr} - ${minutesToHHMM(hhmmToMin(out.arr) + 20)}")은 그대로 두고, ${ic.stop}에서 다음 장소까지 이동 시간을 고려해 그 뒤로 일정을 다시 배치하세요. 시간이 모자라면 장소를 빼거나 줄이고, 숙소는 유지하세요.${rentalKeep}`;
  if (ret && ret.dep && backP) instr[backP.day] = `예매한 ${ic.service}: ${ic.stop} ${ret.dep} 출발 → ${ic.from}${ret.arr ? ` ${ret.arr} 도착` : ""}. Day ${backP.day} 맨 끝의 "${backP.name}"(category transit, time "${minutesToHHMM(hhmmToMin(ret.dep) - 20)} - ${ret.dep}")은 그대로 두고, 그 전 장소들이 ${ic.stop}까지 이동 시간을 포함해 ${minutesToHHMM(hhmmToMin(ret.dep) - 20)} 전에 끝나도록 줄이거나 앞당기세요. 그 뒤 일정은 넣지 마세요.${rentalKeep}`;
  const days = Object.keys(instr).map(Number).sort((a, b) => a - b);
  const markEdges = () => {
    const d1 = trip.places.filter(p => p.day === 1);
    const o = d1.find(p => p.category === "transit" && p.name.includes(ic.stop));
    if (o) { o.intercity = "out"; o.coordChecked = true; }
    if (backP) {
      const dl = trip.places.filter(p => p.day === backP.day && p.category === "transit" && p.name.includes(ic.stop));
      if (dl.length) { dl[dl.length - 1].intercity = "back"; dl[dl.length - 1].coordChecked = true; }
    }
  };
  if (!window.RoutyAI.hasApiKey() || opts.quick) {
    // AI 없이(또는 차이가 작을 때): 첫날은 도착 뒤로 밀고, 마지막 날은 출발 전에 끝나게 앞당기기
    if (out.arr) {
      const first = trip.places.filter(p => p.day === 1 && !p.intercity)[0];
      const st = first ? parseTimeToMinutes(first.time) : NaN;
      const need = hhmmToMin(out.arr) + 30;
      if (first && isFinite(st) && st < need) shiftDayFrom(first.id, need - st);
    }
    if (backP && ret && ret.dep) {
      const dl = trip.places.filter(p => p.day === backP.day && !p.intercity && p.category !== "hotel");
      const end = dl.length ? (parseTimeRange(dl[dl.length - 1].time) || [0, 0])[1] : 0;
      const limit = hhmmToMin(ret.dep) - 40;
      if (dl.length && end > limit) {
        const firstSt = parseTimeToMinutes(dl[0].time);
        const delta = Math.max(limit - end, 8 * 60 - firstSt);
        if (delta < 0) dl.forEach(p => { p.time = shiftTimeString(p.time, delta); });
      }
    }
    sortTripPlaces(trip, 1);
    refineUndoTrip = before;
    renderItineraryAll();
    persistActiveTrip();
    setRefineMode("undo");
    showToast(opts.quick ? "일정과 거의 같은 시간이라 장소는 그대로 두고 시간만 맞췄어요." : "예매 시간에 맞춰 첫날·마지막 날 시간을 옮겼어요. 장소를 줄이거나 바꾸는 것까지 하려면 설정에서 Gemini 키를 넣어 주세요.", 5000);
    return;
  }
  const refineBtn = document.getElementById("btn-ai-refine");
  const form = document.getElementById("ai-refine-form");
  form.classList.add("loading");
  refineBtn.disabled = true;
  const changed = new Set();
  try {
    for (let i = 0; i < days.length; i++) {
      refineBtn.textContent = `Day ${days[i]} 맞추는 중…`;
      const ids = await applyAIRefine(instr[days[i]], days[i], { keepUndo: true });
      ids.forEach(id => changed.add(id));
      markEdges();
      renderItineraryAll();
    }
    refineUndoTrip = before;
    recentlyChanged = changed;
    renderItineraryAll();
    persistActiveTrip();
    setRefineMode("undo");
    verifyCoordinates(trip.id, Array.from(changed));
    autoPickTop(trip);
    showToast(`예매 시간에 맞춰 Day ${days.join("·Day ")} 일정을 다시 맞췄어요. 마음에 안 들면 '되돌리기'를 누르세요.`, 5000);
  } catch (e) {
    renderItineraryAll();
    persistActiveTrip();
    showToast(e.message || "일정을 다시 맞추지 못했어요.", 5000);
  } finally {
    refineBtn.disabled = false;
    form.classList.remove("loading");
    if (refineBtn.dataset.mode !== "undo") setRefineMode("normal");
  }
}

function hhmmToMin(v) {
  const m = String(v || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN;
}

function setupFlightFit() {
  const $ = id => document.getElementById(id);
  const overlay = $("flight-fit-overlay");
  if (!overlay) return;
  const close = () => overlay.classList.remove("active");
  $("btn-close-flight-fit").addEventListener("click", close);
  $("btn-cancel-flight-fit").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  $("ff-mode-manual").addEventListener("click", () => {
    $("ff-mode-manual").classList.add("on"); $("ff-mode-auto").classList.remove("on");
    $("ff-auto-note").textContent = "";
  });
  $("ff-mode-auto").addEventListener("click", () => {
    const ft = flightFitFt;
    if (!ft) return;
    const t = autoFitTimes(ft);
    $("ff-out-dep").value = t.out.dep || ""; $("ff-out-arr").value = t.out.arr || "";
    if (ft.ret) { $("ff-ret-dep").value = t.ret.dep || ""; $("ff-ret-arr").value = t.ret.arr || ""; }
    $("ff-mode-auto").classList.add("on"); $("ff-mode-manual").classList.remove("on");
    $("ff-auto-note").textContent = ft.kind === "flight"
      ? "일정에 맞는 시간을 채웠어요. 이 시간대 항공편을 예매 사이트에서 고른 뒤 실제 시간으로 고쳐 주세요."
      : "일정에 맞는 시간을 채웠어요. 이 시간대 표를 예매하고, 실제 시간이 다르면 고쳐 주세요.";
  });
  $("btn-apply-flight-fit").addEventListener("click", () => {
    const ft = flightFitFt;
    if (!ft) return;
    const read = (k, leg) => leg ? { no: $(`ff-${k}-no`).value.trim().toUpperCase(), dep: $(`ff-${k}-dep`).value, arr: $(`ff-${k}-arr`).value, from: leg.from, to: leg.to, day: leg.day } : null;
    const out = read("out", ft.out);
    const ret = ft.ret ? read("ret", ft.ret) : null;
    if (!out.arr && !(ret && ret.dep)) {
      showToast("가는 편 도착 시각이나 오는 편 출발 시각 중 하나는 넣어 주세요.", 3500);
      return;
    }
    close();
    // 일정에 잡혀 있던 시각과 45분 안쪽 차이면 시간만 옮기고, 크게 다르면 그날을 AI로 다시 짠다
    const trip = state.activeTrip;
    const planOut = ft.kind === "ground" ? legSuggest(trip.places.find(p => p.intercity === "out")).arr : legSuggest(ft.out.place).arr;
    const planRet = ft.kind === "ground" ? legSuggest(trip.places.find(p => p.intercity === "back"), "depart").dep : (ft.ret ? legSuggest(ft.ret.place).dep : "");
    const diffs = [];
    if (out.arr) diffs.push(planOut ? Math.abs(hhmmToMin(out.arr) - hhmmToMin(planOut)) : Infinity);
    if (ret && ret.dep) diffs.push(planRet ? Math.abs(hhmmToMin(ret.dep) - hhmmToMin(planRet)) : Infinity);
    const quick = diffs.length > 0 && diffs.every(d => d <= 45);
    if (ft.kind === "ground") fitTripToGround(out, ret, { quick });
    else fitTripToFlights(out, ret, { quick, ft });
  });
}

async function fitTripToFlights(out, ret, opts = {}) {
  const trip = state.activeTrip;
  trip.flights = { out, ret };
  const intl = !(KOREA_CODES.has(out.from) && KOREA_CODES.has(out.to));
  const instr = {};
  if (out.arr) {
    const arr = hhmmToMin(out.arr);
    instr[out.day] = (instr[out.day] ? instr[out.day] + "\n" : "") +
      `실제 예약한 가는 비행기: ${out.no || ""} ${out.from} ${out.dep || ""} 출발 → ${out.to} ${out.arr} 도착(현지 시각). ` +
      `Day ${out.day} 맨 앞에 도착 공항을 category "transit", time "${out.arr} - ${minutesToHHMM(arr + (intl ? 60 : 20))}"로 넣고 move는 mode "flight", from "${out.from} 공항(${out.from})", to "${out.to} 공항(${out.to})", minutes는 시차를 고려한 실제 비행 시간, note "${out.no || "예약한 항공편"}"으로 하세요. ` +
      `입국·짐 찾기와 공항에서 시내까지 이동 시간을 고려해 그 뒤부터 일정을 배치하고, 시간이 모자라는 장소는 빼거나 줄이세요. 숙소는 유지하세요.`;
  }
  if (ret && ret.dep) {
    const dep = hhmmToMin(ret.dep);
    const cutoff = dep - (intl ? 150 : 60);
    instr[ret.day] = (instr[ret.day] ? instr[ret.day] + "\n" : "") +
      `실제 예약한 오는 비행기: ${ret.no || ""} ${ret.from} ${ret.dep} 출발(현지 시각)${ret.arr ? ` → ${ret.to} ${ret.arr} 도착` : ""}. ` +
      `${intl ? "국제선이라 출발 2시간 30분 전" : "국내선이라 출발 1시간 전"}인 ${minutesToHHMM(cutoff)}까지 공항에 도착해야 합니다. ` +
      `Day ${ret.day} 끝에 출발 공항을 category "transit", time "${minutesToHHMM(cutoff)} - ${ret.dep}"로 넣고, 그 전 장소들은 공항까지 이동 시간을 포함해 ${minutesToHHMM(cutoff)} 전에 끝나도록 줄이거나 앞당기세요.` +
      (ret.arr ? ` 마지막에 도착 공항을 category "transit", time "${ret.arr} - ${minutesToHHMM(hhmmToMin(ret.arr) + 30)}", move는 mode "flight", from "${ret.from} 공항(${ret.from})", to "${ret.to} 공항(${ret.to})", note "${ret.no || "예약한 항공편"}"으로 넣으세요.` : "") +
      ` 그 뒤 일정은 넣지 마세요.`;
  }
  const days = Object.keys(instr).map(Number).sort((a, b) => a - b);
  if (!window.RoutyAI.hasApiKey() || opts.quick) {
    // AI 없이(또는 차이가 작을 때): 공항 시각을 고치고 첫날은 도착 뒤로, 마지막 날은 공항 가기 전에 끝나게
    const before = cloneTrip(trip);
    const ft = opts.ft;
    const outPlace = ft && ft.out && ft.out.place, retPlace = ft && ft.ret && ft.ret.place;
    if (outPlace && out.arr) {
      const r = parseTimeRange(outPlace.time) || [0, 60];
      outPlace.time = `${out.arr} - ${minutesToHHMM(hhmmToMin(out.arr) + Math.max(20, r[1] - r[0]))}`;
      if (outPlace.move) { outPlace.move.note = out.no || outPlace.move.note; const dm = hhmmToMin(out.arr) - hhmmToMin(out.dep); if (out.dep && dm > 0) outPlace.move.minutes = dm; }
    }
    if (retPlace && ret && ret.arr) {
      const r = parseTimeRange(retPlace.time) || [0, 30];
      retPlace.time = `${ret.arr} - ${minutesToHHMM(hhmmToMin(ret.arr) + Math.max(20, r[1] - r[0]))}`;
      if (retPlace.move) { retPlace.move.note = ret.no || retPlace.move.note; const dm = hhmmToMin(ret.arr) - hhmmToMin(ret.dep); if (ret.dep && dm > 0) retPlace.move.minutes = dm; }
    }
    if (out.arr) {
      const first = trip.places.filter(p => p.day === out.day && p.category !== "transit")[0];
      const startMin = first ? parseTimeToMinutes(first.time) : NaN;
      const need = hhmmToMin(out.arr) + (intl ? 120 : 60);
      if (first && isFinite(startMin) && startMin < need) shiftDayFrom(first.id, need - startMin);
    }
    if (ret && ret.dep) {
      const dl = trip.places.filter(p => p.day === ret.day && p.category !== "transit" && p.category !== "hotel");
      const end = dl.length ? (parseTimeRange(dl[dl.length - 1].time) || [0, 0])[1] : 0;
      const limit = hhmmToMin(ret.dep) - (intl ? 210 : 120); // 공항 이동 + 수속
      if (dl.length && end > limit) {
        const delta = Math.max(limit - end, 8 * 60 - parseTimeToMinutes(dl[0].time));
        if (delta < 0) dl.forEach(p => { p.time = shiftTimeString(p.time, delta); });
      }
    }
    sortTripPlaces(trip, out.day);
    if (ret) sortTripPlaces(trip, ret.day);
    refineUndoTrip = before;
    renderItineraryAll();
    persistActiveTrip();
    setRefineMode("undo");
    showToast(opts.quick ? "일정과 거의 같은 시간이라 장소는 그대로 두고 시간만 맞췄어요." : "항공편 시간에 맞춰 첫날·마지막 날 시간을 옮겼어요. 장소를 줄이거나 바꾸는 것까지 하려면 설정에서 Gemini 키를 넣어 주세요.", 5000);
    return;
  }
  const refineBtn = document.getElementById("btn-ai-refine");
  const form = document.getElementById("ai-refine-form");
  form.classList.add("loading");
  refineBtn.disabled = true;
  let changed = new Set();
  try {
    for (let i = 0; i < days.length; i++) {
      refineBtn.textContent = `Day ${days[i]} 맞추는 중…`;
      const ids = await applyAIRefine(instr[days[i]], days[i], { keepUndo: i > 0 });
      ids.forEach(id => changed.add(id));
      renderItineraryAll();
    }
    recentlyChanged = changed;
    renderItineraryAll();
    persistActiveTrip();
    setRefineMode("undo");
    verifyCoordinates(trip.id, Array.from(changed));
    autoPickTop(trip);
    showToast(`항공편 시간에 맞춰 Day ${days.join("·Day ")} 일정을 다시 짰어요. 마음에 안 들면 '되돌리기'를 누르세요.`, 5000);
  } catch (e) {
    persistActiveTrip();
    showToast(e.message || "일정을 다시 짜지 못했어요.", 5000);
  } finally {
    refineBtn.disabled = false;
    form.classList.remove("loading");
    if (refineBtn.dataset.mode !== "undo") setRefineMode("normal");
  }
}

// --- 기차·고속버스 예매 연결 (국내) ---
const TICKET_SITES = {
  korail: { label: "코레일", url: "https://www.korail.com/ticket/search/general" },
  srt: { label: "SRT", url: "https://etk.srail.kr/" },
  kobus: { label: "고속버스", url: "https://www.kobus.co.kr/" },
  bustago: { label: "시외버스", url: "https://www.bustago.or.kr/" }
};

function ticketInfo(move, from, to) {
  if (!move || (move.mode !== "train" && move.mode !== "express")) return null;
  // 해외 구간은 연결할 국내 예매처가 없음
  const pts = [from, to].filter(hasCoords);
  if (pts.length && !pts.every(p => isInKorea(p.lat, p.lng))) return null;
  const text = `${move.service || ""} ${move.note || ""} ${move.from || ""}`;
  if (move.mode === "train") {
    return /SRT|수서|동탄|평택지제/i.test(text) ? TICKET_SITES.srt : TICKET_SITES.korail;
  }
  return /시외/.test(text) ? TICKET_SITES.bustago : TICKET_SITES.kobus;
}

async function openTicketSite(place) {
  const prevIdx = state.activeTrip.places.filter(p => p.day === place.day).indexOf(place) - 1;
  const from = prevIdx >= 0 ? state.activeTrip.places.filter(p => p.day === place.day)[prevIdx] : null;
  const site = ticketInfo(place.move, from, place);
  if (!site) return;
  const m = place.move;
  const date = getTripDate(state.activeTrip, place.day);
  const dateTxt = date ? `${date.getMonth() + 1}월 ${date.getDate()}일 ` : "";
  const leg = m.from || m.to ? `${m.from || "?"} → ${m.to || "?"}` : "";
  const msg = `${site.label} 사이트에서 ${dateTxt}${leg}${m.service ? ` ${m.service}` : ""}을(를) 골라 예매하세요.`.replace(/\s+/g, " ");
  // 예매 사이트에 값을 미리 채울 방법이 없어, 고를 내용을 안내하고 복사해 둔다
  // 사파리 팝업 차단을 피하려면 새 창은 클릭 직후(기다리기 전에) 열어야 함
  window.open(site.url, "_blank", "noopener");
  try { if (leg && navigator.clipboard) await navigator.clipboard.writeText(`${dateTxt}${leg}`.trim()); } catch (e) {}
  showToast(msg, 6000);
}

// --- 국내 이동: 네이버 지도 앱 길찾기 (실제 버스 번호·정류장·실시간 도착) ---
const NAVER_ROUTE_TYPE = { walk: "walk", bike: "walk", car: "car", taxi: "car" }; // 나머지는 대중교통
const NAVER_ROUTE_LABEL = { public: "버스·지하철 경로", car: "자동차 경로", walk: "도보 경로" };

function hasCoords(p) {
  return p && !p.coordMissing && isFinite(p.lat) && isFinite(p.lng) && (p.lat || p.lng);
}

function naverRouteType(mode, trip) {
  if (mode && NAVER_ROUTE_TYPE[mode]) return NAVER_ROUTE_TYPE[mode];
  if (!mode && trip) {
    if (["car", "rental", "taxi"].includes(trip.transport)) return "car";
    if (trip.transport === "walk") return "walk";
  }
  return "public";
}

function naverRouteBtnHtml(from, to, mode) {
  if (mode === "flight" || mode === "ferry") return "";
  if (!hasCoords(from) || !hasCoords(to)) return "";
  if (!isInKorea(from.lat, from.lng) || !isInKorea(to.lat, to.lng)) return "";
  const type = naverRouteType(mode, state.activeTrip);
  return `<button class="move-route" data-action="naviroute" data-from="${esc(from.id)}" data-id="${esc(to.id)}">${window.icon("navigate", 14)}${NAVER_ROUTE_LABEL[type]}</button>`;
}

function isTouchDevice() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function naverRouteUrl(from, to, type) {
  const n = v => encodeURIComponent(String(v || "").slice(0, 40));
  const app = encodeURIComponent(location.origin + location.pathname);
  return `nmap://route/${type}?slat=${from.lat}&slng=${from.lng}&sname=${n(from.name)}&dlat=${to.lat}&dlng=${to.lng}&dname=${n(to.name)}&appname=${app}`;
}

function openNaverRoute(from, to) {
  const type = naverRouteType(to.move && to.move.mode, state.activeTrip);
  const kakaoTo = getPlaceLinks(to).routeUrl;
  if (!isTouchDevice()) {
    window.open(kakaoTo, "_blank", "noopener");
    showToast("네이버 지도 앱 길찾기는 아이폰·아이패드에서 열려요. 여기서는 카카오맵으로 열었어요.", 4500);
    return;
  }
  let left = false;
  const onHide = () => { if (document.hidden) left = true; };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);
  location.href = naverRouteUrl(from, to, type);
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
    if (left || document.hidden) return;
    showToast("네이버 지도 앱이 열리지 않았어요. 앱이 설치돼 있는지 확인해 주세요.", 7000, {
      label: "카카오맵으로",
      onClick: () => window.open(kakaoTo, "_blank", "noopener")
    });
  }, 2000);
}

// --- 바로 길안내: 지금 위치 → 이 장소 (네이버 지도 앱) ---
function openNmapWithFallback(url, fallbackUrl) {
  let left = false;
  const onHide = () => { if (document.hidden) left = true; };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);
  location.href = url;
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
    if (left || document.hidden) return;
    showToast("네이버 지도 앱이 열리지 않았어요. 앱이 설치돼 있는지 확인해 주세요.", 7000, {
      label: "다른 지도로",
      onClick: () => window.open(fallbackUrl, "_blank", "noopener")
    });
  }, 2000);
}

function startNavigation(place) {
  const trip = state.activeTrip;
  const links = getPlaceLinks(place);
  if (!hasCoords(place) || !isInKorea(place.lat, place.lng)) {
    // 해외·위치 모름: Google 지도 길찾기 (지금 위치 출발)
    window.open(links.routeUrl, "_blank", "noopener");
    return;
  }
  if (!isTouchDevice()) {
    window.open(links.routeUrl, "_blank", "noopener");
    showToast("네이버 지도 길안내는 아이폰·아이패드에서 바로 시작돼요. 여기서는 카카오맵으로 열었어요.", 4500);
    return;
  }
  const mode = (place.move && place.move.mode) || "";
  const t = trip.transport || "auto";
  const driving = ["car", "taxi"].includes(mode) || (!mode && ["car", "rental", "taxi"].includes(t));
  const walking = mode === "walk" || mode === "bike" || (!mode && t === "walk");
  const n = v => encodeURIComponent(String(v || "").slice(0, 40));
  const app = encodeURIComponent(location.origin + location.pathname);
  const dest = `dlat=${place.lat}&dlng=${place.lng}&dname=${n(place.name)}&appname=${app}`;
  // 출발지를 비우면 네이버 지도가 지금 위치에서 출발
  const url = driving ? `nmap://navigation?${dest}` : walking ? `nmap://route/walk?${dest}` : `nmap://route/public?${dest}`;
  openNmapWithFallback(url, links.routeUrl);
}

async function deleteActiveDay() {
  const t = state.activeTrip;
  if (!t) return;
  if (t.days <= 1) {
    showToast("하루짜리 일정은 날짜를 삭제할 수 없어요.");
    return;
  }
  const d = state.activeTripDay;
  const count = t.places.filter(p => p.day === d).length;
  const ok = await uiConfirm(`Day ${d}${count ? `과 장소 ${count}곳` : ""}을(를) 삭제할까요? 이후 날짜는 하루씩 앞당겨져요.`, { okText: "삭제", danger: true });
  if (!ok) return;
  withUndo(`Day ${d}을(를) 삭제했습니다.`, () => {
    t.places = t.places.filter(p => p.day !== d);
    t.places.forEach(p => { if (p.day > d) p.day -= 1; });
    t.days -= 1;
    state.activeTripDay = Math.min(d, t.days);
  });
}

async function askDelay(placeId) {
  const place = state.activeTrip.places.find(p => p.id === placeId);
  if (!place) return;
  const v = await uiPrompt("얼마나 늦어졌나요? (분)", "30", { okText: "이후 일정 미루기", placeholder: "예: 30" });
  const min = parseInt(v, 10);
  if (!min) return;
  withUndo(`"${place.name}"부터 오늘 일정을 ${min}분 미뤘어요.`, () => shiftDayFrom(placeId, min));
}

// --- 식당 후보 ---
const expandedAlts = new Set();

function altChipHtml(place) {
  const id = esc(place.id);
  if (place.alternatives && place.alternatives.length) {
    const open = expandedAlts.has(place.id);
    return `<button class="chip-btn chip-alt ${open ? "on" : ""}" data-action="alts" data-id="${id}">${window.icon("list", 16)}${open ? "후보 접기" : `다른 후보 ${place.alternatives.length}곳`}</button>`;
  }
  if (place.category === "restaurant" && window.RoutyAI.hasApiKey()) {
    return `<button class="chip-btn chip-alt" data-action="suggest" data-id="${id}">${window.icon("sparkles", 16)}후보 추천받기</button>`;
  }
  return "";
}

function altListHtml(place) {
  const id = esc(place.id);
  const trip = state.activeTrip;
  return `
    <div class="alt-list">
      ${(place.alternatives || []).map((a, i) => `
        <div class="alt-item">
          <div class="alt-body">
            <strong>${esc(a.name)}</strong>
            ${a.description ? `<span>${esc(a.description)}</span>` : ""}
            ${a.price ? `<em>${placePriceLabel({ price: a.price, priceUnit: "person" }, trip)}</em>` : ""}
          </div>
          <div class="alt-actions">
            <button class="chip-btn chip-icon" data-action="altmap" data-alt="${i}" data-id="${id}" aria-label="지도">${window.icon("map", 16)}</button>
            <button class="chip-btn chip-primary" data-action="pick" data-alt="${i}" data-id="${id}">이걸로</button>
          </div>
        </div>`).join("")}
    </div>`;
}

function toggleAlternatives(placeId) {
  if (expandedAlts.has(placeId)) expandedAlts.delete(placeId);
  else expandedAlts.add(placeId);
  renderTimeline();
}

// 후보와 현재 식당을 맞바꿈 (현재 식당은 후보 목록으로)
function pickAlternative(placeId, i) {
  const place = state.activeTrip.places.find(p => p.id === placeId);
  const alt = place && place.alternatives && place.alternatives[i];
  if (!alt) return;
  if (window.closeSeniorDetailModal) window.closeSeniorDetailModal();
  withUndo(`"${alt.name}"(으)로 바꿨어요. 원래 식당은 후보에 남아 있어요.`, () => {
    const current = {
      name: place.name,
      searchName: place.searchName || "",
      lat: place.lat,
      lng: place.lng,
      description: place.description || "",
      price: place.price
    };
    place.name = alt.name;
    place.searchName = alt.searchName || "";
    place.lat = alt.lat;
    place.lng = alt.lng;
    place.description = alt.description || "";
    if (alt.price !== undefined) place.price = alt.price;
    place.priceUnit = "person";
    place.coordMissing = false;
    place.coordFixed = false;
    place.coordChecked = false;
    place.alternatives[i] = current;
  });
  if (state.activeTrip.source === "ai") verifyCoordinates(state.activeTrip.id, [placeId]);
}

async function suggestAlternatives(placeId, btn) {
  const trip = state.activeTrip;
  const place = trip.places.find(p => p.id === placeId);
  if (!place) return;
  if (!window.RoutyAI.hasApiKey()) {
    showToast("식당 추천은 설정에서 Gemini API 키를 등록해야 쓸 수 있어요.");
    return;
  }
  btn.disabled = true;
  btn.textContent = "찾는 중…";
  try {
    const list = await window.RoutyAI.suggestRestaurants(trip, place);
    // 응답을 기다리는 사이 다른 일정으로 바뀌었으면 무시
    if (state.activeTrip !== trip) return;
    place.alternatives = list;
    expandedAlts.add(placeId);
    renderTimeline();
    persistActiveTrip();
    showToast(`근처 인기 식당 ${list.length}곳을 찾았어요. '이걸로'로 바꿀 수 있어요.`);
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = `${window.icon("sparkles", 16)}후보 추천받기`;
    showToast(e.message || "식당 후보를 찾지 못했어요.", 4000);
  }
}


// --- 주변 TOP 5 (Google Places 별점·리뷰수) ---
// 별점/리뷰수는 저장하지 않고 메모리에만 둔다 (Google 약관). 고른 식당은 place id만 기록.
const topPanel = { placeId: null, sort: "rating", items: [], loading: false, error: "" };
const topCache = new Map(); // "lat,lng,type" → items (이번 실행 동안만)
const TOP_MIN_REVIEWS = 30;

function topChipHtml(place) {
  if (!["restaurant", "cafe"].includes(place.category)) return "";
  if (!window.RoutyAI.hasPlacesKey() || typeof place.lat !== "number") return "";
  const open = topPanel.placeId === place.id;
  return `<button class="chip-btn chip-top ${open ? "on" : ""}" data-action="top5" data-id="${esc(place.id)}">${window.icon("star", 16)}${open ? "TOP 5 접기" : "주변 TOP 5"}</button>`;
}

function rankTopItems(items, sort) {
  items = items.slice();
  if (sort === "count") {
    return items.sort((a, b) => b.count - a.count || b.rating - a.rating).slice(0, 5);
  }
  // 별점순: 리뷰 30개 이상인 곳을 먼저, 모자라면 리뷰 적은 곳을 뒤에 채운다 (별점 5.0·리뷰 2개가 1위가 되지 않게)
  const byRating = (a, b) => b.rating - a.rating || b.count - a.count;
  const tiers = [
    items.filter(i => i.count >= TOP_MIN_REVIEWS),
    items.filter(i => i.count >= 5 && i.count < TOP_MIN_REVIEWS),
    items.filter(i => i.count < 5)
  ];
  return tiers.flatMap(t => t.sort(byRating)).slice(0, 5);
}

function sortedTopItems() {
  const pool = budgetFit(topPanel.items, state.activeTrip && state.activeTrip.budget);
  return dietSort(rankTopItems(pool.filter(i => !dietConflict(i)), topPanel.sort)
    .concat(rankTopItems(pool.filter(i => dietConflict(i)), topPanel.sort))).slice(0, 5);
}

// 소비 성향에 안 맞는 가격대 제외 (가격 정보 없는 곳은 남김)
const PRICE_BLOCK = {
  low: ["PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"],
  medium: ["PRICE_LEVEL_VERY_EXPENSIVE"],
  high: []
};
function budgetFit(items, budget) {
  const block = PRICE_BLOCK[budget] || PRICE_BLOCK.medium;
  const fit = items.filter(i => !block.includes(i.priceLevel));
  return fit.length ? fit : items;
}

// 일정 생성 직후: 식당·카페를 주변 Google 1위로 자동 교체 (원래 식당은 후보로)
const autoTopRunning = new Set();
async function autoPickTop(trip, opts = {}) {
  if (!window.RoutyAI.hasPlacesKey() || !trip) return;
  if (autoTopRunning.has(trip.id)) return;
  autoTopRunning.add(trip.id);
  try {
    await autoPickTopInner(trip, opts);
  } finally {
    autoTopRunning.delete(trip.id);
  }
}

async function autoPickTopInner(trip, opts = {}) {
  const sort = window.RoutyAI.getSettings().placesSort;
  // 직접 추가한 식당(custom-)은 사용자가 고른 곳이라 자동으로 바꾸지 않음 (메뉴로 강제할 때는 포함)
  const targets = trip.places.filter(p => ["restaurant", "cafe"].includes(p.category) && !p.googlePlaceId && !/조식/.test(p.name || "")
    && (opts.force || (!p.autoTopTried && !String(p.id).startsWith("custom-"))) && hasCoords(p));
  if (!targets.length) {
    if (opts.force) showToast("바꿀 식당이 없어요. 이미 모두 Google에서 고른 곳이에요.", 4000);
    return;
  }
  const used = new Set(trip.places.filter(p => p.googlePlaceId).map(p => p.googlePlaceId));
  let picked = 0, stopped = "";
  renderAutoTopStatus(`Google ${sort === "count" ? "리뷰수" : "별점"} 1위 식당 찾는 중… 0/${targets.length}`);
  for (let i = 0; i < targets.length; i++) {
    const place = targets[i];
    if (findTripById(trip.id) !== trip || !trip.places.includes(place)) continue;
    const center = { lat: place.lat, lng: place.lng };
    try {
      const { items } = await fetchTopItems(place, trip);
      place.autoTopTried = true; // 조회에 성공했을 때만 표시 (실패하면 다음에 다시 시도)
      // 식성에 안 맞는 곳은 1위 후보에서 빼고, 남는 곳이 없으면 AI가 고른 식당을 그대로 둔다
      let pool = budgetFit(items, trip.budget).filter(it => !dietConflict(it));
      // 여행 날짜가 있으면 그날 휴무이거나 방문 시간에 문 닫은 곳은 빼기 (남는 곳이 없으면 그대로)
      if (getTripDate(trip, place.day)) {
        const open = pool.filter(it => { const st = openingStatus(it, place); return !st || !st.warn; });
        if (open.length) pool = open;
      }
      const ranked = rankTopItems(pool, sort);
      const best = ranked.find(it => !used.has(it.id));
      if (best && trip.places.includes(place)) {
        used.add(best.id);
        applyTopPick(place, best, center);
        place.autoTop = sort;
        picked++;
      }
    } catch (e) {
      stopped = e.message || "";
      if (/한도|할당량|거부|키/.test(stopped)) break;
    }
    renderAutoTopStatus(`Google ${sort === "count" ? "리뷰수" : "별점"} 1위 식당 찾는 중… ${i + 1}/${targets.length}`);
  }
  renderAutoTopStatus("");
  if (state.activeTrip === trip) {
    renderItineraryAll();
    persistActiveTrip();
  }
  if (opts.force && !picked && !stopped) showToast("주변에서 조건(식성·가격대)에 맞는 곳을 찾지 못해 그대로 뒀어요.", 5000);
  if (picked) showToast(`식당 ${picked}곳을 Google ${sort === "count" ? "리뷰수" : "별점"} 1위로 골랐어요. 'TOP 5'에서 바꿀 수 있어요.`, 5000);
  else if (stopped) showToast(`Google 식당 조회를 못 했어요: ${stopped}`, 5000);
}

function renderAutoTopStatus(text) {
  const el = document.getElementById("verify-status");
  if (!el) return;
  if (text) {
    el.dataset.autotop = "1";
    el.textContent = text;
    el.style.display = "";
  } else if (el.dataset.autotop) {
    delete el.dataset.autotop;
    renderVerifyStatus();
  }
}

function findTopItem(pid) {
  return topPanel.items.find(i => i.id === pid);
}

function topPanelHtml(place) {
  const id = esc(place.id);
  const head = `
    <div class="top-head">
      <div class="seg" role="tablist">
        <button class="seg-btn ${topPanel.sort === "rating" ? "on" : ""}" data-action="topsort" data-sort="rating" data-id="${id}">별점순</button>
        <button class="seg-btn ${topPanel.sort === "count" ? "on" : ""}" data-action="topsort" data-sort="count" data-id="${id}">리뷰수순</button>
      </div>
      <span class="top-attr">${topPanel.query ? `'${esc(topPanel.query)}' · ` : ""}주변 · Google 지도</span>
    </div>`;
  let body;
  if (topPanel.loading) body = `<div class="top-empty">주변 ${place.category === "cafe" ? "카페" : "식당"}를 찾는 중…</div>`;
  else if (topPanel.error) body = `<div class="top-empty">${esc(topPanel.error)}</div>`;
  else {
    const list = sortedTopItems();
    body = list.length ? list.map((it, i) => {
      const current = it.id === place.googlePlaceId;
      return `
        <div class="top-item ${current ? "is-current" : ""}">
          <span class="top-rank">${i + 1}</span>
          <div class="alt-body">
            <strong>${esc(it.name)}</strong>
            ${dietConflict(it) ? `<span class="diet-tag">${esc(dietConflict(it))}</span>` : ""}
            <span class="top-meta"><b>★ ${it.rating ? it.rating.toFixed(1) : "-"}</b> 리뷰 ${it.count.toLocaleString("ko-KR")}${it.typeLabel ? ` · ${esc(it.typeLabel)}` : ""}${place.lat ? ` · ${formatDistance(distanceMeters(place, it))}` : ""}</span>
          </div>
          <div class="alt-actions">
            <button class="chip-btn chip-icon" data-action="topmap" data-pid="${esc(it.id)}" data-id="${id}" aria-label="Google 지도에서 보기">${window.icon("map", 16)}</button>
            ${current ? `<span class="top-current">지금 일정</span>` : `<button class="chip-btn chip-primary" data-action="toppick" data-pid="${esc(it.id)}" data-id="${id}">이걸로</button>`}
          </div>
        </div>`;
    }).join("") : `<div class="top-empty">주변 1km 안에서 찾지 못했어요.</div>`;
  }
  return `<div class="top-panel">${head}<div class="top-list">${body}</div></div>`;
}

function distanceMeters(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;
}


// 식당의 음식 종류: AI가 준 cuisine, 없으면 '교토 가이세키 요리 전문점 (점심)' 같은 뭉뚱그린 이름에서 뽑는다
function topQueryOf(place, trip) {
  if (place.topQuery !== undefined) return place.topQuery;
  if (place.cuisine) return place.cuisine;
  const name = place.name || "";
  if (!/전문점|맛집|식당|요리점|레스토랑|\((아침|점심|저녁|브런치)\)|카페$/.test(name)) return "";
  const dest = (trip && trip.destination || "").split(/[\s,·/]+/).filter(Boolean);
  let q = name.replace(/\([^)]*\)/g, " ");
  dest.forEach(d => { q = q.split(d).join(" "); });
  q = q.replace(/전문점|맛집|식당가?|요리점|레스토랑|요리|정통|원조|유명한?|현지|인기|로컬|근처|주변/g, " ").replace(/\s+/g, " ").trim();
  return q.length >= 1 && q.length <= 15 ? q : "";
}

function topCacheKey(place, trip) {
  const c = place.topCenter || { lat: place.lat, lng: place.lng };
  return `${c.lat.toFixed(4)},${c.lng.toFixed(4)},${place.category === "cafe" ? "cafe" : "restaurant"},${topQueryOf(place, trip)}`;
}

// 같은 음식 종류로 주변(약 2km)을 먼저 찾고, 없으면 종류 상관없이 반경 1km 인기 식당
async function fetchTopItems(place, trip) {
  const center = place.topCenter || { lat: place.lat, lng: place.lng };
  const type = place.category === "cafe" ? "cafe" : "restaurant";
  const query = topQueryOf(place, trip);
  const key = topCacheKey(place, trip);
  if (topCache.has(key)) return { items: topCache.get(key), query };
  let items = [];
  if (query) {
    items = (await window.RoutyAI.placesText(query, center.lat, center.lng, { type }))
      .filter(i => distanceMeters(center, i) <= 2500);
  }
  if (!items.length) items = await window.RoutyAI.placesNearby(center.lat, center.lng, { type });
  topCache.set(key, items);
  // 같은 검색 결과에 이미 일정에 넣은 식당이 있으면 그 정보 줄도 추가 조회 없이 채움
  const inTrip = new Set(((trip && trip.places) || []).map(p => p.googlePlaceId).filter(Boolean));
  items.forEach(it => { if (inTrip.has(it.id) && !placeInfo.has(it.id)) rememberPlaceInfo(it.id, it); });
  items.forEach(i => { if (!placeInfo.has(i.id)) placeInfo.set(i.id, i); });
  if (!place.topCenter) place.topCenter = center;
  if (place.topQuery === undefined) place.topQuery = query;
  return { items, query };
}

async function toggleTopPanel(placeId) {
  if (topPanel.placeId === placeId) {
    topPanel.placeId = null;
    renderTimeline();
    return;
  }
  const trip = state.activeTrip;
  const place = trip.places.find(p => p.id === placeId);
  if (!place) return;
  const cached = topCache.get(topCacheKey(place, trip));
  Object.assign(topPanel, { placeId, items: [], error: "", loading: !cached, sort: window.RoutyAI.getSettings().placesSort, query: topQueryOf(place, trip) });
  if (cached) {
    topPanel.items = cached;
    renderTimeline();
    return;
  }
  renderTimeline();
  try {
    const { items, query } = await fetchTopItems(place, trip);
    if (topPanel.placeId !== placeId || state.activeTrip !== trip) return;
    topPanel.items = items;
    topPanel.query = query;
  } catch (e) {
    if (topPanel.placeId !== placeId) return;
    topPanel.error = e.message || "주변 식당을 불러오지 못했어요.";
  }
  topPanel.loading = false;
  renderTimeline();
}

function setTopSort(sort) {
  topPanel.sort = sort === "count" ? "count" : "rating";
  renderTimeline();
}

function pickTopPlace(placeId, pid) {
  const place = state.activeTrip.places.find(p => p.id === placeId);
  const it = findTopItem(pid);
  if (!place || !it) return;
  withUndo(`"${it.name}"(으)로 바꿨어요. 원래 식당은 후보에 남아 있어요.`, () => {
    applyTopPick(place, it);
    delete place.autoTop;
  });
}

function applyTopPick(place, it, center) {
  if (place.category === "restaurant" || place.category === "cafe") {
    const prev = {
      name: place.name, searchName: place.searchName || "", lat: place.lat, lng: place.lng,
      description: place.description || "", price: place.price
    };
    const others = (place.alternatives || []).filter(a => a.name !== it.name);
    place.alternatives = [prev].concat(others).slice(0, 5);
  }
  if (!place.topCenter) place.topCenter = center || { lat: place.lat, lng: place.lng };
  place.name = it.name;
  place.searchName = "";
  place.lat = it.lat;
  place.lng = it.lng;
  // AI가 쓴 설명(예: 부모님 입맛에 맞는 정갈한 가이세키)은 그대로 두고, 가게 정보는 Google 정보 줄로 보여 준다
  if (!place.description || /Google 지도에서 고른 곳$/.test(place.description)) place.description = "";
  place.googlePlaceId = it.id;
  // 검색 결과에 별점·영업시간이 이미 있으니 정보 줄을 위해 다시 조회하지 않는다
  if (it.id && (it.rating || it.periods)) rememberPlaceInfo(it.id, it);
  place.coordMissing = false;
  place.coordFixed = false;
  place.coordChecked = true; // Google 좌표라 다시 보정할 필요 없음
}

// AI가 바꾼 장소 표시용
let recentlyChanged = new Set();
let refineScope = "day";

function updateRefineScopeLabel() {
  const btn = document.getElementById("btn-refine-scope");
  if (!btn || !state.activeTrip) return;
  btn.textContent = refineScope === "day" ? `Day ${state.activeTripDay}만` : "전체";
  btn.classList.toggle("is-all", refineScope === "all");
  const input = document.getElementById("ai-refine-input");
  input.placeholder = refineScope === "day"
    ? `Day ${state.activeTripDay} 수정 요청 (예: 오후는 실내 위주로)`
    : "전체 일정 수정 요청 (예: 하루 더 여유롭게)";
}

// --- AI 좌표 검증: OpenStreetMap에서 실제 위치를 찾아 크게 다르면 보정 ---
const verifyState = { tripId: null, done: 0, total: 0, fixed: 0, running: false };
const verifyQueue = [];

function distanceKm(a, b) {
  const R = 6371, toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function medianCenter(places) {
  const pts = places.filter(p => !p.coordMissing);
  if (!pts.length) return null;
  const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return { lat: med(pts.map(p => p.lat)), lng: med(pts.map(p => p.lng)) };
}

function verifyCoordinates(tripId, placeIds) {
  if (!placeIds || !placeIds.length) return;
  placeIds.forEach(id => verifyQueue.push({ tripId, id }));
  if (verifyState.tripId !== tripId) Object.assign(verifyState, { tripId, done: 0, total: 0, fixed: 0 });
  verifyState.total += placeIds.length;
  renderVerifyStatus();
  if (!verifyState.running) runVerifyQueue();
}

function findTripById(tripId) {
  if (state.activeTrip && state.activeTrip.id === tripId) return state.activeTrip;
  return state.savedTrips.find(t => t.id === tripId) || null;
}

async function runVerifyQueue() {
  verifyState.running = true;
  while (verifyQueue.length) {
    const job = verifyQueue.shift();
    const trip = findTripById(job.tripId);
    const place = trip && trip.places.find(p => p.id === job.id);
    if (place && place.category !== "transit" && !place.googlePlaceId) {
      try {
        const center = medianCenter(trip.places) || { lat: place.lat, lng: place.lng };
        const query = place.searchName || place.name;
        const list = await window.RoutyAI.searchPlaces(query, center, { bounded: true, limit: 1 });
        const hit = list[0];
        if (hit) {
          const d = distanceKm({ lat: place.lat, lng: place.lng }, hit);
          if (place.coordMissing || (d > 0.7 && d < 40)) {
            place.lat = hit.lat;
            place.lng = hit.lng;
            place.coordMissing = false;
            place.coordFixed = true;
            verifyState.fixed++;
            if (state.activeTrip && state.activeTrip.id === trip.id) {
              updateMapMarkers();
              persistActiveTrip();
            } else {
              saveToLocalStorage();
            }
          }
        }
        place.coordChecked = true;
        if (state.activeTrip && state.activeTrip.id === trip.id) persistActiveTrip(); else saveToLocalStorage();
      } catch (e) { /* 검색 실패는 무시 (다음에 다시 시도) */ }
      await sleep(1100); // Nominatim 이용 정책: 초당 1회
    }
    verifyState.done++;
    renderVerifyStatus();
  }
  verifyState.running = false;
  renderVerifyStatus();
  if (state.activeTrip && state.activeTrip.id === verifyState.tripId) renderTimeline();
}

function renderVerifyStatus() {
  const el = document.getElementById("verify-status");
  if (!el) return;
  if (!state.activeTrip || verifyState.tripId !== state.activeTrip.id || !verifyState.total) {
    el.textContent = "";
    return;
  }
  el.textContent = verifyState.running
    ? `지도 위치 확인 중 ${verifyState.done}/${verifyState.total}`
    : verifyState.fixed ? `위치 확인 완료 · ${verifyState.fixed}곳 보정` : "";
}

// 지도 ↔ 목록 연동
let mapMarkersById = {};

function focusPlaceOnMap(placeId) {
  if (activeMapEngine === "naver") {
    const it = naverMarkers[placeId];
    if (it && naverMap) { naverMap.panTo(it.pos); showNaverInfo(placeId); }
    return;
  }
  if (activeMapEngine === "kakao") {
    const it = kakaoItems[placeId];
    if (it && kakaoMap) { kakaoMap.panTo(it.pos); showKakaoInfo(placeId); }
    return;
  }
  if (activeMapEngine === "ofm") {
    const it = ofmMarkers[placeId];
    if (it && ofmMap) {
      ofmMap.easeTo({ center: [it.place.lng, it.place.lat], duration: 400 });
      Object.values(ofmMarkers).forEach(m => { if (m !== it && m.marker.getPopup().isOpen()) m.marker.togglePopup(); });
      if (!it.marker.getPopup().isOpen()) it.marker.togglePopup();
    }
    return;
  }
  const m = mapMarkersById[placeId];
  if (!m || !leafletMap) return;
  leafletMap.panTo(m.getLatLng(), { animate: true });
  m.openPopup();
}

function focusPlaceCard(placeId) {
  const card = document.querySelector(`.timeline-item[data-place-id="${CSS.escape(placeId)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("is-focused");
  setTimeout(() => card.classList.remove("is-focused"), 1600);
}

function setupTitleRename() {
  const titleEl = document.getElementById("itinerary-title");
  titleEl.title = "눌러서 제목 바꾸기";
  titleEl.style.cursor = "pointer";
  titleEl.addEventListener("click", async () => {
    if (!state.activeTrip) return;
    const next = await uiPrompt("일정 제목", state.activeTrip.title, { okText: "변경" });
    if (next && next.trim()) {
      state.activeTrip.title = next.trim();
      titleEl.textContent = state.activeTrip.title;
      persistActiveTrip();
    }
  });
}

function renderItineraryAll() {
  document.getElementById("itinerary-title").textContent = state.activeTrip.title;
  renderTripMeta();
  renderDayTabs();
  renderTimeline();
  updateMapMarkers();
  updateSaveButton();
  if (window.renderCandidateTrigger) window.renderCandidateTrigger();
}

function showItineraryView() {
  if (!state.activeTrip) return;
  ensureTripShape(state.activeTrip);
  ensurePlacePrices(state.activeTrip);
  // 예전에 만든 일정: 식사를 정해진 시간대(조식 07~09·중식 12~14·석식 18~20)로 한 번 맞춤
  if (state.activeTrip.mealsChecked && !state.activeTrip.mealWin1) {
    const before = cloneTrip(state.activeTrip);
    const moved = alignMealWindows(state.activeTrip);
    state.activeTrip.mealWin1 = true;
    persistActiveTrip();
    if (moved) {
      setTimeout(() => showToast("식사 시간을 조식 7~9시, 중식 12~14시, 석식 18~20시 안으로 맞췄어요.", 6000, {
        label: "되돌리기",
        onClick: () => { before.mealWin1 = true; state.activeTrip = before; renderItineraryAll(); persistActiveTrip(); }
      }), 400);
    }
  }
  // 예전에 만든 일정: 한 번만 빠진 끼니를 채우고 알려 줌 (되돌리기 가능)
  if (!state.activeTrip.mealsChecked) {
    const before = cloneTrip(state.activeTrip);
    const meals = ensureMeals(state.activeTrip);
    if (meals.length) {
      persistActiveTrip();
      setTimeout(() => showToast(`빠진 끼니 ${meals.length}개(${mealSummary(meals)})를 넣었어요.`, 6000, {
        label: "되돌리기",
        onClick: () => { before.mealsChecked = true; state.activeTrip = before; renderItineraryAll(); persistActiveTrip(); }
      }), 400);
    }
  }
  if (!isActiveTripSaved()) saveDraft();

  state.editMode = false;
  const toggleEditBtn = document.getElementById("btn-toggle-edit-mode");
  if (toggleEditBtn) {
    toggleEditBtn.classList.remove("active");
    toggleEditBtn.textContent = "편집";
  }
  // 이전 일정의 되돌리기 상태 초기화
  refineUndoTrip = null;
  expandedAlts.clear();
  recentlyChanged = new Set();
  setRefineMode("normal");
  if (state.activeTripDay > state.activeTrip.days) state.activeTripDay = 1;

  switchTab("itinerary");
  document.getElementById("itinerary-title").textContent = state.activeTrip.title;

  const btnToggleMap = document.getElementById("btn-toggle-map");
  const mapWrapper = document.getElementById("map-wrapper");
  if (btnToggleMap && mapWrapper) {
    mapWrapper.classList.remove("show-senior-map");
    btnToggleMap.classList.remove("active");
    btnToggleMap.textContent = "지도 보기";
  }

  setTimeout(() => {
    renderItineraryAll();
    // AI 일정 중 아직 위치 확인 안 된 장소가 있으면 이어서 확인
    const t = state.activeTrip;
    // 추천 템플릿·공유·예전 일정도 식당이 아직 Google 1위로 안 바뀌었으면 이어서 처리
    if (t && t.places.some(p => ["restaurant", "cafe"].includes(p.category) && !p.googlePlaceId && !p.autoTopTried && !String(p.id).startsWith("custom-"))) autoPickTop(t);
    if (t && t.source === "ai") {
      const queued = new Set(verifyQueue.filter(j => j.tripId === t.id).map(j => j.id));
      const pending = t.places.filter(p => !p.coordChecked && p.category !== "transit" && !queued.has(p.id)).map(p => p.id);
      if (pending.length) verifyCoordinates(t.id, pending);
    }
  }, 100);
}

// --- Day Tabs Drag Scroll & Fade Masks ---
function setupDayTabsDragScroll() {
  const container = document.getElementById("day-tabs-container");
  if (!container) return;

  let isDown = false;
  let startX;
  let startY;
  let scrollLeft;
  let isDragging = false;

  // Update fade mask based on scroll position
  function updateFadeMasks() {
    const sLeft = container.scrollLeft;
    const maxScroll = container.scrollWidth - container.clientWidth;

    container.classList.remove("fade-left", "fade-right", "fade-both");

    if (maxScroll <= 5) {
      return; // 스크롤할 잔여 공간이 없으면 마스크 제외
    }

    if (sLeft > 8 && sLeft < maxScroll - 8) {
      container.classList.add("fade-both");
    } else if (sLeft > 8) {
      container.classList.add("fade-left");
    } else if (sLeft < maxScroll - 8) {
      container.classList.add("fade-right");
    }
  }

  container.addEventListener("mousedown", (e) => {
    isDown = true;
    startX = e.pageX - container.offsetLeft;
    startY = e.pageY - container.offsetTop;
    scrollLeft = container.scrollLeft;
  });

  container.addEventListener("mouseleave", () => {
    isDown = false;
  });

  container.addEventListener("mouseup", () => {
    isDown = false;
    // 클릭 이벤트 차단을 유지하기 위해 약간의 딜레이 후 플래그 리셋
    setTimeout(() => {
      isDragging = false;
    }, 20);
  });

  container.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    const x = e.pageX - container.offsetLeft;
    const y = e.pageY - container.offsetTop;
    
    // 5px 이상 드래그 이동 시 드래그 동작으로 판정
    if (Math.abs(x - startX) > 5 || Math.abs(y - startY) > 5) {
      isDragging = true;
    }

    if (isDragging) {
      e.preventDefault();
      const walk = (x - startX) * 1.5;
      container.scrollLeft = scrollLeft - walk;
      updateFadeMasks();
    }
  });

  // Track standard wheel or swipe scrolling
  container.addEventListener("scroll", () => {
    updateFadeMasks();
  });

  // Handle click capture to prevent selecting tabs while dragging
  container.addEventListener("click", (e) => {
    if (isDragging) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true); // Capturing phase!

  // Expose masking functions for external renderer usage
  container.updateFadeMasks = updateFadeMasks;
}

// --- Day Tabs Render ---
function renderDayTabs() {
  const container = document.getElementById("day-tabs-container");
  if (!container) return;
  
  container.innerHTML = "";

  for (let d = 1; d <= state.activeTrip.days; d++) {
    const tab = document.createElement("div");
    const todayDay = getTodayDay(state.activeTrip);
    tab.className = `day-tab ${d === state.activeTripDay ? 'active' : ''} ${d === todayDay ? 'is-today' : ''}`;
    const tabDate = getTripDate(state.activeTrip, d);
    tab.innerHTML = tabDate ? `${d === todayDay ? "오늘" : `Day ${d}`}<small class="day-tab-date">${formatShortDate(tabDate)}</small>` : `Day ${d}`;
    tab.addEventListener("click", () => {
      state.activeTripDay = d;
      
      // Update Active state
      document.querySelectorAll(".day-tabs-slider .day-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      
      // Smoothly scroll active tab into view (centered horizontally) without moving other parent containers
      const targetScrollLeft = tab.offsetLeft - (container.clientWidth / 2) + (tab.clientWidth / 2);
      container.scrollTo({
        left: targetScrollLeft,
        behavior: 'smooth'
      });
      
      closeAddPlaceDrawer();
      renderTimeline();
      updateMapMarkers();
      const scroller = document.getElementById("itinerary-scroll");
      const sticky = document.querySelector(".day-tabs-sticky");
      if (scroller && sticky && scroller.scrollTop > sticky.offsetTop) scroller.scrollTop = sticky.offsetTop;
      
      // Update masks
      if (container.updateFadeMasks) {
        setTimeout(container.updateFadeMasks, 100);
      }
    });
    
    container.appendChild(tab);

    // Initial setup: focus on active day without animation delay
    if (d === state.activeTripDay) {
      setTimeout(() => {
        const targetScrollLeft = tab.offsetLeft - (container.clientWidth / 2) + (tab.clientWidth / 2);
        container.scrollTo({
          left: targetScrollLeft,
          behavior: 'auto'
        });
        if (container.updateFadeMasks) container.updateFadeMasks();
      }, 50);
    }
  }

  const addTab = document.createElement("div");
  addTab.className = "day-tab day-tab-add";
  addTab.setAttribute("aria-label", "하루 추가");
  addTab.innerHTML = `${window.icon("plus", 16)}<small class="day-tab-date">하루 추가</small>`;
  addTab.addEventListener("click", () => {
    withUndo(`Day ${state.activeTrip.days + 1}을(를) 추가했습니다.`, () => {
      state.activeTrip.days += 1;
      state.activeTripDay = state.activeTrip.days;
    });
  });
  container.appendChild(addTab);

  // Update dynamic fade masks after elements are populated
  setTimeout(() => {
    if (container.updateFadeMasks) container.updateFadeMasks();
  }, 100);
}

// --- Timeline Render (Schedules Lists) ---
function getTransitTips(placeName) {
  const name = placeName || '';
  if (name.includes("택시")) return "호출 앱(우버, 카카오T 등) 사용 권장";
  if (name.includes("지하철") || name.includes("메트로")) return "현지 교통카드 태그 또는 1회권 발권기 구매";
  if (name.includes("버스")) return "승차 시 교통카드를 태그하거나 잔돈을 준비하세요";
  if (name.includes("렌터카") || name.includes("차량")) return "국제운전면허증 지참 | 주차 사전 확인 권장";
  if (name.includes("도보")) return "가까운 도보 코스 | 편안한 신발 추천";
  return "";
}

// 비용: priceUnit "person"(1인당) / "group"(객실·택시 등 일행 전체)
function getPeople(trip) {
  return Math.max(1, parseInt(trip && trip.people, 10) || 1);
}

// 이동 요금: 택시·자가용·렌터카는 일행 전체, 그 외는 1인 요금
const GROUP_MOVE_MODES = ["car", "taxi"];

function placeGroupCost(p, people) {
  const v = p.price || 0;
  return p.priceUnit === "group" ? v : v * people;
}

function moveGroupCost(p, people) {
  if (!p.move || !p.move.cost) return 0;
  return GROUP_MOVE_MODES.includes(p.move.mode) ? p.move.cost : p.move.cost * people;
}

const COST_CATEGORY = { restaurant: "food", cafe: "food", hotel: "lodging", transit: "transport" };

// 항목별 예상 비용 (일행 전체 금액)
function getCategoryCosts(trip, day) {
  const people = getPeople(trip);
  const out = { food: 0, transport: 0, lodging: 0, other: 0 };
  let movesWithoutCost = 0, moves = 0;
  trip.places.filter(p => !day || p.day === day).forEach(p => {
    out[COST_CATEGORY[p.category] || "other"] += placeGroupCost(p, people);
    if (p.move) {
      moves++;
      if (p.move.cost === undefined && !["walk", "bike"].includes(p.move.mode)) movesWithoutCost++;
      out.transport += moveGroupCost(p, people);
    }
  });
  Object.keys(out).forEach(k => { out[k] = Math.round(out[k]); });
  out.total = out.food + out.transport + out.lodging + out.other;
  out.people = people;
  // 이동 정보가 없거나 요금이 빠진 이동이 많으면 교통비가 과소 추정됨
  out.transportIncomplete = moves === 0 || movesWithoutCost > moves / 2;
  return out;
}

function getTripCost(trip, day) {
  const c = getCategoryCosts(trip, day);
  return { total: c.total, perPerson: Math.round(c.total / c.people), people: c.people };
}

function getTripTotal(trip) {
  return getTripCost(trip).perPerson;
}

function formatWon(n) {
  return `₩${Math.round(n || 0).toLocaleString()}`;
}

function costLabel(trip, day) {
  const c = getTripCost(trip, day);
  return c.people > 1 ? `${c.people}명 총 ${formatWon(c.total)} · 1인 ${formatWon(c.perPerson)}` : `약 ${formatWon(c.total)}`;
}

function placePriceLabel(place, trip) {
  if (!place.price) return "무료";
  if (place.priceUnit === "group") return `${place.category === "hotel" ? "1박" : "일행"} ${formatWon(place.price)}`;
  return `${getPeople(trip) > 1 ? "1인 " : "약 "}${formatWon(place.price)}`;
}

// --- 시간 문자열 다루기 ---
function minutesToHHMM(min) {
  min = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function shiftTimeString(timeStr, delta) {
  const r = parseTimeRange(timeStr);
  if (!r) return timeStr;
  const hasEnd = ((timeStr || "").match(/\d{1,2}:\d{2}/g) || []).length > 1;
  return hasEnd ? `${minutesToHHMM(r[0] + delta)} - ${minutesToHHMM(r[1] + delta)}` : minutesToHHMM(r[0] + delta);
}

// 같은 날 이 장소부터 이후 일정 시간을 delta분 이동
function shiftDayFrom(placeId, delta) {
  const place = state.activeTrip.places.find(p => p.id === placeId);
  if (!place) return;
  const dayPlaces = state.activeTrip.places.filter(p => p.day === place.day);
  const startIdx = dayPlaces.indexOf(place);
  dayPlaces.slice(startIdx).forEach(p => {
    p.time = shiftTimeString(p.time, delta);
  });
}

function renderTimeline() {
  const container = document.getElementById("timeline-places-container");
  container.classList.toggle("tl2-wrap", !state.seniorMode);
  if (!container || !state.activeTrip) return;

  container.innerHTML = "";
  if (state.seniorMode) state.editMode = false;
  container.classList.toggle("edit-mode-active", !!state.editMode);
  updateRefineScopeLabel();
  renderTripMeta();
  renderNextUp();

  const dayPlaces = state.activeTrip.places.filter(p => p.day === state.activeTripDay);
  const next = getNextPlace(state.activeTrip, state.activeTripDay);

  if (dayPlaces.length === 0) {
    container.innerHTML = `<p class="empty-timeline-msg">이 날은 아직 일정이 없습니다. 아래에서 장소를 추가해 보세요.</p>`;
    return;
  }

  const dayHeader = document.createElement("div");
  dayHeader.className = "day-summary-line";
  const date = getTripDate(state.activeTrip, state.activeTripDay);
  dayHeader.textContent = `${date ? formatShortDate(date) + " · " : ""}${dayPlaces.length}곳 · ${costLabel(state.activeTrip, state.activeTripDay)}`;
  const wakeNow = (state.activeTrip.wake || {})[state.activeTripDay];
  const wakeBtn = document.createElement("button");
  wakeBtn.className = "wake-chip";
  wakeBtn.setAttribute("data-action", "wake");
  wakeBtn.innerHTML = `⏰ ${wakeNow ? `${esc(wakeNow)} 기상` : "기상 시간"}`;
  dayHeader.appendChild(wakeBtn);
  container.appendChild(dayHeader);
  const railDay = state.activeTripDay;
  const railHtml = railBlockHtml(state.activeTrip, railDay) || driveBlockHtml(state.activeTrip, railDay);
  if (railHtml && railDay === 1) container.insertAdjacentHTML("beforeend", railHtml);

  dayPlaces.forEach((place, index) => {
    const card = document.createElement("div");
    card.className = "timeline-item";
    if (next && next.id === place.id) card.classList.add("is-next");
    const changed = recentlyChanged.has(place.id);
    if (changed) card.classList.add("is-changed");
    card.setAttribute("data-cat", place.category);
    card.setAttribute("data-place-id", place.id);

    const catKorean = CATEGORY_LABELS[place.category] || "관광";
    const id = esc(place.id);
    const isTransit = place.category === "transit";
    const tips = isTransit ? getTransitTips(place.name) : "";

    const priceHtml = `<span class="place-price-tag ${place.price ? "" : "free"}">${placePriceLabel(place, state.activeTrip)}</span>`;

    const searchLabel = place.category === "hotel" ? "숙소 검색" : place.category === "restaurant" || place.category === "cafe" ? "리뷰" : "정보";
    const coordWarn = place.coordMissing ? `<span class="coord-warn" title="정확한 위치가 지정되지 않았어요. 편집에서 위치를 찾아주세요.">위치 미지정</span>` : "";

    if (state.seniorMode) {
      const controlsHtml = `
        <button class="btn-ctrl btn-senior-link" data-action="map" data-id="${id}">지도에서 보기</button>
        ${isTransit ? "" : `<button class="btn-ctrl btn-senior-link" data-action="search" data-id="${id}">${searchLabel} 검색</button>`}
        ${(place.alternatives || []).map((a, i) => `<button class="btn-ctrl btn-senior-link" data-action="pick" data-alt="${i}" data-id="${id}">다른 식당: ${esc(a.name)}(으)로 바꾸기</button>`).join("")}
        <button class="btn-ctrl btn-senior-edit" data-action="edit" data-id="${id}">편집하기</button>
        <button class="btn-ctrl btn-delete" data-action="delete" data-id="${id}">장소 삭제하기</button>
      `;
      card.innerHTML = `
        <div class="timeline-dot"></div>
        <div class="timeline-header-row">
          <span class="time-badge">${esc(place.time)}</span>
          <span class="place-cat-badge cat-${esc(place.category)}">${catKorean}</span>
          ${priceHtml}
        </div>
        <div class="place-name">${index + 1}. ${esc(place.name)}</div>
        <div class="click-guide">눌러서 자세히 보기</div>
      `;
      const tipsHtml = tips ? `<div class="transit-guide-box"><div class="guide-tips">${tips}</div></div>` : "";
      card.onclick = () => openSeniorDetailModal(place, index, catKorean, tipsHtml, controlsHtml);
    } else {
      card.onclick = (e) => {
        if (e.target.closest("button, a, input")) return;
        focusPlaceOnMap(place.id);
      };
      card.classList.add("tl2");
      const tr = parseTimeRange(place.time);
      const tStart = tr ? minutesToHHMM(tr[0]) : esc((place.time || "").split("-")[0].trim());
      const tEnd = tr && tr[1] !== tr[0] ? minutesToHHMM(tr[1]) : "";
      const isAirportFlight = isAirportPlace(place) && needsFlight(state.activeTrip) && !(place.move && place.move.mode === "flight") && synthFlightTrip(state.activeTrip, place);
      // 카드마다 꼭 필요한 버튼 하나 (숙소: 최저가, 식당·카페: TOP 5 또는 후보, 공항: 항공권)
      let contextChip = "";
      if (place.category === "hotel") contextChip = `<button class="chip-btn chip-stay ${expandedStays.has(place.id) ? "on" : ""}" data-action="stays" data-id="${id}">${window.icon("wallet", 16)}${expandedStays.has(place.id) ? "접기" : "최저가 숙소"}</button>`;
      else if (isAirportFlight) contextChip = `<button class="chip-btn chip-flight ${expandedFlights.has(place.id) ? "on" : ""}" data-action="flights" data-id="${id}">${window.icon("flight", 16)}${expandedFlights.has(place.id) ? "접기" : "항공권 찾기"}</button>`;
      else contextChip = topChipHtml(place) || altChipHtml(place);
      const altInMore = contextChip && topChipHtml(place) ? altChipHtml(place) : "";
      const moreOpen = expandedMore.has(place.id);
      card.innerHTML = `
        <div class="tl-time"><b>${tStart}</b>${tEnd ? `<span>${tEnd}</span>` : ""}</div>
        <div class="tl-rail"><span class="tl-icon">${CATEGORY_EMOJI[place.category] || "📍"}</span></div>
        <div class="tl-body">
          <div class="tl-head">
            <span class="tl-cat">${catKorean}</span>
            ${changed ? `<em class="changed-badge">AI 변경</em>` : ""}${place.coordFixed ? `<em class="fixed-badge" title="지도 데이터로 위치를 보정했어요">위치 보정</em>` : ""}${place.autoTop ? `<em class="top-badge">★ Google ${place.autoTop === "count" ? "리뷰수" : "별점"} 1위</em>` : ""}
            ${priceHtml}
          </div>
          ${placeNameHtml(place)}
          ${placeInfoHtml(place)}
          ${place.description && !/Google 지도에서 고른 곳$/.test(place.description) ? `<p class="timeline-desc">${esc(place.description)}</p>` : ""}
          ${tips ? `<p class="timeline-desc transit-tip">${tips}</p>` : ""}
          ${coordWarn ? `<div>${coordWarn}</div>` : ""}
          <div class="timeline-actions">
            ${place.intercity === "back" ? "" : `<button class="chip-btn chip-navi" data-action="navi" data-id="${id}">${window.icon("navigate", 16)}길안내</button>`}
            <button class="chip-btn" data-action="map" data-id="${id}">${window.icon("map", 16)}지도</button>
            ${contextChip}
            <button class="chip-btn chip-icon chip-more ${moreOpen ? "on" : ""}" data-action="more" data-id="${id}" aria-label="더보기" aria-expanded="${moreOpen}">${window.icon("more", 18)}</button>
            <span class="edit-only-actions">
              <button class="chip-btn chip-icon" data-action="up" data-id="${id}" ${index === 0 ? "disabled" : ""} aria-label="위로">${window.icon("up", 18)}</button>
              <button class="chip-btn chip-icon" data-action="down" data-id="${id}" ${index === dayPlaces.length - 1 ? "disabled" : ""} aria-label="아래로">${window.icon("down", 18)}</button>
              <button class="chip-btn chip-icon chip-danger" data-action="delete" data-id="${id}" aria-label="삭제">${window.icon("trash", 18)}</button>
            </span>
          </div>
          ${moreOpen ? `<div class="timeline-actions more-row">
            ${isTransit ? "" : `<button class="chip-btn" data-action="search" data-id="${id}">${window.icon("search", 16)}${searchLabel}</button>`}
            <button class="chip-btn" data-action="edit" data-id="${id}">${window.icon("pencil", 16)}편집</button>
            ${altInMore}
            ${place.intercity ? "" : `<button class="chip-btn chip-remove" data-action="remove" data-id="${id}">${window.icon("trash", 16)}빼기</button>`}
          </div>` : ""}
          ${expandedAlts.has(place.id) ? altListHtml(place) : ""}
          ${topPanel.placeId === place.id ? topPanelHtml(place) : ""}
          ${expandedStays.has(place.id) ? stayPanelHtml(place) : ""}
          ${isAirportFlight && expandedFlights.has(place.id) ? flightPanelHtml(synthFlightTrip(state.activeTrip, place), esc(place.id)) : ""}
        </div>
      `;
    }

    if (index > 0 || (place.move && place.move.mode === "flight")) {
      const conn = document.createElement("div");
      conn.innerHTML = moveConnectorHtml(place.move, dayPlaces[index - 1], place);
      while (conn.firstElementChild) container.appendChild(conn.firstElementChild);
    }
    container.appendChild(card);
  });
  if (railHtml && railDay !== 1) container.insertAdjacentHTML("beforeend", railHtml);
}

// --- Leaflet Map Engine ---
function initLeafletMap() {
  const mapContainer = document.getElementById("map");
  if (!mapContainer || typeof L === "undefined") return;

  // If map already initialized, just return
  if (leafletMap !== null) {
    // Force leaflet map resize calculation
    leafletMap.invalidateSize();
    return;
  }

  // Setup leaflet map
  leafletMap = L.map("map", {
    zoomControl: false,
    attributionControl: false
  }).setView([37.5665, 126.9780], 13); // Default view Seoul

  // Add customized Map tiles based on current theme
  const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
  const tileUrl = currentTheme === "dark"
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

  mapTileLayer = L.tileLayer(tileUrl, {
    maxZoom: 19
  }).addTo(leafletMap);

  // Setup layer groups
  mapMarkersGroup = L.layerGroup().addTo(leafletMap);
}

// --- 지도 엔진 ---
// 국내 일정: 네이버(키 있음) → 카카오(키 있음) → OpenFreeMap → 기본(Leaflet)
// 해외 일정: OpenFreeMap → 기본(Leaflet)
// 불러오기에 실패한 엔진은 이번 실행 동안 건너뛰고 다음 엔진으로 자동 대체
const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css";
const OFM_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const ENGINE_LABEL = { naver: "네이버 지도", kakao: "카카오맵", ofm: "OpenFreeMap", leaflet: "기본 지도" };

let activeMapEngine = null;
const failedEngines = new Set();
const scriptPromises = {};
let mapRenderSeq = 0;

function isDomesticTrip(trip) {
  const pts = (trip.places || []).filter(p => !p.coordMissing);
  if (!pts.length) return false;
  const inKorea = pts.filter(p => isInKorea(p.lat, p.lng)).length;
  return inKorea / pts.length >= 0.6;
}

function engineCandidates() {
  const s = window.RoutyAI.getSettings();
  const list = [];
  if (state.activeTrip && isDomesticTrip(state.activeTrip)) {
    if (s.naverKey) list.push("naver");
    if (s.kakaoKey) list.push("kakao");
  }
  list.push("ofm", "leaflet");
  return list.filter(e => !failedEngines.has(e));
}

function loadScriptOnce(id, url, isReady, timeoutMs = 12000) {
  if (isReady()) return Promise.resolve();
  if (scriptPromises[id]) return scriptPromises[id];
  scriptPromises[id] = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    s.onload = () => { clearTimeout(timer); isReady() ? resolve() : reject(new Error("not ready")); };
    s.onerror = () => { clearTimeout(timer); reject(new Error("load")); };
    document.head.appendChild(s);
  }).catch(err => {
    delete scriptPromises[id];
    throw err;
  });
  return scriptPromises[id];
}

function markEngineFailed(engine, notify) {
  if (failedEngines.has(engine)) return;
  failedEngines.add(engine);
  if (notify) {
    const fb = engineCandidates()[0];
    const OBJ = { naver: "네이버 지도를", kakao: "카카오맵을", ofm: "OpenFreeMap을", leaflet: "기본 지도를" };
    const TO = { naver: "네이버 지도로", kakao: "카카오맵으로", ofm: "OpenFreeMap으로", leaflet: "기본 지도로" };
    showToast(`${OBJ[engine]} 불러오지 못해 ${TO[fb]} 표시합니다.${engine === "naver" || engine === "kakao" ? " 설정의 키와 등록 주소를 확인해 주세요." : ""}`, 5000);
  }
  if (state.activeTab === "itinerary") updateMapMarkers();
}

function showMapEngine(engine) {
  activeMapEngine = engine;
  const ids = { naver: "naver-map", kakao: "kakao-map", ofm: "ofm-map", leaflet: "map" };
  Object.entries(ids).forEach(([e, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = e === engine ? "" : "none";
  });
  const credit = document.getElementById("map-engine-credit");
  if (credit) credit.textContent = engine === "kakao" ? "카카오맵" : "";
}

function refreshMapSize() {
  if (activeMapEngine === "naver" && naverMap) {
    const el = document.getElementById("naver-map");
    naverMap.setSize(new window.naver.maps.Size(el.clientWidth, el.clientHeight));
  } else if (activeMapEngine === "kakao" && kakaoMap) kakaoMap.relayout();
  else if (activeMapEngine === "ofm" && ofmMap) ofmMap.resize();
  else if (leafletMap) leafletMap.invalidateSize();
}

function dayPlacesForMap() {
  const dayPlaces = state.activeTrip.places.filter(p => p.day === state.activeTripDay);
  const ind = document.getElementById("map-day-indicator");
  if (ind) ind.textContent = `Day ${state.activeTripDay} · ${dayPlaces.length}곳`;
  return dayPlaces;
}

function markerElement(place, index) {
  let cls = "map-number-marker";
  if (place.category === "hotel") cls += " hotel";
  else if (place.category === "transit") cls += " transit";
  const el = document.createElement("div");
  el.className = `${cls} js-map-marker`;
  el.textContent = String(index + 1);
  return el;
}

function popupHtml(place, index) {
  return `<div class="map-info"><strong>${index + 1}. ${esc(place.name)}</strong><span>${esc(place.time)}</span></div>`;
}

function updateMapMarkers() {
  if (!state.activeTrip) return;
  const seq = ++mapRenderSeq;
  const engine = engineCandidates()[0];
  const renderers = { naver: renderNaver, kakao: renderKakao, ofm: renderOfm, leaflet: renderLeaflet };
  Promise.resolve()
    .then(() => renderers[engine](seq))
    .catch(err => {
      console.warn(`[map] ${engine} 실패`, err);
      if (engine === "leaflet") return;
      markEngineFailed(engine, true);
    });
}

// ---------- 네이버 ----------
let naverMap = null;
let naverMarkers = {};
let naverLine = null;
let naverInfo = null;

async function renderNaver(seq) {
  const key = window.RoutyAI.getSettings().naverKey;
  window.navermap_authFailure = () => markEngineFailed("naver", true);
  await loadScriptOnce("naver", `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}`,
    () => !!(window.naver && window.naver.maps && window.naver.maps.Map));
  if (seq !== mapRenderSeq) return;
  const nm = window.naver.maps;
  showMapEngine("naver");
  const el = document.getElementById("naver-map");
  if (!naverMap) {
    naverMap = new nm.Map(el, {
      center: new nm.LatLng(37.5665, 126.978),
      zoom: 12,
      zoomControl: false,
      mapDataControl: false,
      scaleControl: false
    });
  } else {
    refreshMapSize();
  }
  Object.values(naverMarkers).forEach(m => m.marker.setMap(null));
  naverMarkers = {};
  if (naverLine) { naverLine.setMap(null); naverLine = null; }
  if (naverInfo) { naverInfo.close(); naverInfo = null; }

  const dayPlaces = dayPlacesForMap();
  if (!dayPlaces.length) return;
  const path = [];
  dayPlaces.forEach((place, index) => {
    const pos = new nm.LatLng(place.lat, place.lng);
    path.push(pos);
    const marker = new nm.Marker({
      position: pos,
      map: naverMap,
      icon: { content: markerElement(place, index).outerHTML, anchor: new nm.Point(13, 13) }
    });
    nm.Event.addListener(marker, "click", () => {
      showNaverInfo(place.id);
      focusPlaceCard(place.id);
    });
    naverMarkers[place.id] = { marker, place, index, pos };
  });
  if (path.length > 1) {
    naverLine = new nm.Polyline({ map: naverMap, path, strokeColor: "#00A3C4", strokeWeight: 3, strokeOpacity: 0.8, strokeStyle: "shortdash" });
    const bounds = new nm.LatLngBounds(path[0], path[0]);
    path.forEach(p => bounds.extend(p));
    naverMap.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
  } else {
    naverMap.setCenter(path[0]);
    naverMap.setZoom(15);
  }
}

function showNaverInfo(placeId) {
  const item = naverMarkers[placeId];
  if (!item) return;
  const nm = window.naver.maps;
  if (naverInfo) naverInfo.close();
  naverInfo = new nm.InfoWindow({
    content: popupHtml(item.place, item.index),
    borderWidth: 0,
    backgroundColor: "transparent",
    disableAnchor: true,
    pixelOffset: new nm.Point(0, -16)
  });
  naverInfo.open(naverMap, item.marker);
}

// ---------- 카카오 ----------
let kakaoMap = null;
let kakaoItems = {};
let kakaoRouteLine = null;
let kakaoInfoOverlay = null;

async function renderKakao(seq) {
  const key = window.RoutyAI.getSettings().kakaoKey;
  await loadScriptOnce("kakao", `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`,
    () => !!(window.kakao && window.kakao.maps && window.kakao.maps.load));
  await new Promise(r => window.kakao.maps.load(r));
  if (seq !== mapRenderSeq) return;
  const km = window.kakao.maps;
  showMapEngine("kakao");
  const el = document.getElementById("kakao-map");
  if (!kakaoMap) kakaoMap = new km.Map(el, { center: new km.LatLng(37.5665, 126.978), level: 6 });
  else kakaoMap.relayout();
  Object.values(kakaoItems).forEach(i => i.overlay.setMap(null));
  kakaoItems = {};
  if (kakaoRouteLine) { kakaoRouteLine.setMap(null); kakaoRouteLine = null; }
  if (kakaoInfoOverlay) { kakaoInfoOverlay.setMap(null); kakaoInfoOverlay = null; }

  const dayPlaces = dayPlacesForMap();
  if (!dayPlaces.length) return;
  const bounds = new km.LatLngBounds();
  const path = [];
  dayPlaces.forEach((place, index) => {
    const pos = new km.LatLng(place.lat, place.lng);
    path.push(pos);
    bounds.extend(pos);
    const el2 = markerElement(place, index);
    el2.addEventListener("click", () => {
      showKakaoInfo(place.id);
      focusPlaceCard(place.id);
    });
    const overlay = new km.CustomOverlay({ position: pos, content: el2, xAnchor: 0.5, yAnchor: 0.5, clickable: true, zIndex: 3 });
    overlay.setMap(kakaoMap);
    kakaoItems[place.id] = { overlay, place, index, pos };
  });
  if (path.length > 1) {
    kakaoRouteLine = new km.Polyline({ path, strokeWeight: 3, strokeColor: "#00A3C4", strokeOpacity: 0.8, strokeStyle: "shortdash" });
    kakaoRouteLine.setMap(kakaoMap);
    kakaoMap.setBounds(bounds, 40, 40, 40, 40);
  } else {
    kakaoMap.setCenter(path[0]);
    kakaoMap.setLevel(4);
  }
}

function showKakaoInfo(placeId) {
  const item = kakaoItems[placeId];
  if (!item) return;
  const km = window.kakao.maps;
  if (kakaoInfoOverlay) kakaoInfoOverlay.setMap(null);
  const box = document.createElement("div");
  box.innerHTML = popupHtml(item.place, item.index);
  kakaoInfoOverlay = new km.CustomOverlay({ position: item.pos, content: box.firstElementChild, xAnchor: 0.5, yAnchor: 1.7, zIndex: 5 });
  kakaoInfoOverlay.setMap(kakaoMap);
}

// ---------- OpenFreeMap (MapLibre) ----------
let ofmMap = null;
let ofmMarkers = {};
let ofmStyleReady = null;
let ofmRouteCoords = [];

function loadMaplibre() {
  if (!document.getElementById("maplibre-css")) {
    const link = document.createElement("link");
    link.id = "maplibre-css";
    link.rel = "stylesheet";
    link.href = MAPLIBRE_CSS;
    document.head.appendChild(link);
  }
  return loadScriptOnce("maplibre", MAPLIBRE_JS, () => !!window.maplibregl, 15000);
}

function currentOfmStyle() {
  return (document.documentElement.getAttribute("data-theme") === "dark") ? OFM_STYLE.dark : OFM_STYLE.light;
}

// 지명을 한국어로 (한국어 이름이 없으면 현지 이름)
function applyKoreanLabels(map) {
  const style = map.getStyle();
  (style.layers || []).forEach(layer => {
    if (layer.type !== "symbol" || !layer.layout || !layer.layout["text-field"]) return;
    const tf = JSON.stringify(layer.layout["text-field"]);
    if (!/name/.test(tf) || /housenumber|"ref"|\{ref\}/.test(tf)) return;
    try {
      map.setLayoutProperty(layer.id, "text-field", ["coalesce", ["get", "name:ko"], ["get", "name"]]);
    } catch (e) { /* 일부 레이어는 무시 */ }
  });
}

function addOfmRouteLayer(map) {
  if (map.getSource("routy-route")) return;
  map.addSource("routy-route", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: ofmRouteCoords } } });
  map.addLayer({
    id: "routy-route",
    type: "line",
    source: "routy-route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#00A3C4", "line-width": 3, "line-opacity": 0.85, "line-dasharray": [1.5, 2] }
  });
}

async function renderOfm(seq) {
  await loadMaplibre();
  if (seq !== mapRenderSeq) return;
  const ml = window.maplibregl;
  showMapEngine("ofm");
  if (!ofmMap) {
    ofmMap = new ml.Map({
      container: "ofm-map",
      style: currentOfmStyle(),
      center: [126.978, 37.5665],
      zoom: 11,
      attributionControl: { compact: true }
    });
    ofmMap.on("style.load", () => {
      applyKoreanLabels(ofmMap);
      addOfmRouteLayer(ofmMap);
    });
    ofmStyleReady = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("style timeout")), 12000);
      ofmMap.once("load", () => { clearTimeout(t); resolve(); });
    });
  } else {
    ofmMap.resize();
  }
  await ofmStyleReady;
  if (seq !== mapRenderSeq) return;

  Object.values(ofmMarkers).forEach(m => m.marker.remove());
  ofmMarkers = {};
  const dayPlaces = dayPlacesForMap();
  ofmRouteCoords = dayPlaces.map(p => [p.lng, p.lat]);
  const src = ofmMap.getSource("routy-route");
  if (src) src.setData({ type: "Feature", geometry: { type: "LineString", coordinates: dayPlaces.length > 1 ? ofmRouteCoords : [] } });
  if (!dayPlaces.length) return;

  const bounds = new ml.LngLatBounds();
  dayPlaces.forEach((place, index) => {
    const el = markerElement(place, index);
    const popup = new ml.Popup({ closeButton: false, offset: 16, className: "ofm-popup" }).setHTML(popupHtml(place, index));
    const marker = new ml.Marker({ element: el }).setLngLat([place.lng, place.lat]).setPopup(popup).addTo(ofmMap);
    el.addEventListener("click", () => focusPlaceCard(place.id));
    ofmMarkers[place.id] = { marker, place };
    bounds.extend([place.lng, place.lat]);
  });
  if (dayPlaces.length > 1) ofmMap.fitBounds(bounds, { padding: 50, maxZoom: 15, duration: 0 });
  else ofmMap.jumpTo({ center: [dayPlaces[0].lng, dayPlaces[0].lat], zoom: 15 });
}

function setOfmTheme() {
  if (ofmMap) ofmMap.setStyle(currentOfmStyle());
}

// ---------- 기본 지도 (Leaflet) ----------
async function renderLeaflet() {
  showMapEngine("leaflet");
  if (!leafletMap) initLeafletMap();
  else leafletMap.invalidateSize();
  updateLeafletMarkers();
}

function updateLeafletMarkers() {
  if (!leafletMap || !mapMarkersGroup || !state.activeTrip) return;

  // Clear previous layers
  mapMarkersGroup.clearLayers();
  mapMarkersById = {};
  if (mapRouteLine) {
    leafletMap.removeLayer(mapRouteLine);
    mapRouteLine = null;
  }

  const dayPlaces = state.activeTrip.places.filter(p => p.day === state.activeTripDay);
  
  // Set day header
  document.getElementById("map-day-indicator").textContent = `Day ${state.activeTripDay} · ${dayPlaces.length}곳`;

  if (dayPlaces.length === 0) return;

  const coordinates = [];

  // Draw markers
  dayPlaces.forEach((place, index) => {
    coordinates.push([place.lat, place.lng]);

    // Create custom numbered HTML marker icon
    let markerClass = "map-number-marker";
    if (place.category === "hotel") markerClass += " hotel";
    else if (place.category === "transit") markerClass += " transit";

    const customIcon = L.divIcon({
      html: `<div class="${markerClass}">${index + 1}</div>`,
      className: "custom-leaflet-icon",
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    // Create leaflet marker
    const marker = L.marker([place.lat, place.lng], { icon: customIcon });
    
    // Add custom styled popup
    marker.bindPopup(`
      <div class="map-popup-title">
        ${index + 1}. ${esc(place.name)}
      </div>
      <div class="map-popup-time">${esc(place.time)}</div>
    `, {
      closeButton: false,
      className: "custom-map-popup"
    });

    marker.on("click", () => focusPlaceCard(place.id));
    mapMarkersById[place.id] = marker;
    mapMarkersGroup.addLayer(marker);
  });

  // Fit boundaries containing markers
  if (coordinates.length > 0) {
    const bounds = L.latLngBounds(coordinates);
    leafletMap.fitBounds(bounds, { padding: [40, 40] });

    // Draw connecting route line
    if (coordinates.length > 1) {
      mapRouteLine = L.polyline(coordinates, {
        color: '#00A3C4',
        weight: 3,
        opacity: 0.8,
        dashArray: '5, 8',
        lineJoin: 'round'
      }).addTo(leafletMap);
    }
  }
}

function setupSeniorDetailModal() {
  const overlay = document.getElementById("senior-detail-modal-overlay");
  const closeBtn = document.getElementById("btn-senior-modal-close");
  
  if (!overlay || !closeBtn) return;

  closeBtn.addEventListener("click", () => {
    closeSeniorDetailModal();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      closeSeniorDetailModal();
    }
  });
}

window.openSeniorDetailModal = function(place, index, catKorean, transitGuideHtml, controlsHtml) {
  const overlay = document.getElementById("senior-detail-modal-overlay");
  const timeEl = document.getElementById("senior-modal-time");
  const catEl = document.getElementById("senior-modal-cat");
  const priceEl = document.getElementById("senior-modal-price");
  const titleEl = document.getElementById("senior-modal-title");
  const descEl = document.getElementById("senior-modal-description");
  const transitEl = document.getElementById("senior-modal-transit-box");
  const controlsEl = document.getElementById("senior-modal-controls");

  if (!overlay) return;

  if (timeEl) timeEl.textContent = place.time;
  if (catEl) {
    catEl.className = `senior-modal-cat cat-${place.category}`;
    catEl.innerText = catKorean;
  }
  if (priceEl) {
    const isFree = !place.price;
    priceEl.className = `senior-modal-price-badge ${isFree ? 'free' : ''}`;
    priceEl.innerText = isFree ? '비용: 무료' : `1인 약 ₩${(place.price || 0).toLocaleString()}`;
  }
  if (titleEl) titleEl.innerText = `${index + 1}. ${place.name}`;
  
  if (descEl) {
    if (place.description) {
      descEl.style.display = "block";
      descEl.innerHTML = `<p class="place-description">${esc(place.description)}</p>`;
    } else {
      descEl.style.display = "none";
    }
  }

  if (transitEl) {
    if (transitGuideHtml) {
      transitEl.style.display = "block";
      transitEl.innerHTML = transitGuideHtml;
    } else {
      transitEl.style.display = "none";
    }
  }

  if (controlsEl) {
    controlsEl.innerHTML = controlsHtml;
  }

  overlay.classList.add("active");
};

window.closeSeniorDetailModal = function() {
  const overlay = document.getElementById("senior-detail-modal-overlay");
  if (overlay) {
    overlay.classList.remove("active");
  }
};


// --- Saved Trips tab render ---
function renderSavedTrips() {
  const container = document.getElementById("saved-trips-list");
  if (!container) return;
  container.innerHTML = "";

  if (state.savedTrips.length === 0) {
    container.innerHTML = `
      <div class="empty-cute">
        ${window.mascotSvg("sleep", 120)}
        <p class="empty-title">아직 담아 둔 여행이 없어요</p>
        <p class="empty-sub">홈에서 추천 코스를 고르거나, AI 플래너로 첫 여행을 만들어 봐요.</p>
        <div class="empty-actions">
          <button type="button" class="btn btn-primary" onclick="switchTab('planner')">✨ AI로 만들기</button>
          <button type="button" class="btn btn-secondary" onclick="switchTab('explore')">🗺 추천 보기</button>
        </div>
      </div>
    `;
    return;
  }

  // 다가오는 여행 → 날짜 미정 → 지난 여행 순
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rank = (t) => {
    const end = getTripDate(t, t.days);
    if (!end) return 1;
    return end >= today ? 0 : 2;
  };
  const sorted = state.savedTrips.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return (a.startDate || "").localeCompare(b.startDate || "");
    if (ra === 2) return (b.startDate || "").localeCompare(a.startDate || "");
    return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
  });

  sorted.forEach(trip => {
    const card = document.createElement("div");
    card.className = "saved-trip-item";
    if (rank(trip) === 2) card.classList.add("is-past");

    const start = getTripDate(trip, 1);
    let when = `${trip.days}일 코스`;
    if (start) {
      const diff = Math.round((start - today) / 86400000);
      const dday = diff > 0 ? `D-${diff}` : diff === 0 ? "D-DAY" : rank(trip) === 0 ? "여행 중" : "다녀옴";
      when = `${formatShortDate(start)} 출발 · ${trip.days}일 · <strong class="dday">${dday}</strong>`;
    }

    card.innerHTML = `
      <div class="saved-trip-info">
        <h3>${esc(trip.title)}</h3>
        <p>${esc(trip.destination)} · ${when}</p>
        <p class="saved-trip-sub">${(trip.places || []).length}곳 · ${costLabel(trip)}</p>
      </div>
      <button class="btn-ctrl btn-delete" style="padding:8px 12px; font-size:12px;">삭제</button>
    `;
    card.querySelector(".saved-trip-info").addEventListener("click", () => loadSavedTrip(trip.id));
    card.querySelector(".btn-delete").addEventListener("click", () => deleteSavedTrip(trip.id));
    container.appendChild(card);
  });
  if (railHtml && railDay !== 1) container.insertAdjacentHTML("beforeend", railHtml);
}

window.loadSavedTrip = function(tripId) {
  const trip = state.savedTrips.find(t => t.id === tripId);
  if (!trip) return;
  state.activeTrip = cloneTrip(trip);
  state.activeTripDay = getTodayDay(state.activeTrip) || 1;
  showItineraryView();
};

window.deleteSavedTrip = async function(tripId) {
  const index = state.savedTrips.findIndex(t => t.id === tripId);
  if (index < 0) return;
  const trip = state.savedTrips[index];
  if (!(await uiConfirm(`"${trip.title}" 일정을 삭제할까요?`, { okText: "삭제", danger: true }))) return;
  state.savedTrips.splice(index, 1);
  saveToLocalStorage();
  renderSavedTrips();
  showToast(`"${trip.title}" 일정을 삭제했습니다.`, 6000, {
    label: "되돌리기",
    onClick: () => {
      state.savedTrips.splice(Math.min(index, state.savedTrips.length), 0, trip);
      saveToLocalStorage();
      renderSavedTrips();
    }
  });
};

// --- Senior Mode Setup & Management ---
function setupSeniorMode() {
  const toggleBtn = document.getElementById("btn-header-senior");
  const desktopToggleBtn = document.getElementById("btn-desktop-senior");
  const deviceWrapper = document.getElementById("device-wrapper");
  const btnToggleMap = document.getElementById("btn-toggle-map");
  const mapWrapper = document.getElementById("map-wrapper");

  if (!deviceWrapper) return;

  // Apply step classes on load (isInitial = true)
  applyFontSizeStep(toggleBtn, desktopToggleBtn, deviceWrapper, true);

  const handleSeniorToggle = () => {
    state.fontSizeStep = (state.fontSizeStep + 1) % 5;
    state.seniorMode = state.fontSizeStep > 0;
    
    saveToLocalStorage();
    applyFontSizeStep(toggleBtn, desktopToggleBtn, deviceWrapper, false);

    // Re-render templates list to apply description toggling
    renderTemplates();

    // Re-render timeline if on itinerary tab
    if (state.activeTab === "itinerary" && state.activeTrip) {
      renderTimeline();
      updateMapMarkers();
      
      // Reset map toggles on switching modes
      if (btnToggleMap && mapWrapper) {
        mapWrapper.classList.remove("show-senior-map");
        btnToggleMap.classList.remove("active");
        btnToggleMap.textContent = "지도 보기";
      }
    }
  };

  if (toggleBtn) toggleBtn.addEventListener("click", handleSeniorToggle);
  if (desktopToggleBtn) desktopToggleBtn.addEventListener("click", handleSeniorToggle);

  // Map toggle button listener (Senior Mode only)
  if (btnToggleMap && mapWrapper) {
    btnToggleMap.addEventListener("click", () => {
      const isShowing = mapWrapper.classList.toggle("show-senior-map");
      btnToggleMap.classList.toggle("active", isShowing);
      
      if (isShowing) {
        btnToggleMap.textContent = "지도 숨기기";
        setTimeout(refreshMapSize, 150);
      } else {
        btnToggleMap.textContent = "지도 보기";
      }
    });
  }
}

function applyFontSizeStep(toggleBtn, desktopToggleBtn, deviceWrapper, isInitial = false) {
  // Reset all class variations
  deviceWrapper.classList.remove("senior-mode", "senior-mode-xl", "senior-mode-xxl", "senior-mode-xxxl");
  if (toggleBtn) toggleBtn.classList.remove("active");
  if (desktopToggleBtn) desktopToggleBtn.classList.remove("active");

  let buttonText = "글자";
  let toastMsg = "";

  if (state.fontSizeStep === 0) {
    buttonText = "글자";
    if (!isInitial) toastMsg = "일반 글자 크기로 전환되었습니다.";
  } else if (state.fontSizeStep === 1) {
    deviceWrapper.classList.add("senior-mode");
    if (toggleBtn) toggleBtn.classList.add("active");
    if (desktopToggleBtn) desktopToggleBtn.classList.add("active");
    buttonText = "크게";
    if (!isInitial) toastMsg = "큰 글자 크기로 전환되었습니다.";
  } else if (state.fontSizeStep === 2) {
    deviceWrapper.classList.add("senior-mode", "senior-mode-xl");
    if (toggleBtn) toggleBtn.classList.add("active");
    if (desktopToggleBtn) desktopToggleBtn.classList.add("active");
    buttonText = "아주 크게";
    if (!isInitial) toastMsg = "아주 큰 글자 크기로 전환되었습니다.";
  } else if (state.fontSizeStep === 3) {
    deviceWrapper.classList.add("senior-mode", "senior-mode-xl", "senior-mode-xxl");
    if (toggleBtn) toggleBtn.classList.add("active");
    if (desktopToggleBtn) desktopToggleBtn.classList.add("active");
    buttonText = "더 크게";
    if (!isInitial) toastMsg = "더 큰 글자 크기로 전환되었습니다.";
  } else if (state.fontSizeStep === 4) {
    deviceWrapper.classList.add("senior-mode", "senior-mode-xl", "senior-mode-xxl", "senior-mode-xxxl");
    if (toggleBtn) toggleBtn.classList.add("active");
    if (desktopToggleBtn) desktopToggleBtn.classList.add("active");
    buttonText = "가장 크게";
    if (!isInitial) toastMsg = "가장 큰 글자 크기로 전환되었습니다.";
  }

  const sizeHtml = `${window.icon("textsize", 18)}<span>${buttonText}</span>`;
  if (toggleBtn) toggleBtn.innerHTML = sizeHtml;
  if (desktopToggleBtn) desktopToggleBtn.innerHTML = sizeHtml;
  if (!isInitial && toastMsg) showToast(toastMsg);

}

// ==========================================
// --- Confirmation Screen & Collaborations Functions ---
// ==========================================

function triggerConfetti() {
  const container = document.getElementById("confetti-container");
  if (!container) return;
  container.innerHTML = "";
  
  const colors = [
    "var(--primary-solid)",
    "#10B981", // green
    "#F59E0B", // amber
    "#EF4444", // red
    "#3B82F6", // blue
    "#EC4899", // pink
    "#8B5CF6"  // purple
  ];
  
  for (let i = 0; i < 45; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "%";
    piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = Math.random() * 1.5 + "s";
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    container.appendChild(piece);
  }
}

function setupConfirmationScreen() {
  const btnPdf = document.getElementById("btn-action-pdf");
  const btnShare = document.getElementById("btn-action-share");
  const btnCalendar = document.getElementById("btn-action-calendar");
  const btnChecklist = document.getElementById("btn-action-checklist");
  const btnOffline = document.getElementById("btn-action-offline");
  const btnViewTrips = document.getElementById("btn-action-viewtrips");
  const btnOk = document.getElementById("btn-confirmation-ok");

  if (btnPdf) btnPdf.addEventListener("click", () => openPdfPreview());
  if (btnShare) btnShare.addEventListener("click", () => shareItinerary());
  if (btnCalendar) btnCalendar.addEventListener("click", () => downloadCalendarIcs());
  if (btnChecklist) btnChecklist.addEventListener("click", () => openChecklistModal());
  if (btnOffline) btnOffline.addEventListener("click", () => downloadOfflineTxt());
  if (btnViewTrips) btnViewTrips.addEventListener("click", () => {
    switchTab("trips");
    renderSavedTrips();
  });
  if (btnOk) btnOk.addEventListener("click", () => {
    if (state.activeTrip) {
      showItineraryView();
    } else {
      switchTab("explore");
    }
  });

  const btnClosePdf = document.getElementById("btn-close-pdf-modal");
  const overlayPdf = document.getElementById("pdf-modal-overlay");
  const btnPrintPdf = document.getElementById("btn-print-pdf");

  if (btnClosePdf && overlayPdf) {
    btnClosePdf.addEventListener("click", () => {
      overlayPdf.classList.remove("active");
    });
  }
  if (btnPrintPdf) {
    btnPrintPdf.addEventListener("click", () => {
      window.print();
    });
  }

  const btnCloseChecklist = document.getElementById("btn-close-checklist-modal");
  const overlayChecklist = document.getElementById("checklist-modal-overlay");
  const btnAddCustom = document.getElementById("btn-add-custom-checklist");
  const inputCustom = document.getElementById("checklist-custom-input");
  const btnResetChecklist = document.getElementById("btn-reset-checklist");

  if (btnCloseChecklist && overlayChecklist) {
    btnCloseChecklist.addEventListener("click", () => {
      overlayChecklist.classList.remove("active");
    });
  }

  if (btnAddCustom && inputCustom) {
    btnAddCustom.addEventListener("click", () => {
      const text = inputCustom.value.trim();
      if (!text) return;
      if (state.activeTrip && state.activeTrip.checklist) {
        state.activeTrip.checklist.push({
          id: 'custom_' + Date.now(),
          text: text,
          checked: false,
          category: 'custom'
        });
        inputCustom.value = "";
        persistActiveTrip();
        renderChecklist();
      }
    });
    inputCustom.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        btnAddCustom.click();
      }
    });
  }

  if (btnResetChecklist) {
    btnResetChecklist.addEventListener("click", () => {
      if (state.activeTrip) {
        state.activeTrip.checklist = null;
        openChecklistModal();
        persistActiveTrip();
      }
    });
  }
}

function openPdfPreview() {
  const overlay = document.getElementById("pdf-modal-overlay");
  const content = document.getElementById("pdf-preview-content");
  if (!overlay || !content) return;

  if (!state.activeTrip) {
    showToast("활성화된 일정이 없습니다.");
    return;
  }

  let html = `
    <div style="font-family: sans-serif; padding: 20px; line-height: 1.6; color: #1e293b;">
      <h2 style="margin-top: 0; color: #007E9C; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">${esc(state.activeTrip.title)}</h2>
      <div style="margin-bottom: 20px; background: #f8fafc; padding: 12px; border-radius: 8px; font-size: 14px;">
        <p style="margin: 4px 0;"><strong>목적지:</strong> ${esc(state.activeTrip.destination || '미정')}</p>
        <p style="margin: 4px 0;"><strong>여행 기간:</strong> ${state.activeTrip.days}일</p>
        ${state.activeTrip.startDate ? `<p style="margin: 4px 0;"><strong>출발일:</strong> ${esc(state.activeTrip.startDate)}</p>` : ''}
        <p style="margin: 4px 0;"><strong>예상 경비:</strong> ${costLabel(state.activeTrip)}</p>
      </div>
  `;

  for (let d = 1; d <= state.activeTrip.days; d++) {
    const dayPlaces = state.activeTrip.places.filter(p => p.day === d);
    html += `<h3 style="color: #0f172a; margin-top: 24px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px;">Day ${d}${getTripDate(state.activeTrip, d) ? ' · ' + formatShortDate(getTripDate(state.activeTrip, d)) : ''}</h3>`;
    if (dayPlaces.length === 0) {
      html += `<p style="color: #64748b; font-style: italic;">일정이 비어 있습니다.</p>`;
    } else {
      html += `<ol style="padding-left: 20px; margin: 8px 0;">`;
      dayPlaces.forEach(place => {
        let catText = "관광";
        if (place.category === "restaurant") catText = "맛집";
        else if (place.category === "cafe") catText = "카페";
        else if (place.category === "hotel") catText = "숙소";
        else if (place.category === "transit") catText = "이동";
        else if (place.category === "shopping") catText = "쇼핑";

        html += `
          <li style="margin-bottom: 12px;">
            <strong style="font-size: 16px;">[${esc(place.time)}] ${esc(place.name)}</strong> 
            <span style="font-size: 12px; background: #E6F9FD; color: #007E9C; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">${catText}</span>
            ${place.price ? `<span style="font-size: 13px; color: #b45309; font-weight: bold; margin-left: 8px;">${placePriceLabel(place, state.activeTrip)}</span>` : ''}
            ${place.description ? `<p style="margin: 4px 0 0 0; font-size: 13px; color: #475569;">${esc(place.description)}</p>` : ''}
          </li>
        `;
      });
      html += `</ol>`;
    }
  }

  html += `</div>`;
  content.innerHTML = html;
  overlay.classList.add("active");
}

async function shareItinerary() {
  if (!state.activeTrip) return;
  let url;
  try {
    const code = await window.RoutyAI.encodeTrip(state.activeTrip);
    url = `${window.location.origin}${window.location.pathname}#trip=${code}`;
  } catch (e) {
    console.error(e);
    showToast("공유 링크를 만들지 못했습니다.");
    return;
  }
  const title = state.activeTrip.title;
  if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try {
      await navigator.share({ title: `[어디가] ${title}`, text: `${title} 여행 일정`, url });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("공유 링크를 복사했어요! 받은 사람은 링크만 열면 일정을 볼 수 있어요.", 3500);
  } catch (err) {
    await uiPrompt("아래 링크를 복사해 공유하세요.", url, { okText: "닫기", cancelText: "" });
  }
}

async function handleSharedLink() {
  const m = window.location.hash.match(/^#trip=(.+)$/);
  if (!m) return;
  try {
    const trip = await window.RoutyAI.decodeTrip(m[1]);
    trip.source = "shared";
    ensureTripShape(trip);
    state.activeTrip = trip;
    state.activeTripDay = 1;
    history.replaceState(null, "", window.location.pathname + window.location.search);
    showItineraryView();
    showToast("공유받은 일정입니다. '저장'을 누르면 내 일정에 추가돼요.", 4000);
  } catch (e) {
    console.error(e);
    showToast("공유 링크가 손상되어 일정을 열 수 없습니다.", 4000);
  }
}

// 시간 문자열 "09:00 - 10:30" → [시작분, 종료분]
function parseTimeRange(timeStr) {
  const nums = (timeStr || "").match(/(\d{1,2}):(\d{2})/g);
  if (!nums || !nums.length) return null;
  const toMin = (s) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const start = toMin(nums[0]);
  let end = nums[1] ? toMin(nums[1]) : start + 60;
  if (end <= start) end = start + 60;
  return [start, end];
}

function downloadCalendarIcs() {
  if (!state.activeTrip) return;
  const trip = state.activeTrip;
  let base = getTripDate(trip, 1);
  let noDate = false;
  if (!base) {
    base = new Date();
    base.setDate(base.getDate() + 1);
    base.setHours(0, 0, 0, 0);
    noDate = true;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const fmtLocal = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const fmtDate = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const icsText = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Routy//Itinerary//KO", "CALSCALE:GREGORIAN"];
  trip.places.forEach((place, index) => {
    const day = new Date(base);
    day.setDate(base.getDate() + (place.day - 1));
    const range = parseTimeRange(place.time);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${trip.id}-${place.id || index}@routy`);
    lines.push(`DTSTAMP:${stamp}`);
    if (range) {
      const s = new Date(day); s.setMinutes(range[0]);
      const e = new Date(day); e.setMinutes(range[1]);
      lines.push(`DTSTART:${fmtLocal(s)}`);
      lines.push(`DTEND:${fmtLocal(e)}`);
    } else {
      const next = new Date(day); next.setDate(day.getDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${fmtDate(day)}`);
      lines.push(`DTEND;VALUE=DATE:${fmtDate(next)}`);
    }
    lines.push(`SUMMARY:${icsText(`${place.name}`)}`);
    lines.push(`LOCATION:${icsText(place.name)}`);
    if (!place.coordMissing) lines.push(`GEO:${(+place.lat).toFixed(6)};${(+place.lng).toFixed(6)}`);
    lines.push(`DESCRIPTION:${icsText(`[${trip.title}] ${place.description || ""}`)}`);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");

  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${trip.title || "trip"}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  showToast(noDate
    ? "출발일이 없어 내일부터로 캘린더 파일을 만들었어요. 일정 화면 위쪽 날짜 칸에서 출발일을 지정할 수 있어요."
    : "캘린더 파일(.ics)을 받았어요. 열면 캘린더에 추가됩니다.", 4000);
}

const DEFAULT_CHECKLIST_ITEMS = [
  { id: 'c1', text: '여권 및 신분증', checked: false, category: 'essential' },
  { id: 'c2', text: '보조배터리 및 충전기', checked: false, category: 'essential' },
  { id: 'c3', text: '기초 화장품 및 세면도구', checked: false, category: 'essential' },
  { id: 'c4', text: '환전 및 신용카드', checked: false, category: 'essential' },
  { id: 'c5', text: '편안한 여분의 옷과 신발', checked: false, category: 'essential' }
];

function openChecklistModal() {
  const overlay = document.getElementById("checklist-modal-overlay");
  const destInfo = document.getElementById("checklist-dest-info");
  if (!overlay) return;

  if (!state.activeTrip) {
    showToast("활성화된 일정이 없습니다.");
    return;
  }

  destInfo.textContent = `${state.activeTrip.destination || '선택한'} 여행 준비물입니다. 체크 상태는 일정과 함께 저장돼요.`;
  
  if (!state.activeTrip.checklist) {
    state.activeTrip.checklist = JSON.parse(JSON.stringify(DEFAULT_CHECKLIST_ITEMS));
    
    const destination = (state.activeTrip.destination || "").toLowerCase();
    const hasHotel = state.activeTrip.places.some(p => p.category === 'hotel');
    
    if (hasHotel) {
      state.activeTrip.checklist.push({ id: 'chotel', text: '호텔 바우처 및 예약 확인서', checked: false, category: 'booking' });
    }
    const domesticKeywords = ["서울", "부산", "제주", "강릉", "속초", "경주", "여수"];
    const isDomestic = domesticKeywords.some(kw => destination.includes(kw));
    
    if (!isDomestic && destination !== "") {
      state.activeTrip.checklist.push({ id: 'cos1', text: '포켓 와이파이 / 유심(USIM)', checked: false, category: 'overseas' });
      state.activeTrip.checklist.push({ id: 'cos2', text: '110v 변환 플러그 (돼지코)', checked: false, category: 'overseas' });
      state.activeTrip.checklist.push({ id: 'cos3', text: '여행자 보험 가입', checked: false, category: 'overseas' });
    } else {
      state.activeTrip.checklist.push({ id: 'cdom1', text: '모바일 신분증', checked: false, category: 'domestic' });
    }
    (state.activeTrip.checklistSeed || []).forEach((tip, i) => {
      state.activeTrip.checklist.push({ id: 'cai' + i, text: `✨ ${tip}`, checked: false, category: 'ai' });
    });
  }

  renderChecklist();
  overlay.classList.add("active");
}

function renderChecklist() {
  const container = document.getElementById("checklist-items-container");
  if (!container || !state.activeTrip || !state.activeTrip.checklist) return;

  container.innerHTML = "";

  state.activeTrip.checklist.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "checklist-item";
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.justifyContent = "space-between";
    div.style.padding = "10px 0";
    div.style.borderBottom = "1px solid #f1f5f9";

    const label = document.createElement("label");
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "10px";
    label.style.cursor = "pointer";
    label.style.flex = "1";
    if (item.checked) {
      label.style.textDecoration = "line-through";
      label.style.color = "var(--slate-400)";
    }

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.checked;
    checkbox.style.width = "18px";
    checkbox.style.height = "18px";
    checkbox.style.cursor = "pointer";
    checkbox.addEventListener("change", () => {
      item.checked = checkbox.checked;
      if (item.checked) {
        label.style.textDecoration = "line-through";
        label.style.color = "var(--slate-400)";
      } else {
        label.style.textDecoration = "none";
        label.style.color = "inherit";
      }
      persistActiveTrip();
    });

    const spanText = document.createElement("span");
    spanText.textContent = item.text;
    spanText.style.fontSize = "15px";

    label.appendChild(checkbox);
    label.appendChild(spanText);

    const btnDelete = document.createElement("button");
    btnDelete.textContent = "✕";
    btnDelete.style.background = "none";
    btnDelete.style.border = "none";
    btnDelete.style.color = "#ef4444";
    btnDelete.style.cursor = "pointer";
    btnDelete.style.padding = "4px 8px";
    btnDelete.style.fontSize = "14px";
    btnDelete.addEventListener("click", () => {
      state.activeTrip.checklist.splice(index, 1);
      persistActiveTrip();
      renderChecklist();
    });

    div.appendChild(label);
    div.appendChild(btnDelete);
    container.appendChild(div);
  });
}

function downloadOfflineTxt() {
  if (!state.activeTrip) return;
  
  let txt = `=========================================\r\n`;
  txt += `       [어디가] ${state.activeTrip.title} 여행 일정 요약\r\n`;
  txt += `=========================================\r\n\r\n`;
  txt += `목적지: ${state.activeTrip.destination || '미정'}\r\n`;
  txt += `여행 기간: ${state.activeTrip.days}일\r\n`;
  txt += `예상 경비: ${costLabel(state.activeTrip)}\r\n\r\n`;
  
  for (let d = 1; d <= state.activeTrip.days; d++) {
    const dayPlaces = state.activeTrip.places.filter(p => p.day === d);
    txt += `-------------------\r\n`;
    txt += ` Day ${d}\r\n`;
    txt += `-------------------\r\n`;
    if (dayPlaces.length === 0) {
      txt += `(일정이 비어 있습니다)\r\n`;
    } else {
      dayPlaces.forEach((place, index) => {
        let catText = "관광";
        if (place.category === "restaurant") catText = "맛집";
        else if (place.category === "cafe") catText = "카페";
        else if (place.category === "hotel") catText = "숙소";
        else if (place.category === "transit") catText = "이동";
        else if (place.category === "shopping") catText = "쇼핑";
        
        txt += `${index + 1}. [${place.time}] ${place.name} (${catText})\r\n`;
        if (place.price) txt += `   - 예상 금액: ₩${place.price.toLocaleString()}\r\n`;
        if (place.description) txt += `   - 상세: ${place.description}\r\n`;
        txt += `\r\n`;
      });
    }
    txt += `\r\n`;
  }
  
  txt += `=========================================\r\n`;
  txt += `다운로드 시간: ${new Date().toLocaleString()}\r\n`;
  txt += `어디가와 함께 안전하고 즐거운 여행 되세요!\r\n`;
  
  const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.activeTrip.title || 'trip'}_itinerary.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  
  showToast("오프라인 일정 텍스트 파일이 다운로드되었습니다.");
}

// 예전 데이터(공동편집/댓글 필드 등)를 정리하고 필수 필드를 보장
function ensureTripShape(trip) {
  if (!trip) return;
  delete trip.collaborators;
  if (!Array.isArray(trip.places)) trip.places = [];
  if (!trip.days || trip.days < 1) trip.days = Math.max(1, ...trip.places.map(p => p.day || 1));
  trip.places.forEach(place => {
    if (!place.id) place.id = 'p_' + Math.random().toString(36).slice(2, 11);
    delete place.comments;
    place.lat = parseFloat(place.lat);
    place.lng = parseFloat(place.lng);
    if (!isFinite(place.lat) || !isFinite(place.lng)) {
      place.lat = 37.5665;
      place.lng = 126.978;
      place.coordMissing = true;
    }
  });
}
