// 어디가 · '골라서 짜기'
// 1) 여행지 조건을 넣으면 AI가 관광지·맛집·카페·쇼핑·숙소 지역 후보를 추천
// 2) 사용자가 마음에 드는 곳을 담으면
// 3) 날짜별로 가까운 곳끼리 묶어 순서·시간을 자동 배치 (AI 호출 없음)
// 4) 일정 화면에서 남은 후보를 골라 원하는 날에 더 넣을 수 있음
(function () {
  const CATS = [
    ["sightseeing", "관광지", "📍"],
    ["restaurant", "맛집", "🍜"],
    ["cafe", "카페", "☕"],
    ["shopping", "쇼핑·체험", "🛍️"],
    ["hotel", "숙소 지역", "🏨"]
  ];
  const CAT_LABEL = Object.fromEntries(CATS.map(([k, l]) => [k, l]));
  const CAT_EMOJI = Object.fromEntries(CATS.map(([k, , e]) => [k, e]));

  let planMode = "auto"; // auto: AI가 다 짜기, pick: 골라서 짜기
  let pick = null;       // { input, spots: [], picked: Set, cat, loadingMore }

  const $ = id => document.getElementById(id);
  const fmtDur = m => !m ? "" : m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`;
  const fmtPrice = p => p === 0 ? "무료" : typeof p === "number" ? `₩${p.toLocaleString("ko-KR")}` : "";

  // ---------- 플래너 모드 전환 ----------
  function setPlanMode(mode) {
    planMode = mode === "pick" ? "pick" : "auto";
    document.querySelectorAll("#plan-mode [data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === planMode));
    const label = $("btn-generate-label");
    if (label) label.textContent = planMode === "pick" ? "추천 후보 받기" : "AI 일정 생성하기";
    document.querySelectorAll("[data-quick]").forEach(b => {
      b.textContent = planMode === "pick" ? "나머지는 알아서, 바로 후보 받기" : "나머지는 알아서, 바로 만들기";
    });
    const hint = $("plan-mode-hint");
    if (hint) hint.textContent = planMode === "pick"
      ? "AI가 볼거리·맛집·카페 후보를 추천하면, 마음에 드는 곳만 담아서 내 일정을 만들어요."
      : "조건만 넣으면 AI가 동선·시간·식사까지 한 번에 짜 줘요.";
  }
  window.getPlanMode = () => planMode;

  function setupPlanMode() {
    const box = $("plan-mode");
    if (!box) return;
    box.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => setPlanMode(b.dataset.mode)));
    setPlanMode("auto");
  }

  // ---------- 후보 받기 ----------
  function destCoords(dest) {
    const name = String(dest || "").split(/[\/,·]/)[0].trim();
    const tables = [typeof DEFAULT_COORDINATES !== "undefined" ? DEFAULT_COORDINATES : {}, typeof CITY_COORDS !== "undefined" ? CITY_COORDS : {}];
    for (const t of tables) {
      for (const k in t) {
        if (name && (name.includes(k) || k.includes(name))) {
          const v = t[k];
          return Array.isArray(v) ? { lat: v[0], lng: v[1] } : v;
        }
      }
    }
    return null;
  }

  // Gemini 키가 없을 때: Google Places 검색으로 실제 인기 장소를 후보로
  async function placesFallback(input, cats) {
    const c = destCoords(input.destination);
    if (!c) throw new Error("이 여행지는 위치를 몰라서 후보를 못 찾았어요. 설정에서 Gemini 키를 넣으면 AI가 추천해 줘요.");
    const Q = {
      sightseeing: [`${input.destination} 관광 명소`, { includedType: "tourist_attraction", radius: 15000 }],
      restaurant: [`${input.destination} 맛집`, { radius: 8000 }],
      cafe: [`${input.destination} 카페`, { type: "cafe", radius: 8000 }],
      shopping: [`${input.destination} 시장 쇼핑 거리`, { includedType: null, radius: 12000 }]
    };
    const out = [];
    for (const cat of cats) {
      if (!Q[cat]) continue;
      const [q, opts] = Q[cat];
      const res = await window.RoutyAI.placesText(q, c.lat, c.lng, opts).catch(() => null);
      const items = (res && res.items) || (Array.isArray(res) ? res : []);
      items.filter(it => it.name && it.lat && it.count >= 20).slice(0, 8).forEach(it => out.push({
        category: cat, name: it.name, area: it.address || "", lat: it.lat, lng: it.lng,
        description: it.summary || `${it.typeLabel || CAT_LABEL[cat]} · Google 별점 ${it.rating} (${it.count.toLocaleString("ko-KR")})`,
        duration: { restaurant: 60, cafe: 50, shopping: 70 }[cat] || 90, bestTime: "아무때나", tags: [], cuisine: cat === "restaurant" ? (it.typeLabel || "") : "", meal: "any",
        googlePlaceId: it.id
      }));
    }
    if (!out.length) throw new Error("후보를 찾지 못했어요. 설정에서 Gemini 키를 넣으면 AI가 추천해 줘요.");
    return out;
  }

  async function fetchSpots(input, opts = {}) {
    if (window.RoutyAI.hasApiKey()) return window.RoutyAI.suggestSpots(input, opts);
    const cats = opts.category ? [opts.category] : ["sightseeing", "restaurant", "cafe", "shopping"];
    const list = await placesFallback(input, cats);
    const seen = new Set(opts.exclude || []);
    return list.filter(s => !seen.has(s.name));
  }

  function withIds(list) {
    return list.map((s, i) => Object.assign({ id: `sp-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 5)}` }, s));
  }

  window.startPickPlanner = async function (input) {
    const overlay = $("planner-loading-overlay");
    const status = $("loading-status-text");
    const lm = $("loading-mascot");
    if (lm && !lm.innerHTML) lm.innerHTML = window.mascotSvg("think", 120);
    document.body.appendChild(overlay);
    overlay.classList.add("active", "floating");
    $("btn-cancel-generate").style.display = "none";
    status.textContent = `${input.destination}의 볼거리·맛집을 고르는 중...`;
    const t0 = Date.now();
    const tick = setInterval(() => { $("loading-elapsed").textContent = `${Math.floor((Date.now() - t0) / 1000)}초 경과`; }, 1000);
    try {
      const spots = withIds(await fetchSpots(input));
      pick = { input, spots, picked: new Set(), cat: "sightseeing", loadingMore: "" };
      openBoard();
    } catch (e) {
      console.error(e);
      showToast(e.message || "후보를 불러오지 못했어요.", 5000);
    } finally {
      clearInterval(tick);
      overlay.classList.remove("active", "floating");
      $("loading-elapsed").textContent = "";
    }
  };

  // ---------- 후보 고르기 화면 ----------
  function openBoard() {
    $("planner-form").hidden = true;
    $("pick-board").hidden = false;
    renderBoard();
    const sc = document.querySelector("#screen-planner .screen-content");
    if (sc) sc.scrollTop = 0;
  }

  function closeBoard() {
    $("pick-board").hidden = true;
    $("planner-form").hidden = false;
  }

  function cardHtml(s, on, actionAttr) {
    const meta = [s.area, s.category === "hotel" ? "" : fmtDur(s.duration), s.bestTime && s.bestTime !== "아무때나" ? s.bestTime : "", fmtPrice(s.price), s.cuisine]
      .filter(Boolean).map(esc).join(" · ");
    const q = encodeURIComponent(s.searchName || `${s.name} ${pick ? pick.input.destination : ""}`);
    const maps = s.googlePlaceId
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name)}&query_place_id=${encodeURIComponent(s.googlePlaceId)}`
      : `https://www.google.com/maps/search/?api=1&query=${q}`;
    return `
      <div class="pk-card ${on ? "on" : ""}" data-id="${esc(s.id)}">
        <div class="pk-emoji" aria-hidden="true">${CAT_EMOJI[s.category] || "📍"}</div>
        <div class="pk-main">
          <a class="pk-name" href="${maps}" target="_blank" rel="noopener">${esc(s.name)} <span>↗</span></a>
          ${meta ? `<div class="pk-meta">${meta}</div>` : ""}
          ${s.description ? `<div class="pk-desc">${esc(s.description)}</div>` : ""}
          ${s.tags && s.tags.length ? `<div class="pk-tags">${s.tags.map(t => `<span>#${esc(t)}</span>`).join("")}</div>` : ""}
        </div>
        <button type="button" class="pk-add" ${actionAttr}="${esc(s.id)}" aria-pressed="${on}">${actionAttr === "data-add" ? "＋ 넣기" : on ? "✓ 담음" : "＋ 담기"}</button>
      </div>`;
  }

  function renderBoard() {
    if (!pick) return;
    const { input, spots, picked, cat } = pick;
    const box = $("pick-board");
    const countIn = k => spots.filter(s => s.category === k && picked.has(s.id)).length;
    const list = spots.filter(s => s.category === cat);
    const hasHotel = spots.some(s => s.category === "hotel");
    box.innerHTML = `
      <div class="pk-head">
        <button type="button" class="pk-back" id="pk-back">← 조건 바꾸기</button>
        <div class="pk-title">${esc(input.destination)} · ${input.days > 1 ? `${input.days - 1}박 ${input.days}일` : "당일"}</div>
        <div class="pk-sub">마음에 드는 곳을 담아 주세요. 담은 곳으로 일정을 만들어 드려요.</div>
      </div>
      <div class="pk-tabs" role="tablist">
        ${CATS.filter(([k]) => k !== "hotel" || hasHotel).map(([k, l]) => `
          <button type="button" role="tab" class="pk-tab ${cat === k ? "on" : ""}" data-cat="${k}" aria-selected="${cat === k}">
            ${l}${countIn(k) ? ` <b>${countIn(k)}</b>` : ""}
          </button>`).join("")}
      </div>
      ${cat === "hotel" ? `<div class="pk-note">숙소는 '지역'을 골라요. 담으면 그 근처에서 묵는 걸로 일정을 짜고, 실제 숙소는 일정 화면의 최저가 숙소에서 예약하면 돼요.</div>` : ""}
      ${cat === "restaurant" ? `<div class="pk-note">담지 않은 끼니는 일정을 만들 때 근처 Google 1위 식당으로 자동으로 채워요.</div>` : ""}
      <div class="pk-list">
        ${list.length ? list.map(s => cardHtml(s, picked.has(s.id), "data-toggle")).join("") : `<div class="pk-empty">이 종류는 추천이 없어요. 아래 '더 추천받기'를 눌러 보세요.</div>`}
      </div>
      ${cat !== "hotel" ? `<button type="button" class="btn btn-secondary btn-block pk-more" id="pk-more" ${pick.loadingMore ? "disabled" : ""}>${pick.loadingMore === cat ? "찾는 중…" : `${CAT_LABEL[cat]} 더 추천받기`}</button>` : ""}
      <div class="pk-bar">
        <div class="pk-bar-text"><b>${picked.size}곳</b> 담음${picked.size ? ` · ${CATS.filter(([k]) => countIn(k)).map(([k, l]) => `${l} ${countIn(k)}`).join(", ")}` : ""}</div>
        <button type="button" class="btn btn-primary" id="pk-make">일정으로 만들기 →</button>
      </div>`;
    box.querySelector("#pk-back").addEventListener("click", closeBoard);
    box.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => { pick.cat = b.dataset.cat; renderBoard(); }));
    box.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", () => {
      const id = b.getAttribute("data-toggle");
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      renderBoard();
    }));
    const more = box.querySelector("#pk-more");
    if (more) more.addEventListener("click", loadMore);
    box.querySelector("#pk-make").addEventListener("click", makeTrip);
  }

  async function loadMore() {
    if (!pick || pick.loadingMore) return;
    const cat = pick.cat;
    pick.loadingMore = cat;
    renderBoard();
    try {
      const more = withIds(await fetchSpots(pick.input, { category: cat, exclude: pick.spots.map(s => s.name) }));
      const names = new Set(pick.spots.map(s => s.name));
      const fresh = more.filter(s => s.category === cat && !names.has(s.name));
      pick.spots.push(...fresh);
      showToast(fresh.length ? `${CAT_LABEL[cat]} ${fresh.length}곳을 더 찾았어요.` : "새로운 곳을 더 찾지 못했어요.");
    } catch (e) {
      showToast(e.message || "더 불러오지 못했어요.", 4000);
    } finally {
      pick.loadingMore = "";
      renderBoard();
    }
  }

  // ---------- 담은 곳으로 일정 배치 (AI 없이) ----------
  function dist(a, b) { return Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180)); }
  function centroid(pts) {
    if (!pts.length) return null;
    return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
  }

  // 가까운 곳끼리 k개로 묶기 (작은 k-means, 한 날에 너무 몰리지 않게 상한)
  function clusterByDay(points, k) {
    if (!points.length) return Array.from({ length: k }, () => []);
    k = Math.max(1, Math.min(k, points.length));
    const cap = Math.ceil(points.length / k) + 1;
    const sorted = points.slice().sort((a, b) => a.lng - b.lng);
    let centers = [sorted[0]];
    while (centers.length < k) {
      const far = sorted.reduce((best, p) => {
        const d = Math.min(...centers.map(c => dist(p, c)));
        return d > best.d ? { p, d } : best;
      }, { p: sorted[0], d: -1 }).p;
      centers.push(far);
    }
    let groups = [];
    for (let it = 0; it < 8; it++) {
      groups = centers.map(() => []);
      const order = points.map(p => ({ p, ds: centers.map(c => dist(p, c)) }))
        .sort((a, b) => Math.min(...a.ds) - Math.min(...b.ds));
      for (const { p, ds } of order) {
        const idx = ds.map((d, i) => [d, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]).find(i => groups[i].length < cap);
        groups[idx === undefined ? 0 : idx].push(p);
      }
      centers = groups.map((g, i) => centroid(g) || centers[i]);
    }
    // 서쪽에서 동쪽 순서로 (동선이 크게 오가지 않게)
    return groups.map((g, i) => ({ g, c: centers[i] })).sort((a, b) => a.c.lng - b.c.lng).map(x => x.g);
  }

  // 그날 안에서 가까운 순서로 잇기
  function nearestOrder(list, start) {
    const rest = list.slice(), out = [];
    let cur = start || rest.slice().sort((a, b) => a.lng - b.lng)[0];
    while (rest.length) {
      rest.sort((a, b) => dist(cur, a) - dist(cur, b));
      cur = rest.shift();
      out.push(cur);
    }
    return out;
  }

  function arrange(input, chosen) {
    const days = Math.max(1, input.days || 1);
    const withPt = chosen.filter(s => typeof s.lat === "number" && typeof s.lng === "number");
    const noPt = chosen.filter(s => !(typeof s.lat === "number" && typeof s.lng === "number"));
    const stays = withPt.filter(s => s.category === "hotel");
    const meals = withPt.filter(s => s.category === "restaurant");
    const visits = withPt.filter(s => s.category !== "hotel" && s.category !== "restaurant");
    const groups = clusterByDay(visits, days);
    while (groups.length < days) groups.push([]);
    noPt.filter(s => s.category !== "hotel").forEach(s => groups.sort((a, b) => a.length - b.length)[0].push(s));

    const wake = input.wake && /^\d{1,2}:\d{2}$/.test(input.wake) ? hhmmToMin(input.wake) : 8 * 60;
    const booked = input.booked || {};
    const outArr = booked.out && booked.out.arr ? hhmmToMin(booked.out.arr) : null;
    const retDep = booked.ret && booked.ret.dep ? hhmmToMin(booked.ret.dep) : null;
    // 담은 식당은 가장 가까운 날에 나눠 담기 (하루 2곳까지, 넘치면 다음으로 가까운 날)
    const dayCenters = groups.map(g => centroid(g.filter(p => typeof p.lat === "number")));
    const mealsByDay = Array.from({ length: days }, () => []);
    const leftMeals = [];
    meals.forEach(m => {
      const order = dayCenters.map((c, i) => [c ? dist(c, m) : Infinity, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
      const d = order.find(i => mealsByDay[i].length < 2);
      if (d === undefined) leftMeals.push(m); else mealsByDay[d].push(m);
    });
    const takeMeal = (d, kind) => {
      const pool = mealsByDay[d - 1];
      if (!pool.length) return null;
      const m = pool.find(x => x.meal === kind) || pool.find(x => x.meal === "any") || pool[0];
      pool.splice(pool.indexOf(m), 1);
      return m;
    };

    const places = [];
    const fallbackCenter = centroid(withPt) || destCoords(input.destination);
    for (let d = 1; d <= days; d++) {
      const stay = stays.length ? stays[(d - 1) % stays.length] : null;
      const prevStay = d > 1 && stays.length ? stays[(d - 2) % stays.length] : null;
      const list = groups[d - 1] || [];
      const center = centroid(list.filter(p => typeof p.lat === "number")) || (stay ? stay : fallbackCenter);
      // 가까운 순서로 잇고, 추천 시간대(오전 → 오후 → 저녁)는 지키기 (야경은 저녁에)
      const rank = s => ({ "오전": 0, "오후": 1, "아무때나": 1, "저녁": 2 }[s.bestTime] ?? 1);
      const ordered = nearestOrder(list.filter(p => typeof p.lat === "number"), prevStay || null)
        .concat(list.filter(p => typeof p.lat !== "number"))
        .map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s);
      let cur = d === 1 ? Math.max(10 * 60, outArr !== null ? outArr + 60 : 0) : Math.max(wake + 90, 9 * 60 + 30);
      const end = d === days && days > 1 ? (retDep !== null ? retDep - 150 : 17 * 60) : 21 * 60 + 30;
      // 그날 담은 식당이 하나뿐이면, 저녁 일정(야경 등)이 있거나 저녁용이면 저녁으로
      const hasEvening = ordered.some(s => rank(s) === 2);
      const only = mealsByDay[d - 1].length === 1 ? mealsByDay[d - 1][0] : null;
      const onlyDinner = only && (only.meal === "dinner" || (only.meal === "any" && hasEvening));
      const dinner = onlyDinner ? takeMeal(d, "dinner") : null;
      const lunch = takeMeal(d, "lunch");
      const dinner2 = dinner || takeMeal(d, "dinner");
      let lunchDone = !lunch, dinnerDone = !dinner2;
      const push = (s, start, dur, extra) => {
        places.push(Object.assign({
          id: `custom-pick-${d}-${places.length}-${Math.random().toString(36).slice(2, 6)}`,
          day: d, name: s.name, category: s.category === "shopping" ? "shopping" : s.category,
          time: `${minutesToHHMM(start)} - ${minutesToHHMM(start + dur)}`,
          lat: s.lat, lng: s.lng, description: s.description || "", price: s.price,
          cuisine: s.cuisine || undefined, bookingUrl: "", fromPick: true,
          googlePlaceId: s.googlePlaceId || undefined, autoTopTried: true
        }, extra || {}));
        return start + dur;
      };
      for (const s of ordered) {
        const dur0 = s.duration || 90;
        // 저녁에 볼 곳(야경 등): 점심·저녁을 먼저 넣고 해 진 뒤(19시)에
        if (rank(s) === 2 && cur < 18 * 60 + 30) {
          if (!lunchDone && cur <= 14 * 60) { cur = push(lunch, Math.max(cur, 11 * 60 + 30), 60) + 20; lunchDone = true; }
          if (!dinnerDone) { cur = push(dinner2, Math.max(cur, 17 * 60 + 30), 70) + 20; dinnerDone = true; }
          cur = Math.max(cur, 19 * 60);
        }
        if (!lunchDone && (cur >= 11 * 60 + 30 || (cur >= 11 * 60 && cur + dur0 > 13 * 60 + 30) || (rank(s) === 2 && cur < 15 * 60))) {
          cur = push(lunch, Math.max(cur, 11 * 60 + 30), 60) + 20; lunchDone = true;
        }
        if (!dinnerDone && (cur >= 17 * 60 + 30 || (rank(s) === 2 && cur >= 16 * 60 + 30))) { cur = push(dinner2, Math.max(cur, 17 * 60 + 30), 70) + 20; dinnerDone = true; }
        if (cur + s.duration > end && places.some(p => p.day === d)) {
          // 그날 시간이 모자라면 다음 날로 넘김
          if (d < days) { (groups[d] = groups[d] || []).unshift(s); continue; }
        }
        cur = push(s, cur, s.duration || 90) + 20;
      }
      if (!lunchDone && (d < days || end >= 13 * 60)) { cur = push(lunch, Math.max(cur, 12 * 60), 60) + 20; lunchDone = true; }
      if (!dinnerDone && (d < days || end >= 19 * 60)) { cur = push(dinner2, Math.max(cur, 18 * 60), 70) + 20; dinnerDone = true; }
      if (stay && d < days) {
        places.push({
          id: `custom-pick-stay-${d}-${Math.random().toString(36).slice(2, 6)}`,
          day: d, name: `${stay.name} 숙소`, category: "hotel",
          time: `${minutesToHHMM(Math.max(21 * 60 + 30, cur))} - ${minutesToHHMM(Math.max(21 * 60 + 30, cur) + 30)}`,
          lat: stay.lat, lng: stay.lng, description: stay.description || "이 근처에서 숙소를 잡아요.", fromPick: true
        });
      }
    }
    // 끼니보다 많이 담은 식당은 오후 간식 시간으로
    mealsByDay.forEach(pool => leftMeals.push(...pool));
    leftMeals.forEach((m, i) => {
      const d = Math.min(days, 1 + (i % days));
      places.push({
        id: `custom-pick-extra-${i}-${Math.random().toString(36).slice(2, 6)}`,
        day: d, name: m.name, category: "restaurant", time: "15:30 - 16:20", lat: m.lat, lng: m.lng,
        description: m.description || "", cuisine: m.cuisine || undefined, price: m.price, fromPick: true, autoTopTried: true
      });
    });
    return places;
  }

  function makeTrip() {
    if (!pick) return;
    const chosen = pick.spots.filter(s => pick.picked.has(s.id));
    if (!chosen.length) { showToast("먼저 가고 싶은 곳을 하나 이상 담아 주세요."); return; }
    const input = pick.input;
    const places = arrange(input, chosen);
    const trip = {
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
      title: `${input.destination} ${input.days > 1 ? `${input.days - 1}박 ${input.days}일` : "당일"} (내가 고른 곳)`,
      summary: `직접 담은 ${chosen.length}곳으로 만든 일정이에요. 시간과 순서는 자유롭게 바꾸고, '후보에서 추가'로 더 넣을 수 있어요.`,
      places,
      candidates: pick.spots.map(s => Object.assign({}, s, { used: pick.picked.has(s.id) })),
      source: "pick",
      createdAt: Date.now()
    };
    ensureTripShape(trip);
    ensurePlacePrices(trip);
    ensureMeals(trip);
    state.activeTrip = trip;
    state.activeTripDay = 1;
    applyBookedToTrip(trip, input.booked);
    saveDraft();
    closeBoard();
    pick = null;
    document.getElementById("input-destination").value = "";
    document.getElementById("input-request").value = "";
    clearBookedBox();
    if (window.plannerGoStep) window.plannerGoStep(1);
    showItineraryView();
    if (window.RoutyAI.hasPlacesKey()) autoPickTop(trip);
    showToast(`담은 ${chosen.length}곳으로 일정을 만들었어요. 빈 끼니는 근처 1위 식당으로 채워요.`, 5000);
  }

  // ---------- 일정 화면: 후보에서 추가 ----------
  function unusedCandidates(trip) {
    if (!trip || !Array.isArray(trip.candidates)) return [];
    const names = new Set(trip.places.map(p => p.name));
    return trip.candidates.filter(c => c.category !== "hotel" && !names.has(c.name));
  }

  window.renderCandidateTrigger = function () {
    const btn = $("btn-add-from-candidates");
    if (!btn) return;
    const n = unusedCandidates(state.activeTrip).length;
    btn.hidden = !n;
    const b = btn.querySelector("b");
    if (b) b.textContent = n;
  };

  function openCandidateSheet() {
    const trip = state.activeTrip;
    const list = unusedCandidates(trip);
    if (!list.length) return;
    const day = state.activeTripDay || 1;
    const ov = document.createElement("div");
    ov.className = "pk-sheet-overlay";
    const byCat = CATS.filter(([k]) => k !== "hotel").map(([k, l]) => [k, l, list.filter(c => c.category === k)]).filter(x => x[2].length);
    ov.innerHTML = `
      <div class="pk-sheet" role="dialog" aria-label="후보에서 추가">
        <div class="pk-sheet-head"><b>Day ${day}에 넣을 곳</b><button type="button" class="pk-close" aria-label="닫기">✕</button></div>
        <div class="pk-sheet-body">
          ${byCat.map(([k, l, items]) => `<h4>${CAT_EMOJI[k]} ${l}</h4>${items.map(c => cardHtml(c, false, "data-add")).join("")}`).join("")}
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    ov.querySelector(".pk-close").addEventListener("click", close);
    ov.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", () => {
      const c = list.find(x => x.id === b.getAttribute("data-add"));
      if (!c) return;
      addCandidateToDay(trip, c, day);
      close();
    }));
  }

  function addCandidateToDay(trip, c, day) {
    withUndo(() => `'${c.name}'을(를) Day ${day}에 넣었어요. 시간은 눌러서 바꿀 수 있어요.`, () => {
      const dayPlaces = trip.places.filter(p => p.day === day).map(p => ({ p, r: parseTimeRange(p.time) })).filter(x => x.r);
      const last = dayPlaces.filter(x => x.p.category !== "hotel" && !(x.p.category === "transit" && x.p.intercity === "back")).sort((a, b) => a.r[1] - b.r[1]).pop();
      const start = last ? last.r[1] + 20 : 10 * 60;
      const dur = c.duration || 60;
      trip.places.push({
        id: `custom-pick-add-${Date.now().toString(36)}`,
        day, name: c.name, category: c.category, time: `${minutesToHHMM(start)} - ${minutesToHHMM(start + dur)}`,
        lat: c.lat, lng: c.lng, description: c.description || "", cuisine: c.cuisine || undefined, price: c.price,
        googlePlaceId: c.googlePlaceId || undefined, autoTopTried: true, fromPick: true
      });
      sortTripPlaces(trip, day);
      ensurePlacePrices(trip);
    });
  }

  function setup() {
    setupPlanMode();
    const t = $("btn-add-from-candidates");
    if (t) t.addEventListener("click", openCandidateSheet);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
