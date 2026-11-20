// 어디가 마스코트 '구름이' — 분홍 볼에 지도 핀 모자를 쓴 작은 구름 (오리지널 캐릭터)
// mascotSvg(mood, size): mood = happy | wink | think | sleep | wow
(function () {
  const INK = "#3A3046";
  const CHEEK = "#FFB4C2";
  const LINE = "#B9E3EF";

  function eyes(mood) {
    if (mood === "sleep") {
      return `<path d="M44 58 q5 4 10 0" class="mc-ink" stroke-width="3" fill="none" stroke-linecap="round"/>
              <path d="M66 58 q5 4 10 0" class="mc-ink" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    }
    if (mood === "think") {
      return `<path d="M44 58 h10" class="mc-ink" stroke-width="3" stroke-linecap="round"/>
              <path d="M66 58 h10" class="mc-ink" stroke-width="3" stroke-linecap="round"/>`;
    }
    const left = `<ellipse cx="49" cy="57" rx="4" ry="5" fill="${INK}"/><circle cx="50.4" cy="55.2" r="1.5" fill="#fff"/>`;
    const right = mood === "wink"
      ? `<path d="M66 58 q5 -5 10 0" class="mc-ink" stroke-width="3" fill="none" stroke-linecap="round"/>`
      : `<ellipse cx="71" cy="57" rx="4" ry="5" fill="${INK}"/><circle cx="72.4" cy="55.2" r="1.5" fill="#fff"/>`;
    return left + right;
  }

  function mouth(mood) {
    if (mood === "wow") return `<ellipse cx="60" cy="68" rx="3.6" ry="4.2" fill="${INK}"/>`;
    if (mood === "sleep") return `<path d="M56 68 q4 2 8 0" class="mc-ink" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    if (mood === "think") return `<path d="M56 69 h8" class="mc-ink" stroke-width="2.5" stroke-linecap="round"/>`;
    return `<path d="M54.5 66 q5.5 6 11 0" class="mc-ink" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
  }

  function extra(mood) {
    if (mood === "sleep") {
      return `<text x="94" y="30" class="mc-z" font-size="14" font-weight="900">z</text>
              <text x="103" y="20" class="mc-z" font-size="10" font-weight="900">z</text>`;
    }
    if (mood === "think") {
      return `<circle cx="96" cy="34" r="3" class="mc-dot d1"/><circle cx="105" cy="26" r="3.6" class="mc-dot d2"/><circle cx="114" cy="17" r="4.2" class="mc-dot d3"/>`;
    }
    return "";
  }

  // 구름 몸통: 바깥선 레이어 + 흰 채움 레이어를 겹쳐 하나의 말랑한 구름으로
  const BLOBS = [[40, 58, 22], [60, 44, 25], [82, 58, 21], [60, 64, 26]];
  function body() {
    const outline = BLOBS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r + 3}" fill="${LINE}"/>`).join("");
    const fill = BLOBS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" class="mc-body"/>`).join("");
    return outline + fill;
  }

  window.mascotSvg = function (mood = "happy", size = 72) {
    const wave = mood === "happy" || mood === "wink";
    return `<svg class="mascot mc-${mood}" width="${size}" height="${Math.round(size * 0.86)}" viewBox="0 0 120 103" aria-hidden="true">
      <ellipse cx="60" cy="98" rx="30" ry="4" class="mc-shadow"/>
      <g class="mc-float">
        ${body()}
        ${wave ? `<g class="mc-arm"><ellipse cx="13" cy="52" rx="7.5" ry="6" fill="${LINE}" transform="rotate(-30 13 52)"/><ellipse cx="13" cy="52" rx="5.2" ry="3.9" class="mc-body" transform="rotate(-30 13 52)"/></g>` : ""}
        <g class="mc-pin">
          <path d="M60 4 a10 10 0 0 1 10 10 c0 7 -10 16 -10 16 s-10 -9 -10 -16 a10 10 0 0 1 10 -10z" fill="#FF8FA3" stroke="#fff" stroke-width="2"/>
          <circle cx="60" cy="14" r="3.6" fill="#fff"/>
        </g>
        <ellipse cx="41" cy="66" rx="6" ry="3.6" fill="${CHEEK}" opacity="0.85"/>
        <ellipse cx="79" cy="66" rx="6" ry="3.6" fill="${CHEEK}" opacity="0.85"/>
        ${eyes(mood)}
        ${mouth(mood)}
      </g>
      ${extra(mood)}
    </svg>`;
  };

  // 말풍선과 함께: <div class="mascot-say">구름이 + 말풍선</div>
  window.mascotSay = function (text, mood = "happy", size = 64) {
    return `<div class="mascot-say"><button type="button" class="mascot-btn" aria-label="구름이">${window.mascotSvg(mood, size)}</button><div class="mascot-bubble">${text}</div></div>`;
  };
})();
