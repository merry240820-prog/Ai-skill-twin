/* 사주팔자 계산 모듈
 * - 연주: 입춘(태양황경 315°) 기준으로 해가 바뀜
 * - 월주: 12절기(태양황경 315°부터 30°씩) 기준, 오호둔(五虎遁)으로 월간 산출
 * - 일주: 율리우스 적일(JDN) 기준 60갑자, (JDN + 49) % 60
 * - 시주: 2시간 단위 지지, 오서둔(五鼠遁)으로 시간 산출. 23시 이후는 다음날 일주(조자시 통합)
 * - 진태양시 보정: 한국 표준시(동경 135°)와 서울(약 127°) 차이 약 -30분 (옵션)
 * 태양황경은 저정밀 천문식(오차 약 0.01°, 시간으로 15분 안팎)을 쓴다.
 * 절기 경계 몇 시간 안에 태어났다면 만세력으로 확인 후 '직접 입력'을 쓰는 것이 안전하다.
 */
(function (global) {
  const STEMS = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계'];
  const STEMS_H = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  const BRANCHES = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해'];
  const BRANCHES_H = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  const ANIMALS = ['쥐', '소', '호랑이', '토끼', '용', '뱀', '말', '양', '원숭이', '닭', '개', '돼지'];
  const STEM_EL = ['목', '목', '화', '화', '토', '토', '금', '금', '수', '수'];
  const BRANCH_EL = ['수', '토', '목', '목', '토', '화', '화', '토', '금', '금', '토', '수'];
  const ELEMENTS = ['목', '화', '토', '금', '수'];
  const EL_HANJA = { 목: '木', 화: '火', 토: '土', 금: '金', 수: '水' };

  const mod = (n, m) => ((n % m) + m) % m;

  function jdn(y, m, d) {
    const a = Math.floor((14 - m) / 12);
    const yy = y + 4800 - a;
    const mm = m + 12 * a - 3;
    return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
  }

  // 태양 겉보기 황경 (도). date: JS Date (UTC 기준 시각)
  function sunLongitude(date) {
    const jd = date.getTime() / 86400000 + 2440587.5;
    const T = (jd - 2451545.0) / 36525;
    const rad = Math.PI / 180;
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * rad)
      + (0.019993 - 0.000101 * T) * Math.sin(2 * M * rad)
      + 0.000289 * Math.sin(3 * M * rad);
    const omega = 125.04 - 1934.136 * T;
    const lon = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad);
    return mod(lon, 360);
  }

  /**
   * @param {string} dateStr 'YYYY-MM-DD' (양력, 한국 시간)
   * @param {string|null} timeStr 'HH:MM' 또는 null(모름)
   * @param {boolean} correct 진태양시(-30분) 보정 여부
   */
  function calc(dateStr, timeStr, correct) {
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return null;
    const hasTime = !!timeStr;
    const [hh, mi] = hasTime ? timeStr.split(':').map(Number) : [12, 0];

    // 절기·연도 판정은 실제 시각(UTC)으로
    const utc = new Date(Date.UTC(y, m - 1, d, hh - 9, mi));
    const lon = sunLongitude(utc);

    let sajuYear = y;
    if (m <= 2 && lon >= 240 && lon < 315) sajuYear = y - 1;
    const yIdx = mod(sajuYear - 4, 60);
    const yStem = mod(sajuYear - 4, 10);
    const yBranch = mod(sajuYear - 4, 12);

    const monthOffset = Math.floor(mod(lon - 315, 360) / 30); // 0 = 인월
    const mStem = mod((yStem % 5) * 2 + 2 + monthOffset, 10);
    const mBranch = mod(2 + monthOffset, 12);

    // 일주·시주는 (보정한) 지방시로
    let local = new Date(Date.UTC(y, m - 1, d, hh, mi));
    if (hasTime && correct) local = new Date(local.getTime() - 30 * 60000);
    let ly = local.getUTCFullYear(), lm = local.getUTCMonth() + 1, ld = local.getUTCDate();
    const lh = local.getUTCHours();
    let dayJ = jdn(ly, lm, ld);
    if (hasTime && lh >= 23) dayJ += 1;
    const dIdx = mod(dayJ + 49, 60);
    const dStem = dIdx % 10, dBranch = dIdx % 12;

    let hour = null;
    if (hasTime) {
      const hBranch = Math.floor((lh + 1) / 2) % 12;
      const hStem = mod((dStem % 5) * 2 + hBranch, 10);
      hour = { s: hStem, b: hBranch };
    }

    return build({
      year: { s: yStem, b: yBranch },
      month: { s: mStem, b: mBranch },
      day: { s: dStem, b: dBranch },
      hour
    }, { sunLon: lon, sajuYear, yIdx });
  }

  function build(p, meta) {
    const pillars = ['hour', 'day', 'month', 'year'].map(k => {
      const v = p[k];
      if (!v) return { key: k, empty: true };
      return {
        key: k,
        s: v.s, b: v.b,
        stem: STEMS[v.s], stemH: STEMS_H[v.s], stemEl: STEM_EL[v.s], stemYang: v.s % 2 === 0,
        branch: BRANCHES[v.b], branchH: BRANCHES_H[v.b], branchEl: BRANCH_EL[v.b], branchYang: v.b % 2 === 0
      };
    });
    const count = { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 };
    pillars.forEach(x => { if (!x.empty) { count[x.stemEl]++; count[x.branchEl]++; } });
    const dm = p.day.s;
    return {
      pillars,
      raw: p,
      count,
      dayMaster: dm,
      dayMasterName: STEMS[dm] + STEM_EL[dm],
      dayMasterEl: STEM_EL[dm],
      animal: ANIMALS[p.year.b],
      meta: meta || {}
    };
  }

  // 직접 입력: {year:{s,b}, month:{s,b}, day:{s,b}, hour:{s,b}|null}
  function fromManual(p) {
    return build(p, { manual: true });
  }

  const GEN = { 목: '화', 화: '토', 토: '금', 금: '수', 수: '목' };   // 생(生)
  const CTRL = { 목: '토', 토: '수', 수: '화', 화: '금', 금: '목' };  // 극(剋)
  const HAP = [[0, 1], [2, 11], [3, 10], [4, 9], [5, 8], [6, 7]];
  const CHUNG = [[0, 6], [1, 7], [2, 8], [3, 9], [4, 10], [5, 11]];
  const pairIn = (list, a, b) => list.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

  function relation(elA, elB) {
    if (elA === elB) return 'same';
    if (GEN[elA] === elB) return 'aGenB';
    if (GEN[elB] === elA) return 'bGenA';
    if (CTRL[elA] === elB) return 'aCtrlB';
    return 'bCtrlA';
  }

  function branchRelation(a, b) {
    if (a === b) return 'same';
    if (pairIn(HAP, a, b)) return 'hap';
    if (pairIn(CHUNG, a, b)) return 'chung';
    return 'none';
  }

  global.Saju = {
    STEMS, STEMS_H, BRANCHES, BRANCHES_H, ANIMALS, STEM_EL, BRANCH_EL, ELEMENTS, EL_HANJA, GEN, CTRL,
    calc, fromManual, relation, branchRelation, sunLongitude, jdn
  };
})(typeof window !== 'undefined' ? window : globalThis);
