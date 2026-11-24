// Routy - 외부 서비스 모듈
// 1) Gemini API로 실제 여행 일정 생성/수정
// 2) OpenStreetMap Nominatim 장소 검색(좌표)
// 3) 일정 공유 링크 인코딩/디코딩

(function () {
  const SETTINGS_KEY = "routy_settings";
  const DEFAULT_MODEL = "gemini-3.8-flash";
  // 네이버 지도 Client ID (등록한 github.io 주소에서만 동작하는 공개용 키)
  const DEFAULT_NAVER_KEY = "btolm1xold";
  const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
  const CATEGORIES = ["sightseeing", "restaurant", "cafe", "shopping", "hotel", "transit"];
  // 장소 사이 이동 수단
  const MOVE_MODES = ["walk", "bus", "express", "subway", "train", "car", "taxi", "bike", "ferry", "flight"];
  // 여행 전체 이동 방식
  const TRANSPORT_PROMPT = {
    auto: "이동 수단은 상황에 맞게 가장 효율적인 것으로 섞어서 (도보·대중교통·택시 등)",
    transit: "대중교통(지하철·버스·기차) 위주. 역·정류장에서 가까운 장소로 동선을 짜고, 택시는 꼭 필요할 때만",
    car: "자가용으로 집(출발지)에서부터 직접 운전해 이동. 차로 가기 좋은 교외 명소도 포함하고, 장소마다 주차 가능 여부나 주차 팁을 설명에 짧게 넣기",
    rental: "목적지에 도착한 공항·역·터미널에서 렌터카를 빌려 이동. 첫날 도착 직후 그곳에 '○○ 렌터카 인수'(category transit), 마지막 날 떠나기 전 '○○ 렌터카 반납'(transit)을 넣고, 장소 사이 이동은 car. 차로 가기 좋은 교외 명소도 포함하고 주차 팁을 설명에 짧게 넣기",
    taxi: "택시 위주. 이동 시간이 짧도록 묶고, 택시 잡기 어려운 곳은 피하기",
    walk: "도보 위주. 걸어서 이동 가능한 범위로 촘촘하게, 먼 곳만 대중교통"
  };

  // Google Places 키 (웹사이트 제한 걸린 공개용 키만 여기에 넣기)
  const DEFAULT_PLACES_KEY = "AIzaSyDRnpb7y9YUvDBsK2lblV4awL1wFTxqO64"; // 웹사이트(github.io) + Places API (New)만 허용된 키
  const PLACES_DAILY_LIMIT = 100;
  const PLACES_USAGE_KEY = "routy_places_usage";

  // ---------- 설정 ----------
  function getSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return {
        apiKey: s.apiKey || "",
        model: s.model || DEFAULT_MODEL,
        kakaoKey: s.kakaoKey || "",
        naverKey: s.naverKey === undefined ? DEFAULT_NAVER_KEY : s.naverKey,
        placesKey: s.placesKey || DEFAULT_PLACES_KEY, // 빈 값이 저장돼 있어도 기본 키 사용
        placesSort: s.placesSort === "count" ? "count" : "rating",
        noSpicy: !!s.noSpicy,
        avoidFoods: s.avoidFoods ? String(s.avoidFoods).slice(0, 100) : ""
      };
    } catch (e) {
      return { apiKey: "", model: DEFAULT_MODEL, kakaoKey: "", naverKey: DEFAULT_NAVER_KEY, placesKey: DEFAULT_PLACES_KEY, placesSort: "rating", noSpicy: false, avoidFoods: "" };
    }
  }

  function saveSettings(partial) {
    const next = Object.assign(getSettings(), partial);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  function hasApiKey() {
    return !!getSettings().apiKey;
  }

  // ---------- Gemini 호출 ----------
  const STYLE_LABELS = {
    relaxing: "힐링/휴양",
    active: "액티비티/관광",
    foodie: "맛집 투어",
    shopping: "쇼핑/감성카페",
    cultural: "역사/문화"
  };
  const BUDGET_LABELS = {
    low: "가성비 위주(저렴하게)",
    medium: "보통",
    high: "고급/럭셔리"
  };

  const OUTPUT_SPEC = `
반드시 아래 형식의 JSON 객체 하나만 출력하세요. 설명 문장이나 코드블록 표시는 쓰지 마세요.
{
  "title": "일정 제목 (예: 교토 단풍 2박3일)",
  "summary": "일정 전체 요약 1~2문장",
  "places": [
    {
      "day": 1,
      "time": "09:00 - 10:30",
      "name": "장소 이름 (한국어 표기)",
      "searchName": "지도에서 검색할 현지어 또는 영어 공식 이름 (예: Ichiran Honten)",
      "cuisine": "restaurant·cafe만: 대표 음식 종류 1~2단어 (예: 가이세키, 돼지국밥, 라멘, 디저트 카페)",
      "category": "sightseeing | restaurant | cafe | shopping | hotel | transit 중 하나",
      "lat": 35.0,
      "lng": 135.0,
      "description": "무엇을 하는지·팁을 한 문장으로 짧게 (한국어)",
      "price": 15000,
      "priceUnit": "person 또는 group",
      "move": { "mode": "walk | bus | express | subway | train | car | taxi | bike | ferry | flight 중 하나", "minutes": 15, "cost": 1500, "note": "직전 장소에서 여기까지 가는 방법 (예: 2호선 강남역→홍대입구역)", "from": "기차·고속버스·비행기일 때만: 출발역/터미널/공항 (예: 서울역, 인천국제공항(ICN))", "to": "기차·고속버스·비행기일 때만: 도착역/터미널/공항 (예: 부산역, 간사이국제공항(KIX))", "service": "기차·고속버스·비행기일 때만: KTX | SRT | 고속버스 | 시외버스 | 항공사 예시(예: 저가항공 제주항공·피치) 등" },
      "alternatives": [
        { "name": "식당 후보 이름", "searchName": "현지어/영어 이름", "lat": 35.0, "lng": 135.0, "description": "대표 메뉴·특징 한 문장", "price": 12000 }
      ]
    }
  ],
  "tips": ["이 여행에 맞는 준비물/주의사항 3~6개 (짧게)"]
}
규칙:
- 식사(category "restaurant")는 "○○ 먹자골목", "○○ 식당가", "시장 음식 거리"처럼 지역으로 뭉뚱그리지 말고 반드시 실제 개별 식당 하나를 정하세요.
- 각 식사 장소에는 alternatives로 같은 동네(도보·짧은 이동 거리)의 다른 실제 식당 2곳을 추가로 주세요. 평판 좋고 리뷰 많은 유명한 곳을 우선하되 메뉴 종류나 가격대가 겹치지 않게. 식사가 아닌 장소에는 alternatives를 넣지 마세요.
- 실제로 존재하는 장소만 사용하고, lat/lng는 그 장소의 실제 좌표(소수점 4자리 이상)로 적으세요.
- price는 원화(KRW) 정수. 입장료·식사처럼 사람마다 내는 비용은 priceUnit "person"(1인 기준),
  숙소(1박 객실 요금)·택시·렌터카처럼 일행이 함께 내는 비용은 priceUnit "group"(일행 전체 금액). 무료면 0.
- time은 24시간제 "HH:MM - HH:MM" 형식. 하루 일정은 시간 순서대로.
- 끼니(매우 중요): 여행지에 있는 동안 아래 '넣을 식사'로 정한 끼니를 매일 빠짐없이 각각 category "restaurant"로 넣고, name 끝에 (아침)·(점심)·(저녁)을 붙이세요. 넣지 않기로 한 끼니는 넣지 마세요. 식사는 시작부터 끝까지 정해진 시간대 안에 넣으세요: 아침 07:00~09:00, 점심 12:00~14:00, 저녁 18:00~20:00 (예: 점심 12:30 - 13:30). 아침은 숙박한 다음 날부터 숙소 근처 아침 식당(숙소 조식이면 "숙소 조식 (아침)")으로. 첫날은 도착 뒤 끼니만, 마지막 날은 출발 전 끼니만 넣으세요. 카페·간식은 끼니로 치지 않습니다.
- 식사를 포함해 하루 5~8곳. 이동 동선이 짧도록 가까운 곳끼리 묶으세요.
- 숙박이 있는 날(마지막 날 제외)은 그날 마지막에 숙소(category "hotel")를 넣으세요.
- 숙소는 소비 성향에 맞추세요: 가성비면 게스트하우스·비즈니스호텔·모텔급 깔끔한 곳, 보통이면 3~4성급, 고급이면 4~5성급·리조트. 숙박비 예산이 있으면 (예산 ÷ 숙박일수) 안의 실제 숙소를 고르세요. 숙소 price는 성수기·주말이 아닌 평일 기준 1박 객실 요금 추정치.
- 같은 숙소에 연박하면 매일 같은 이름으로 넣으세요.
- 장거리 이동(공항, 기차 등)은 category "transit"으로 넣으세요.
- move는 "직전 장소에서 이 장소까지" 이동 방법입니다. 각 날의 첫 장소는 move를 생략하세요. minutes는 예상 소요 시간(분).
- 비행기 구간(flight)은 from/to에 공항 이름과 IATA 코드 괄호 표기(예: 김포국제공항(GMP), 제주국제공항(CJU))를 꼭 쓰고, cost는 일반석 편도 1인 요금 추정치, minutes는 비행 시간입니다.
- 도시 간 장거리 버스는 bus가 아니라 express(고속·시외버스)로 쓰세요. train·express는 from/to에 실제 역·터미널 정식 이름, service에 열차·버스 종류를 꼭 넣고, cost는 일반실·일반고속 기준 1인 정가를 추정해 넣으세요. 수서·동탄 출발 고속철은 SRT, 서울·용산역 출발은 KTX입니다.
- move.cost는 이동 요금(원, 정수). 택시·자가용(유류비·통행료·주차비)·렌터카는 일행 전체 금액, 버스·지하철·기차·배·비행기는 1인 요금, 도보·자전거는 0.`;

  // 항목별 예산(원, 일행 전체·여행 전체 기간) → 프롬프트 문장
  function budgetPlanLine(plan, people) {
    if (!plan) return "";
    const names = { food: "식비", transport: "교통비", lodging: "숙박비" };
    const parts = Object.keys(names).filter(k => plan[k] > 0).map(k => `${names[k]} ${Math.round(plan[k]).toLocaleString()}원`);
    if (!parts.length) return "";
    return `- 예산(일행 ${people || 1}명 전체, 여행 전체 기간): ${parts.join(", ")}. 금액이 정해진 항목은 그 안에 맞추고(숙박비는 모든 숙박일 합계), 정해지지 않은 항목은 소비 성향을 따르세요.`;
  }

  // 식성 (설정에 저장, 모든 일정·식당 추천에 적용)
  function dietLine() {
    const s = getSettings();
    const out = [];
    if (s.noSpicy) {
      out.push("- 식성(매우 중요): 일행이 매운 음식을 전혀 못 먹습니다. 대표 메뉴가 매운 식당(마라탕·마라샹궈·훠궈·떡볶이·짬뽕·닭발·쭈꾸미·낙지볶음·매운탕·아구찜·해물찜·닭갈비·찜닭·불닭·김치찜·부대찌개·육개장·감자탕·탄탄면·태국/인도 커리 전문점 등)은 절대 고르지 말고, 맵지 않은 메뉴가 중심인 곳을 고르세요. 식당 description에는 맵지 않은 추천 메뉴를 적으세요.");
    }
    if (s.avoidFoods) out.push(`- 못 먹는 음식: ${s.avoidFoods}. 이 음식이 주메뉴인 식당은 제외하세요.`);
    return out.join("\n");
  }

  // 넣을 식사 (플래너의 '일정에 넣을 식사')
  function mealLine(input) {
    const m = input.meals;
    if (!m) return "";
    const parts = [];
    parts.push(m.breakfast === "hotel" ? "아침: 숙소 조식(name \"숙소 조식 (아침)\", 숙소 위치, price 0)" : m.breakfast === "out" ? "아침: 숙소 근처 아침 식당" : "아침: 넣지 않음");
    parts.push(m.lunch ? "점심: 넣음" : "점심: 넣지 않음(그 시간은 관광·카페로)");
    parts.push(m.dinner ? "저녁: 넣음" : "저녁: 넣지 않음(저녁 시간은 자유 시간)");
    return `- 넣을 식사: ${parts.join(", ")}.`;
  }

  // 이미 예매한 가는 편·오는 편 시각 (플래너의 '이미 예매했어요')
  function bookedLine(input) {
    const b = input.booked;
    if (!b || !((b.out && (b.out.dep || b.out.arr)) || (b.ret && (b.ret.dep || b.ret.arr)))) return "";
    const kind = { flight: "비행기", train: "기차(KTX 등)", express: "고속·시외버스" }[b.mode] || "교통편";
    const leg = (l, label) => l && (l.dep || l.arr) ? `${label} ${l.no ? l.no + " " : ""}${l.dep ? l.dep + " 출발" : ""}${l.dep && l.arr ? " → " : ""}${l.arr ? l.arr + " 도착" : ""}` : "";
    const parts = [leg(b.out, "가는 편(Day 1)"), leg(b.ret, `오는 편(Day ${input.days})`)].filter(Boolean).join(", ");
    return `- 이미 예매한 ${kind}(가장 중요, 시각은 모두 현지 시각): ${parts}. ` +
      `Day 1은 가는 편 도착 시각에 맞춰 첫 장소로 도착 ${b.mode === "flight" ? "공항" : "역·터미널"}(category transit, time 시작 = 도착 시각, move.mode "${b.mode}", move.note에 편명·번호)을 넣고, ` +
      `${b.mode === "flight" ? "입국·짐 찾기와 시내 이동 시간" : "역·터미널에서 다음 장소까지 이동 시간"}을 고려해 그 뒤부터 일정을 짜세요. 도착이 늦으면 첫날은 체크인·저녁 위주로 가볍게. ` +
      (b.ret && b.ret.dep ? `Day ${input.days}은 오는 편 ${b.ret.dep} 출발에 맞춰 ${b.mode === "flight" ? "국제선이면 2시간 30분, 국내선이면 1시간" : "20분"} 전까지 출발 ${b.mode === "flight" ? "공항" : "역·터미널"}에 도착하도록 앞 일정을 끝내고, 마지막 장소로 그 출발 지점(category transit)을 넣으세요. 그 뒤 관광 일정은 넣지 마세요.` : "");
  }

  function buildCreatePrompt(input) {
    const styles = (input.styles || []).map(s => STYLE_LABELS[s] || s).join(", ") || "자유";
    const lines = [
      "당신은 한국인 여행자를 위한 전문 여행 플래너입니다. 아래 조건으로 실제 여행 일정을 만들어 주세요.",
      `- 목적지: ${input.destination}`,
      `- 출발지: ${input.origin || "광주"}. 출발지와 목적지 사이 오가는 구간을 첫날 맨 앞(도착)과 마지막 날 맨 끝(귀가)에 넣으세요. 해외면 비행기(flight, 도착 공항을 transit으로). 국내 섬(제주·울릉도 등)이면 비행기(flight) 또는 배(ferry). 국내 내륙이면 비행기·배는 절대 쓰지 말고 ${input.transport === "car" ? "자가용(car)으로 집에서 바로 운전해" : "기차(KTX·SRT 등 train) 또는 고속·시외버스(express)로"} 오가고${input.transport === "car" ? "" : ", 도착역·터미널을 transit으로 넣으세요"}.${/광주|전남/.test(input.origin || "광주") ? " 광주(전남광주특별시) 출발이면 국내선은 광주공항(KWJ), 해외는 인천공항(ICN) 출발로 잡고 광주송정역→인천공항 이동도 넣으세요." : ""}`,
      mealLine(input),
      bookedLine(input) || "- 오가는 구간 시간: 아직 예매 전입니다. 비행기·기차·버스는 실제로 그 노선에 운행하는 시간대로 잡으세요(예: 국내선은 오전 7~10시 출발편, 인천 출발 국제선은 오전 8~11시 출발편, KTX·고속버스는 오전 7~9시 출발). move.minutes에는 실제 소요 시간을, move.note에는 \"HH:MM 출발 예상\"처럼 출발 시각을 적으세요. 도착 공항·역 transit의 time 시작은 그 도착 시각입니다.",
      `- 기간: ${input.days}일${input.days > 1 ? ` (${input.days - 1}박 ${input.days}일)` : " (당일치기)"}`,
      input.startDate ? `- 출발일: ${input.startDate} (계절/요일/휴무일을 고려하세요)` : "",
      input.party ? `- 동행: ${input.party}${input.people ? ` (총 ${input.people}명)` : ""}` : "",
      `- 이동 수단: ${TRANSPORT_PROMPT[input.transport] || TRANSPORT_PROMPT.auto}`,
      `- 소비 성향: ${BUDGET_LABELS[input.budget] || "보통"}`,
      budgetPlanLine(input.budgetPlan, input.people),
      `- 선호 스타일: ${styles}`,
      input.wake ? `- 기상 시간: 매일 ${input.wake}에 일어납니다. 준비·아침 식사와 숙소에서 첫 장소까지 이동을 고려해 매일 첫 일정은 기상 1시간 이상 뒤에 시작하세요 (첫날 이동 일정이 따로 정해져 있으면 그것을 우선).` : "",
      dietLine(),
      input.request ? `- 추가 요청: ${input.request}` : "",
      OUTPUT_SPEC
    ];
    return lines.filter(Boolean).join("\n");
  }

  function buildRefinePrompt(trip, instruction, day) {
    const slim = {
      title: trip.title,
      destination: trip.destination,
      days: trip.days,
      people: trip.people || null,
      transport: TRANSPORT_PROMPT[trip.transport] || TRANSPORT_PROMPT.auto,
      spending: BUDGET_LABELS[trip.budget] || "보통",
      budgetPlan: budgetPlanLine(trip.budgetPlan, trip.people) || null,
      startDate: trip.startDate || null,
      wakeTimes: trip.wake || null,
      places: trip.places.map(p => ({
        day: p.day, time: p.time, name: p.name, searchName: p.searchName, category: p.category,
        lat: p.lat, lng: p.lng, description: p.description, price: p.price, priceUnit: p.priceUnit, move: p.move
      }))
    };
    const scope = day
      ? [
          `이번 요청은 Day ${day}에만 적용합니다. places에는 Day ${day}의 장소만 넣어 출력하세요 (day 값은 모두 ${day}).`,
          "다른 날의 장소와 겹치지 않게 하고, 요청과 관계없는 Day 장소는 최대한 그대로 유지하세요."
        ]
      : [
          "요청을 반영해 수정된 전체 일정을 다시 출력하세요. 요청과 관계없는 부분은 최대한 그대로 유지하세요.",
          `현재 일수는 ${trip.days}일입니다. 요청이 일수 변경을 원하면 places의 day 값으로 반영하세요.`
        ];
    return [
      "당신은 한국인 여행자를 위한 전문 여행 플래너입니다. 아래는 현재 여행 일정(JSON)입니다.",
      JSON.stringify(slim),
      "",
      `사용자 요청: ${instruction}`,
      dietLine(),
      "",
      ...scope,
      OUTPUT_SPEC
    ].join("\n");
  }

  // "오후 2시~4시", "9:00-10:30" 등을 "HH:MM - HH:MM" 형식으로
  function normalizeTime(raw) {
    const s0 = String(raw || "").trim();
    if (!s0) return s0;
    const parts = s0.split(/\s*(?:-|~|–|—|부터|to)\s*/i).filter(Boolean).slice(0, 2);
    const out = [];
    let prevPM = false;
    for (const part of parts) {
      const nums = part.match(/\d{1,2}/g);
      if (!nums) return s0;
      let h = parseInt(nums[0], 10);
      const m = nums[1] ? parseInt(nums[1], 10) : 0;
      const pm = /오후|저녁|밤|pm/i.test(part);
      const am = /오전|새벽|아침|am/i.test(part);
      if (pm && h < 12) h += 12;
      else if (am && h === 12) h = 0;
      else if (!am && !pm && prevPM && h < 12) h += 12;
      if (h > 24 || m > 59) return s0;
      prevPM = pm || prevPM;
      out.push(`${String(h % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
    return out.join(" - ");
  }

  function extractJson(text) {
    let t = (text || "").trim();
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    try {
      return JSON.parse(t);
    } catch (e) {
      const start = t.indexOf("{");
      const end = t.lastIndexOf("}");
      if (start > -1 && end > start) {
        return JSON.parse(t.slice(start, end + 1));
      }
      throw new Error("AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.");
    }
  }

  // 스트리밍으로 받아 진행 상황을 알려 주고, 응답이 끊긴 시간 기준으로 타임아웃
  const T = window.__routyTimeouts || {};
  const IDLE_TIMEOUT_MS = T.idle || 60000;    // 60초 동안 아무것도 안 오면 중단
  const TOTAL_TIMEOUT_MS = T.total || 240000; // 최대 4분

  function geminiError(status, msg, model) {
    if (status === 400 && /api key/i.test(msg)) return new Error("API 키가 올바르지 않습니다. 설정에서 확인해 주세요.");
    if (status === 403) return new Error("API 키 권한이 없습니다. (키 제한 설정 확인)");
    if (status === 404) return new Error(`모델 "${model}"을 찾을 수 없습니다. 설정에서 모델명을 확인해 주세요.`);
    if (status === 429) return new Error("API 사용 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.");
    if (status === 503) return new Error("Gemini 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.");
    return new Error(`AI 오류 (${status}): ${msg}`);
  }

  // SSE("data: {...}") 또는 JSON(배열/객체) 응답에서 조각들을 꺼냄
  function parseChunks(raw) {
    const t = raw.trim();
    if (!t) return [];
    if (t.startsWith("data:") || t.includes("\ndata:")) {
      return t.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => {
        try { return JSON.parse(l.slice(5).trim()); } catch (e) { return null; }
      }).filter(Boolean);
    }
    try {
      const j = JSON.parse(t);
      return Array.isArray(j) ? j : [j];
    } catch (e) {
      return [];
    }
  }

  async function callGemini(prompt, { signal, onProgress } = {}) {
    const { apiKey, model } = getSettings();
    if (!apiKey) throw new Error("설정에서 Gemini API 키를 먼저 등록해 주세요.");

    const ctrl = new AbortController();
    let timedOut = false;
    const abortFromOuter = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", abortFromOuter);
    }
    let idleTimer = null;
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, IDLE_TIMEOUT_MS);
    };
    const totalTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TOTAL_TIMEOUT_MS);

    const send = (withThinking) => fetch(`${API_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: Object.assign(
          { responseMimeType: "application/json" },
          withThinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}
        )
      }),
      signal: ctrl.signal
    });

    try {
      bumpIdle();
      if (onProgress) onProgress({ phase: "waiting" });
      let res = await send(true);
      if (!res.ok) {
        let data = await res.json().catch(() => ({}));
        let msg = (data.error && data.error.message) || res.statusText;
        // 생각 수준 설정을 지원하지 않는 모델이면 설정 없이 다시 시도
        if (res.status === 400 && /thinking/i.test(msg)) {
          res = await send(false);
          if (!res.ok) {
            data = await res.json().catch(() => ({}));
            msg = (data.error && data.error.message) || res.statusText;
            throw geminiError(res.status, msg, model);
          }
        } else {
          throw geminiError(res.status, msg, model);
        }
      }

      let text = "";
      let finish = "";
      let block = "";
      let buffer = "";
      const handleChunk = (chunk) => {
        const cand = chunk.candidates && chunk.candidates[0];
        if (cand && cand.finishReason) finish = cand.finishReason;
        if (chunk.promptFeedback && chunk.promptFeedback.blockReason) block = chunk.promptFeedback.blockReason;
        const parts = (cand && cand.content && cand.content.parts) || [];
        parts.forEach(p => {
          if (typeof p.text !== "string") return;
          if (p.thought) {
            if (onProgress) onProgress({ phase: "thinking" });
          } else {
            text += p.text;
          }
        });
        if (onProgress && text) {
          const places = (text.match(/"name"\s*:/g) || []).length;
          onProgress({ phase: "writing", places, chars: text.length });
        }
      };

      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bumpIdle();
          buffer += decoder.decode(value, { stream: true });
          // SSE는 빈 줄로 이벤트가 구분됨
          let idx;
          while ((idx = buffer.search(/\r?\n\r?\n/)) > -1) {
            const evt = buffer.slice(0, idx);
            buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
            parseChunks(evt).forEach(handleChunk);
          }
        }
        parseChunks(buffer).forEach(handleChunk);
      } else {
        parseChunks(await res.text()).forEach(handleChunk);
      }

      if (!text) {
        throw new Error(`AI가 일정을 만들지 못했습니다 (${block || finish || "빈 응답"}).`);
      }
      if (finish === "MAX_TOKENS") {
        throw new Error("일정이 너무 길어 중간에 끊겼어요. 기간을 줄이거나 다시 시도해 주세요.");
      }
      return extractJson(text);
    } catch (e) {
      if (e.name === "AbortError") {
        if (signal && signal.aborted && !timedOut) throw e; // 사용자가 취소
        throw new Error("AI 응답이 너무 오래 걸려 중단했어요. 다시 시도하거나 설정에서 더 빠른 모델로 바꿔 보세요.");
      }
      if (e instanceof TypeError) throw new Error("네트워크 오류로 AI에 연결하지 못했습니다.");
      throw e;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      if (signal) signal.removeEventListener("abort", abortFromOuter);
    }
  }

  // 식당 후보: 이름·좌표가 있는 것만, 최대 3곳
  function normalizeAlternatives(list) {
    if (!Array.isArray(list)) return undefined;
    const out = list
      .filter(a => a && a.name)
      .map(a => {
        const lat = parseFloat(a.lat), lng = parseFloat(a.lng);
        const price = parseInt(a.price, 10);
        const ok = isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
        return {
          name: String(a.name).trim(),
          searchName: a.searchName ? String(a.searchName).trim() : "",
          lat: ok ? lat : null,
          lng: ok ? lng : null,
          description: a.description ? String(a.description).trim() : "",
          price: isFinite(price) && price >= 0 ? price : undefined
        };
      })
      .filter(a => a.lat !== null)
      .slice(0, 5);
    return out.length ? out : undefined;
  }

  // 특정 식사 자리에 대한 식당 후보 추천 (기존 일정용)

  // ---------- Google Places: 주변 식당 별점·리뷰수 ----------
  // 별점/리뷰수는 Google 약관상 저장하면 안 되므로 호출 결과는 메모리에서만 쓴다.
  function hasPlacesKey() {
    return !!getSettings().placesKey;
  }

  // 식당 정보 줄(별점·영업 중)은 한도 끝 25회를 남겨 둔다 → 끼니 1위 식당 고르기가 항상 먼저
  const DETAILS_RESERVE = 25;
  function localDay() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function placesUsage() {
    const today = localDay();
    try {
      const u = JSON.parse(localStorage.getItem(PLACES_USAGE_KEY) || "{}");
      return u.date === today ? { date: today, n: u.n || 0 } : { date: today, n: 0 };
    } catch (e) {
      return { date: today, n: 0 };
    }
  }

  function countPlacesCall() {
    const u = placesUsage();
    u.n += 1;
    try { localStorage.setItem(PLACES_USAGE_KEY, JSON.stringify(u)); } catch (e) {}
  }

  async function placesNearby(lat, lng, opts = {}) {
    return placesRequest("searchNearby", {
      includedTypes: [opts.type === "cafe" ? "cafe" : "restaurant"],
      maxResultCount: 20,
      rankPreference: "POPULARITY",
      languageCode: "ko",
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius: opts.radius || 1000 }
      }
    }, lat, lng, opts);
  }

  // 음식 종류(예: 가이세키, 돼지국밥)로 주변 검색 — 그 종류 안에서 1위를 고르기 위해
  async function placesText(query, lat, lng, opts = {}) {
    return placesRequest("searchText", {
      textQuery: query,
      includedType: opts.includedType === null ? undefined : (opts.includedType || (opts.type === "cafe" ? "cafe" : "restaurant")),
      pageSize: 20,
      languageCode: "ko",
      locationBias: {
        circle: { center: { latitude: lat, longitude: lng }, radius: opts.radius || 2000 }
      }
    }, lat, lng, opts);
  }

  async function placesRequest(endpoint, body, lat, lng, opts = {}) {
    const key = getSettings().placesKey;
    if (!key) throw new Error("설정에서 Google Places 키를 넣어야 쓸 수 있어요.");
    if (typeof lat !== "number" || typeof lng !== "number") throw new Error("이 장소는 위치 정보가 없어 주변을 찾을 수 없어요.");
    if (placesUsage().n >= PLACES_DAILY_LIMIT) {
      throw new Error(`오늘 조회 한도(${PLACES_DAILY_LIMIT}회)를 다 썼어요. 내일 다시 쓸 수 있어요.`);
    }
    countPlacesCall();
    let res;
    try {
      res = await fetch(`https://places.googleapis.com/v1/places:${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": PLACE_FIELDS.map(f => "places." + f).join(",")
        },
        body: JSON.stringify(body),
        signal: opts.signal
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error("Google Places에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
    }
    if (!res.ok) {
      let msg = "";
      try { msg = ((await res.json()).error || {}).message || ""; } catch (e) {}
      if (res.status === 403) throw new Error("Google Places 키가 거부됐어요. 키의 웹사이트 제한과 'Places API (New)' 사용 설정을 확인해 주세요.");
      if (res.status === 429) throw new Error("Google Places 하루 할당량을 다 썼어요. 내일 다시 시도해 주세요.");
      throw new Error(`Google Places 오류 (${res.status})${msg ? ": " + msg : ""}`);
    }
    const data = await res.json();
    return (data.places || [])
      .filter(p => !p.businessStatus || p.businessStatus === "OPERATIONAL")
      .map(mapPlace)
      .filter(p => p.name && typeof p.lat === "number");
  }

  const PLACE_FIELDS = ["id", "displayName", "location", "rating", "userRatingCount", "primaryTypeDisplayName",
    "googleMapsUri", "businessStatus", "priceLevel", "shortFormattedAddress", "editorialSummary", "regularOpeningHours"];

  function mapPlace(p) {
    const hours = p.regularOpeningHours || null;
    return {
      id: p.id,
      name: (p.displayName && p.displayName.text) || "",
      lat: p.location && p.location.latitude,
      lng: p.location && p.location.longitude,
      rating: typeof p.rating === "number" ? p.rating : 0,
      count: p.userRatingCount || 0,
      typeLabel: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || "",
      mapsUri: p.googleMapsUri || "",
      priceLevel: p.priceLevel || "",
      address: p.shortFormattedAddress || "",
      summary: (p.editorialSummary && p.editorialSummary.text) || "",
      periods: hours && hours.periods ? hours.periods : null,
      closed: p.businessStatus && p.businessStatus !== "OPERATIONAL" ? p.businessStatus : ""
    };
  }

  // 고른 식당의 정보 (별점·영업시간 등) — 저장하지 않고 화면에 보여 줄 때만 받아 온다
  async function placeDetails(id, opts = {}) {
    const key = getSettings().placesKey;
    if (!key) throw new Error("Google Places 키가 없어요.");
    if (placesUsage().n >= PLACES_DAILY_LIMIT - DETAILS_RESERVE) throw new Error("오늘 정보 조회는 여기까지예요(식당 고르기용으로 남겨 둠).");
    countPlacesCall();
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=ko`, {
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": PLACE_FIELDS.join(",") },
      signal: opts.signal
    });
    if (!res.ok) throw new Error(`Google Places 오류 (${res.status})`);
    return mapPlace(await res.json());
  }

  // --- '골라서 짜기': 여행지의 볼거리·맛집·카페 등 후보를 카테고리별로 추천 ---
  const SPOT_CATS = {
    sightseeing: { label: "관광지", n: 10 },
    restaurant: { label: "맛집", n: 8 },
    cafe: { label: "카페·디저트", n: 6 },
    shopping: { label: "쇼핑·체험", n: 6 },
    hotel: { label: "숙소 지역", n: 3 }
  };
  async function suggestSpots(input, opts = {}) {
    const only = opts.category && SPOT_CATS[opts.category] ? [opts.category] : Object.keys(SPOT_CATS);
    const counts = only.map(c => `${c} ${opts.category ? 8 : SPOT_CATS[c].n}곳`).join(", ");
    const styles = (input.styles || []).map(s => STYLE_LABELS[s] || s).join(", ") || "자유";
    const prompt = [
      "당신은 한국인 여행자를 위한 현지 여행 큐레이터입니다. 일정을 짜지 말고, 사용자가 직접 골라 담을 '후보 목록'만 추천합니다.",
      `여행지: ${input.destination}${input.days ? `, 기간 ${input.days}일` : ""}${input.startDate ? `, 출발일 ${input.startDate}` : ""}`,
      `일행: ${input.party || "자유"} ${input.people || 1}명, 여행 스타일: ${styles}, 소비 성향: ${BUDGET_LABELS[input.budget] || "보통"}`,
      input.request ? `요청: ${input.request}` : "",
      dietLine(),
      `카테고리별 개수: ${counts}.`,
      "- sightseeing: 꼭 볼 만한 명소·자연·전시·야경 등. 유명한 곳과 현지인이 좋아하는 곳을 섞기.",
      "- restaurant: 실제 개별 식당 이름(지역명·○○골목 금지). cuisine(음식 종류)과 meal(lunch|dinner|any) 필수.",
      "- cafe: 실제 카페·디저트 가게. shopping: 시장·쇼핑 거리·체험 프로그램. hotel: 숙소를 잡기 좋은 '지역'(name은 지역 이름, 예: 해운대 해변 인근)과 그 이유.",
      "- 출발일의 계절·날씨에 맞는 곳을 우선하고, 휴업 중이거나 사라진 곳은 제외. 실제 존재하는 곳만.",
      opts.exclude && opts.exclude.length ? `이미 추천한 곳(제외): ${opts.exclude.slice(0, 60).join(", ")}` : "",
      '반드시 JSON 하나만 출력: {"spots":[{"category":"sightseeing","name":"한국어 이름","searchName":"현지어/영어 이름","area":"동네·지역","lat":0,"lng":0,"description":"왜 좋은지 한 문장","duration":90,"bestTime":"오전|오후|저녁|아무때나","price":0,"tags":["야경","실내"],"cuisine":"","meal":"any"}]}',
      "duration은 머무는 분, price는 1인 원화 정수(무료면 0), lat/lng는 실제 좌표(소수점 4자리 이상), tags는 2개 이하."
    ].filter(Boolean).join("\n");
    const raw = await callGemini(prompt, opts);
    const list = (Array.isArray(raw.spots) ? raw.spots : Array.isArray(raw) ? raw : [])
      .map(p => normalizeSpot(p))
      .filter(Boolean)
      .filter(p => only.includes(p.category));
    if (!list.length) throw new Error("후보를 찾지 못했어요. 잠시 후 다시 시도해 주세요.");
    return list;
  }

  function normalizeSpot(p) {
    if (!p || !p.name) return null;
    const lat = parseFloat(p.lat), lng = parseFloat(p.lng);
    const cat = SPOT_CATS[p.category] ? p.category : (p.category === "activity" ? "shopping" : "sightseeing");
    const dur = parseInt(p.duration, 10), price = parseInt(p.price, 10);
    return {
      category: cat,
      name: String(p.name).trim().slice(0, 40),
      searchName: p.searchName ? String(p.searchName).trim().slice(0, 60) : "",
      area: p.area ? String(p.area).trim().slice(0, 30) : "",
      lat: isFinite(lat) && Math.abs(lat) <= 90 && lat !== 0 ? lat : null,
      lng: isFinite(lng) && Math.abs(lng) <= 180 && lng !== 0 ? lng : null,
      description: p.description ? String(p.description).trim().slice(0, 120) : "",
      duration: isFinite(dur) && dur > 0 ? Math.min(dur, 300) : ({ restaurant: 60, cafe: 50, shopping: 70, hotel: 0 }[cat] || 90),
      bestTime: ["오전", "오후", "저녁", "아무때나"].includes(p.bestTime) ? p.bestTime : "아무때나",
      price: isFinite(price) && price >= 0 ? price : undefined,
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 2).map(t => String(t).slice(0, 10)) : [],
      cuisine: p.cuisine ? String(p.cuisine).trim().slice(0, 20) : "",
      meal: ["lunch", "dinner", "any"].includes(p.meal) ? p.meal : "any"
    };
  }

  async function suggestRestaurants(trip, place, opts = {}) {
    const dayPlaces = trip.places.filter(p => p.day === place.day).map(p => `${p.time} ${p.name}`).join(" / ");
    const prompt = [
      "당신은 한국인 여행자를 위한 맛집 큐레이터입니다.",
      `여행지: ${trip.destination}, 인원: ${trip.people || 1}명, 소비 성향: ${BUDGET_LABELS[trip.budget] || "보통"}`,
      `그날 일정: ${dayPlaces}`,
      `대상 식사: ${place.time} "${place.name}" (위치 lat ${place.lat}, lng ${place.lng})`,
      "이 식사 시간에 이 위치에서 도보·짧은 이동으로 갈 수 있는 실제 개별 식당 5곳을 추천하세요.",
      "현지에서 평판이 좋고 리뷰가 많은 유명한 곳을 우선하고, 인기 높은 순서대로 정렬하세요. 별점·리뷰 수 숫자는 쓰지 마세요.",
      `"${place.name}" 자체와 지역명(○○거리, 먹자골목)은 제외하고, 메뉴 종류나 가격대가 너무 겹치지 않게.`,
      dietLine(),
      '반드시 JSON 하나만 출력: {"alternatives":[{"name":"한국어 이름","searchName":"현지어/영어 이름","lat":0,"lng":0,"description":"대표 메뉴·특징 한 문장","price":12000}]}',
      "price는 1인 기준 원화 정수, lat/lng는 실제 좌표(소수점 4자리 이상)."
    ].filter(Boolean).join("\n");
    const raw = await callGemini(prompt, opts);
    const list = normalizeAlternatives(raw.alternatives || raw);
    if (!list) throw new Error("식당 후보를 찾지 못했어요. 잠시 후 다시 시도해 주세요.");
    return list;
  }

  function normalizeMove(m) {
    if (!m || typeof m !== "object") return undefined;
    const mode = MOVE_MODES.includes(m.mode) ? m.mode : null;
    const minutes = parseInt(m.minutes, 10);
    if (!mode && !isFinite(minutes)) return undefined;
    const cost = parseInt(m.cost, 10);
    return {
      mode: mode || "walk",
      minutes: isFinite(minutes) && minutes >= 0 ? minutes : undefined,
      cost: isFinite(cost) && cost >= 0 ? cost : undefined,
      note: m.note ? String(m.note).trim().slice(0, 80) : "",
      from: m.from ? String(m.from).trim().slice(0, 30) : undefined,
      to: m.to ? String(m.to).trim().slice(0, 30) : undefined,
      service: m.service ? String(m.service).trim().slice(0, 20) : undefined
    };
  }

  function normalizePlan(raw, days, fallbackCenter) {
    const places = Array.isArray(raw.places) ? raw.places : [];
    const center = fallbackCenter || { lat: 37.5665, lng: 126.978 };
    const stamp = Date.now();
    const out = places
      .filter(p => p && p.name)
      .map((p, i) => {
        let day = parseInt(p.day, 10);
        if (!day || day < 1) day = 1;
        if (day > days) day = days;
        const lat = parseFloat(p.lat);
        const lng = parseFloat(p.lng);
        const validCoord = isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
        const price = parseInt(p.price, 10);
        return {
          day,
          id: `ai-${stamp}-${i}`,
          name: String(p.name).trim(),
          time: normalizeTime(p.time) || "시간 미정",
          searchName: p.searchName ? String(p.searchName).trim() : "",
          lat: validCoord ? lat : center.lat,
          lng: validCoord ? lng : center.lng,
          coordMissing: !validCoord,
          category: CATEGORIES.includes(p.category) ? p.category : "sightseeing",
          description: String(p.description || "").trim(),
          price: isFinite(price) && price >= 0 ? price : undefined,
          priceUnit: p.priceUnit === "group" ? "group" : p.priceUnit === "person" ? "person" : (p.category === "hotel" ? "group" : "person"),
          move: normalizeMove(p.move),
          alternatives: ["restaurant", "cafe"].includes(p.category) ? normalizeAlternatives(p.alternatives) : undefined,
          cuisine: ["restaurant", "cafe"].includes(p.category) && p.cuisine ? String(p.cuisine).trim().slice(0, 20) : undefined
        };
      });
    if (out.length === 0) throw new Error("AI가 장소를 하나도 만들지 못했습니다. 조건을 바꿔 다시 시도해 주세요.");
    return {
      title: raw.title ? String(raw.title).trim() : "",
      summary: raw.summary ? String(raw.summary).trim() : "",
      tips: Array.isArray(raw.tips) ? raw.tips.map(String).filter(Boolean).slice(0, 8) : [],
      places: out
    };
  }

  async function generateTrip(input, opts) {
    const raw = await callGemini(buildCreatePrompt(input), opts);
    return normalizePlan(raw, input.days);
  }

  async function refineTrip(trip, instruction, opts = {}) {
    const raw = await callGemini(buildRefinePrompt(trip, instruction, opts.day), opts);
    const center = trip.places[0] ? { lat: trip.places[0].lat, lng: trip.places[0].lng } : null;
    // 전체 수정 시 AI가 일수를 늘릴 수 있도록 넉넉히 허용
    return normalizePlan(raw, opts.day ? trip.days : Math.max(trip.days, 14), center);
  }

  async function testApiKey() {
    const raw = await callGemini('{"ok": true} 라는 JSON만 그대로 출력하세요.');
    return !!raw;
  }

  // ---------- 장소 검색 (OpenStreetMap Nominatim) ----------
  async function searchPlaces(query, near, opts = {}) {
    const params = new URLSearchParams({
      format: "jsonv2",
      q: query,
      limit: String(opts.limit || 6),
      "accept-language": "ko,en"
    });
    if (near) {
      const d = 0.6;
      params.set("viewbox", `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
      if (opts.bounded) params.set("bounded", "1");
    }
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("장소 검색에 실패했습니다.");
    const list = await res.json();
    return list.map(r => ({
      name: r.name || (r.display_name || "").split(",")[0],
      address: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon)
    }));
  }

  // ---------- 공유 링크 ----------
  function bytesToB64url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlToBytes(str) {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function streamBytes(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }

  async function encodeTrip(trip) {
    const slim = {
      t: trip.title, d: trip.destination, n: trip.days, b: trip.budget, s: trip.startDate || "", c: trip.people || 1, m: trip.transport || "auto", bp: trip.budgetPlan || 0,
      p: trip.places.map(p => [p.day, p.time, p.name, p.category, +(+p.lat).toFixed(5), +(+p.lng).toFixed(5), p.description || "", p.price || 0, p.priceUnit === "group" ? 1 : 0, p.move ? [p.move.mode, p.move.minutes || 0, p.move.note || "", p.move.cost === undefined ? -1 : p.move.cost].concat(p.move.from || p.move.to || p.move.service ? [p.move.from || "", p.move.to || "", p.move.service || ""] : []) : 0,
        p.alternatives ? p.alternatives.map(a => [a.name, +(+a.lat).toFixed(5), +(+a.lng).toFixed(5), a.description || "", a.price || 0, a.searchName || ""]) : 0])
    };
    const bytes = new TextEncoder().encode(JSON.stringify(slim));
    if (typeof CompressionStream !== "undefined") {
      return "z" + bytesToB64url(await streamBytes(bytes, new CompressionStream("deflate-raw")));
    }
    return "j" + bytesToB64url(bytes);
  }

  async function decodeTrip(code) {
    const kind = code[0];
    let bytes = b64urlToBytes(code.slice(1));
    if (kind === "z") bytes = await streamBytes(bytes, new DecompressionStream("deflate-raw"));
    const o = JSON.parse(new TextDecoder().decode(bytes));
    const stamp = Date.now();
    return {
      id: `shared-${stamp}`,
      title: o.t, destination: o.d, days: o.n, budget: o.b || "medium", startDate: o.s || "", people: o.c || 1, transport: o.m || "auto", budgetPlan: o.bp || undefined,
      places: o.p.map((a, i) => ({
        day: a[0], time: a[1], name: a[2], category: CATEGORIES.includes(a[3]) ? a[3] : "sightseeing",
        lat: a[4], lng: a[5], description: a[6], price: a[7], priceUnit: a[8] ? "group" : (a[8] === 0 ? "person" : undefined),
        alternatives: Array.isArray(a[10]) ? normalizeAlternatives(a[10].map(x => ({ name: x[0], lat: x[1], lng: x[2], description: x[3], price: x[4], searchName: x[5] }))) : undefined,
        move: Array.isArray(a[9]) ? normalizeMove({ mode: a[9][0], minutes: a[9][1], note: a[9][2], cost: a[9][3] >= 0 ? a[9][3] : undefined, from: a[9][4], to: a[9][5], service: a[9][6] }) : undefined,
        id: `sh-${stamp}-${i}`
      }))
    };
  }

  window.RoutyAI = {
    DEFAULT_MODEL,
    getSettings, saveSettings, hasApiKey,
    generateTrip, refineTrip, testApiKey,
    searchPlaces, encodeTrip, decodeTrip, normalizeTime, normalizeMove, MOVE_MODES, suggestRestaurants, suggestSpots, SPOT_CATS,
    hasPlacesKey, placesNearby, placesText, placeDetails, placesUsage, PLACES_DAILY_LIMIT
  };
})();
