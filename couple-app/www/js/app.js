/* 개굴씨 부부연구소 — 메인 앱 */
(function () {
  'use strict';
  const D = window.DATA, S = window.Saju;
  const KEY = 'gaegul.v1';
  const P = ['h', 'w'];
  const DAY_MS = 86400000;

  // ───────────────────────── 저장소
  function blank() {
    return {
      v: 1,
      me: null,
      theme: 'auto',
      startDate: null,
      profiles: {
        h: { name: '남편', birth: { date: '', time: '', unknown: false, correct: true }, manual: null, useManual: false, ts: 0 },
        w: { name: '아내', birth: { date: '', time: '', unknown: false, correct: true }, manual: null, useManual: false, ts: 0 }
      },
      days: {},
      daily: {},
      ll: { h: null, w: null },
      pledge: { h: null, w: null, custom: [] },
      money: { rules: { limit: 30, wait: 24, allowH: 20, allowW: 20, goal: '', ts: 0 }, log: [] },
      messages: [],
      timeouts: []
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      const s = JSON.parse(raw);
      const b = blank();
      return Object.assign(b, s, {
        profiles: { h: Object.assign(b.profiles.h, s.profiles && s.profiles.h), w: Object.assign(b.profiles.w, s.profiles && s.profiles.w) },
        pledge: Object.assign(b.pledge, s.pledge),
        money: { rules: Object.assign(b.money.rules, s.money && s.money.rules), log: (s.money && s.money.log) || [] },
        ll: Object.assign(b.ll, s.ll)
      });
    } catch (e) { return blank(); }
  }
  let st = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { toast('저장 공간에 문제가 있어요. 백업을 만들어 두세요.'); } }

  // ───────────────────────── 유틸
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const uid = () => now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const name = (p) => st.profiles[p].name || (p === 'h' ? '남편' : '아내');
  const other = (p) => (p === 'h' ? 'w' : 'h');
  const me = () => st.me || 'h';
  const fmtTime = (sec) => `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
  const fmtDate = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2200);
  }
  let audioCtx = null;
  function beep(times = 2) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 660; o.connect(g); g.connect(audioCtx.destination);
        const t0 = audioCtx.currentTime + i * 0.35;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
        o.start(t0); o.stop(t0 + 0.3);
      }
    } catch (e) { /* 소리 없이 진행 */ }
    if (navigator.vibrate) navigator.vibrate([200, 120, 200]);
  }

  function currentDay() {
    if (!st.startDate) return 1;
    const diff = Math.floor((parseYmd(ymd()) - parseYmd(st.startDate)) / DAY_MS);
    return Math.max(1, Math.min(30, diff + 1));
  }
  function dayRec(n, p) {
    st.days[n] = st.days[n] || {};
    st.days[n][p] = st.days[n][p] || { done: false, notes: {}, before: null, after: null, ts: 0 };
    return st.days[n][p];
  }
  const isDone = (n, p) => !!(st.days[n] && st.days[n][p] && st.days[n][p].done);
  function dailyRec(date, p) {
    st.daily[date] = st.daily[date] || {};
    st.daily[date][p] = st.daily[date][p] || { ts: 0 };
    return st.daily[date][p];
  }
  function streak(p) {
    // 지킴이 항목을 4개 이상 지킨 날이 오늘(또는 어제)부터 연속 며칠인지
    let n = 0; const d = new Date();
    const ok = (date) => { const r = st.daily[date] && st.daily[date][p]; return r && D.DAILY.filter(x => r[x.id]).length >= 4; };
    if (!ok(ymd(d))) d.setDate(d.getDate() - 1);
    while (ok(ymd(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  // ───────────────────────── 시트(모달)
  function openSheet(html, onClose) {
    const sh = $('#sheet'), bg = $('#sheetBg');
    sh.innerHTML = `<button class="close" data-act="closeSheet" aria-label="닫기">✕</button>${html}`;
    sh.hidden = false; bg.hidden = false; sh.scrollTop = 0;
    openSheet._onClose = onClose || null;
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBg').hidden = true; $('#sheet').innerHTML = '';
    if (openSheet._onClose) { const f = openSheet._onClose; openSheet._onClose = null; f(); }
  }

  // ───────────────────────── 라우팅
  let tab = 'home';
  let sub = {};          // 탭별 보조 상태
  function go(t, extra) {
    tab = t; if (extra) sub[t] = Object.assign(sub[t] || {}, extra);
    $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    render(); window.scrollTo(0, 0);
  }
  function render() {
    $('#brandFrog').innerHTML = frog('happy', 28);
    const p = me();
    $('#whoBtn').innerHTML = `<span class="dot ${p}"></span>${esc(name(p))} 사용 중 ▾`;
    const v = $('#view');
    v.innerHTML = ({ home: viewHome, program: viewProgram, saju: viewSaju, love: viewLove, tools: viewTools })[tab]();
    afterRender();
  }
  function afterRender() { if (session.day && tab === 'program' && sub.program && sub.program.day === session.day) paintSession(); }

  // ───────────────────────── 홈
  function viewHome() {
    const p = me(), o = other(p), n = currentDay(), day = D.DAYS[n - 1];
    const doneBoth = Object.keys(st.days).filter(k => isDone(k, 'h') && isDone(k, 'w')).length;
    const today = ymd();
    const r = dailyRec(today, p), ro = (st.daily[today] && st.daily[today][o]) || {};
    const kept = D.DAILY.filter(x => r[x.id]).length, keptO = D.DAILY.filter(x => ro[x.id]).length;
    const msgs = st.messages.slice(-6).reverse();
    const greet = kept >= 5 ? ['cheer', `와! 오늘 약속을 ${kept}개나 지켰네. 개굴씨가 박수 쳐줄게 👏`]
      : isDone(n, p) ? ['love', `오늘 과정 완료! ${esc(name(o))}에게 고마운 점 하나 말해 볼까?`]
        : ['happy', `안녕, ${esc(name(p))}! 오늘은 <b>Day ${n}</b> "${esc(day.t)}" 차례야. 둘이 30분, 같이 앉아 보자.`];
    return `
      <div class="speech card soft">${frog(greet[0], 72)}<div class="bubble">${greet[1]}</div></div>

      <div class="card">
        <div class="row"><span class="chip">${D.WEEKS[day.w - 1].n}주차 · ${esc(D.WEEKS[day.w - 1].t)}</span><span class="grow"></span>
          <span class="chip ${isDone(n, 'h') ? 'ok' : ''}"><span class="dot h"></span>${esc(name('h'))}</span>
          <span class="chip ${isDone(n, 'w') ? 'ok' : ''}"><span class="dot w"></span>${esc(name('w'))}</span></div>
        <h1>Day ${n}. ${esc(day.t)}</h1>
        <p class="muted small">오늘의 약속 · ${esc(day.promise)}</p>
        <button class="btn primary block" data-act="openDay" data-n="${n}">오늘 30분 과정 시작하기 →</button>
      </div>

      <div class="grid2">
        <div class="card stat"><b>${doneBoth}<small style="font-size:14px">/30</small></b><span>둘 다 완료한 날</span></div>
        <div class="card stat"><b>${streak(p)}일</b><span>${esc(name(p))} 약속 연속 지킴</span></div>
      </div>
      <div class="progress" aria-label="30일 진행률"><i style="width:${Math.round(doneBoth / 30 * 100)}%"></i></div>

      <h2>오늘의 지킴이 <span class="tiny">${esc(name(p))} · ${today}</span></h2>
      <div class="card">
        ${D.DAILY.map(x => `<label class="check"><input type="checkbox" data-daily="${x.id}" ${r[x.id] ? 'checked' : ''}><span>${esc(x.t)}</span></label>`).join('')}
        <p class="tiny" style="margin-top:8px">${esc(name(o))}는 오늘 ${keptO}/${D.DAILY.length}개 체크했어요. 자기 전에 각자 솔직하게 체크하세요. 상대 체크에 토 달기 금지!</p>
      </div>

      <h2>${esc(name(o))}에게 한마디</h2>
      <div class="card">
        <div class="row"><input type="text" id="msgIn" class="grow" placeholder="고마웠던 일, 응원, 사과…" maxlength="300"><button class="btn primary" data-act="sendMsg">남기기</button></div>
        <div style="margin-top:10px">${msgs.length ? msgs.map(m => `<div class="msg"><div class="meta"><span class="dot ${m.from}"></span> ${esc(name(m.from))} → ${esc(name(other(m.from)))} · ${fmtDate(m.at)}</div>${esc(m.text)}</div>`).join('') : '<p class="tiny">아직 남긴 말이 없어요. 오늘 고마웠던 점부터 시작해 볼까요?</p>'}</div>
      </div>

      <div class="card danger small">
        <b>안전이 먼저예요.</b> 다툼 중에 몸을 다치거나, 다칠 것 같은 위협을 느낀다면 이 앱으로 해결하려 하지 말고 바로 도움을 요청하세요.
        <div class="row" style="margin-top:8px">${D.SAFETY.slice(0, 2).map(s => `<a class="btn" href="tel:${s.n}">${s.n}</a>`).join('')}<button class="btn ghost" data-act="safety">더 보기</button></div>
      </div>`;
  }

  // ───────────────────────── 30일 과정
  function viewProgram() {
    const sp = sub.program || {};
    if (sp.day) return viewDay(sp.day);
    const cur = currentDay();
    return `
      <h1>30일 부부 프로그램</h1>
      <p class="muted">매일 30분 · 체크인 5분 → 배우기 7분 → 함께 연습 13분 → 마무리 5분</p>
      <div class="card soft small">시작일 ${st.startDate || '-'} · 오늘은 <b>Day ${cur}</b>. 하루를 놓쳐도 괜찮아요. 순서대로 이어서 하면 됩니다.</div>
      ${D.WEEKS.map(w => {
        const days = D.DAYS.map((d, i) => ({ d, n: i + 1 })).filter(x => x.d.w === w.n);
        return `<h2>${w.n}주차 · ${esc(w.t)}</h2><p class="tiny" style="margin-top:-6px">${esc(w.d)}</p>
          <div class="daygrid">${days.map(({ n }) => {
            const h = isDone(n, 'h'), wv = isDone(n, 'w');
            const cls = h && wv ? 'done' : (h || wv) ? 'half' : '';
            return `<button class="daycell ${cls} ${n === cur ? 'today' : ''}" data-act="openDay" data-n="${n}" aria-label="Day ${n}">${n}<small>${n === cur ? '오늘' : (h && wv ? '완료' : (h || wv) ? '한 명' : '')}</small></button>`;
          }).join('')}</div>`;
      }).join('')}
      <p class="tiny" style="margin-top:14px">초록: 둘 다 완료 · 노랑: 한 명만 완료</p>`;
  }

  // 세션 타이머 (메모리)
  const session = { day: null, idx: 0, left: 0, running: false, iv: null };
  function sessionSteps() { return D.STEP_FRAME; }
  function startSession(n) {
    if (session.day !== n) { session.day = n; session.idx = 0; session.left = D.STEP_FRAME[0].m * 60; }
    session.running = true; clearInterval(session.iv);
    session.iv = setInterval(tick, 1000); paintSession();
  }
  function pauseSession() { session.running = false; clearInterval(session.iv); paintSession(); }
  function nextStep() {
    if (session.idx < D.STEP_FRAME.length - 1) { session.idx++; session.left = D.STEP_FRAME[session.idx].m * 60; }
    else { session.left = 0; pauseSession(); toast('30분 과정 끝! 일지를 적고 완료를 눌러주세요.'); }
    paintSession();
  }
  function tick() {
    if (!session.running) return;
    session.left--;
    if (session.left <= 0) { beep(session.idx === D.STEP_FRAME.length - 1 ? 3 : 2); nextStep(); return; }
    paintSession();
  }
  function paintSession() {
    const box = $('#sessBox'); if (!box || !sub.program || sub.program.day !== session.day) return;
    const s = D.STEP_FRAME[session.idx];
    const total = D.STEP_FRAME.reduce((a, x) => a + x.m * 60, 0);
    const passed = D.STEP_FRAME.slice(0, session.idx).reduce((a, x) => a + x.m * 60, 0) + (s.m * 60 - session.left);
    $('#sessStep').textContent = `${session.idx + 1}/4 · ${s.t}`;
    $('#sessTime').textContent = fmtTime(Math.max(0, session.left));
    $('#sessBar').style.width = Math.min(100, passed / total * 100) + '%';
    $('#sessToggle').textContent = session.running ? '일시정지' : (passed > 0 ? '계속' : '시작');
    $$('.step').forEach((el, i) => { el.classList.toggle('cur', i === session.idx); el.classList.toggle('fin', i < session.idx); });
  }

  function viewDay(n) {
    const d = D.DAYS[n - 1], p = me(), o = other(p), r = dayRec(n, p), ro = (st.days[n] && st.days[n][o]) || null;
    const active = session.day === n;
    const stepBody = (k) => ({
      checkin: '', learn: `<div class="card soft small" style="margin:8px 0 0">${esc(d.learn)}</div>`,
      practice: `<div class="card small pre" style="margin:8px 0 0">${esc(d.ex)}</div>
        <div class="row small" style="margin-top:6px"><span class="tiny">말하기 타이머</span>${[1, 2, 3].map(m => `<button class="btn ghost" data-act="miniTimer" data-m="${m}">${m}분</button>`).join('')}</div>`,
      close: `<div class="card gold small" style="margin:8px 0 0"><b>오늘의 약속</b><br>${esc(d.promise)}</div>`
    })[k];
    const mood = (key, label) => `<label class="field"><span>${label}: <b id="v-${key}">${r[key] == null ? '-' : r[key]}</b>/10</span>
      <input type="range" min="0" max="10" value="${r[key] == null ? 5 : r[key]}" data-moodk="${key}" style="width:100%;accent-color:var(--accent)"></label>`;
    return `
      <button class="btn ghost" data-act="backProgram">← 30일 목록</button>
      <p class="tiny" style="margin:12px 0 0">${d.w}주차 · ${esc(D.WEEKS[d.w - 1].t)}</p>
      <h1>Day ${n}. ${esc(d.t)}</h1>
      <div class="speech" style="margin-bottom:12px">${frog(n === 30 ? 'cheer' : 'happy', 64)}<div class="bubble">${esc(d.frog)}</div></div>

      <div class="card" id="sessBox">
        <div class="row"><b id="sessStep">${active ? '' : '1/4 · 체크인'}</b><span class="grow"></span><span class="tiny">총 30분</span></div>
        <div class="timer" id="sessTime">${active ? '' : '05:00'}</div>
        <div class="progress"><i id="sessBar" style="width:0"></i></div>
        <div class="row" style="margin-top:10px"><button class="btn primary grow" id="sessToggle" data-act="sessToggle" data-n="${n}">시작</button><button class="btn" data-act="sessNext" data-n="${n}">다음 단계 →</button></div>
      </div>

      <div class="card steps">
        ${D.STEP_FRAME.map((s, i) => `<div class="step"><div class="n">${i + 1}</div><div class="grow">
          <h3>${esc(s.t)} <span class="tiny">${s.m}분</span></h3><p class="small muted" style="margin:0">${esc(s.d)}</p>${stepBody(s.k)}</div></div>`).join('')}
      </div>

      <h2>${esc(name(p))}의 일지</h2>
      <div class="card">
        ${mood('before', '시작 전 마음 온도')}
        ${d.q.map((q, i) => `<label class="field"><span>${esc(q)}</span><textarea data-note="q${i}" placeholder="솔직하게, 상대 탓 없이 '나'로 써 보세요">${esc(r.notes['q' + i] || '')}</textarea></label>`).join('')}
        <label class="field"><span>오늘 ${esc(name(o))}에게 고마웠던 점</span><input type="text" data-note="thanks" value="${esc(r.notes.thanks || '')}"></label>
        ${mood('after', '마친 후 마음 온도')}
        <button class="btn ${r.done ? '' : 'primary'} block" data-act="toggleDone" data-n="${n}">${r.done ? '✓ 완료함 (취소하려면 누르기)' : `${esc(name(p))} 오늘 과정 완료`}</button>
      </div>

      <h2>${esc(name(o))}의 일지</h2>
      <div class="card">${ro && (ro.done || Object.values(ro.notes || {}).some(Boolean)) ? `
        <p class="small">${ro.done ? '<span class="chip ok">완료</span>' : '<span class="chip">작성 중</span>'} ${ro.before != null ? `마음 온도 ${ro.before} → ${ro.after == null ? '-' : ro.after}` : ''}</p>
        ${d.q.map((q, i) => ro.notes['q' + i] ? `<p class="tiny" style="margin:8px 0 0">${esc(q)}</p><p>${esc(ro.notes['q' + i])}</p>` : '').join('')}
        ${ro.notes.thanks ? `<p class="tiny" style="margin:8px 0 0">고마웠던 점</p><p>${esc(ro.notes.thanks)}</p>` : ''}`
        : `<p class="tiny">아직 기록이 없어요. 같은 폰이면 위의 "${esc(name(p))} 사용 중"을 눌러 ${esc(name(o))}로 바꿔 쓰고, 각자 폰이면 도구 → 동기화로 기록을 합치세요.</p>`}</div>
      <div class="row" style="justify-content:space-between;margin-top:8px">
        ${n > 1 ? `<button class="btn ghost" data-act="openDay" data-n="${n - 1}">← Day ${n - 1}</button>` : '<span></span>'}
        ${n < 30 ? `<button class="btn ghost" data-act="openDay" data-n="${n + 1}">Day ${n + 1} →</button>` : ''}
      </div>`;
  }

  // ───────────────────────── 사주
  function profileSaju(p) {
    const pr = st.profiles[p];
    const full = (v) => v && v.s != null && v.b != null;
    const m = pr.manual;
    if (pr.useManual && m && full(m.year) && full(m.month) && full(m.day)) {
      return S.fromManual({ year: m.year, month: m.month, day: m.day, hour: full(m.hour) ? m.hour : null });
    }
    if (!pr.birth.date) return null;
    return S.calc(pr.birth.date, pr.birth.unknown ? null : (pr.birth.time || null), pr.birth.correct);
  }
  const ELC = (el) => D.EL_INFO[el].color;
  function pillarsHtml(res) {
    const lab = { hour: '시주', day: '일주', month: '월주', year: '연주' };
    return `<div class="pillars">${res.pillars.map(x => `<div class="pillar"><div class="lab">${lab[x.key]}</div>
      ${x.empty ? '<div class="ch empty">?<small>모름</small></div><div class="ch empty">?<small>&nbsp;</small></div>'
        : `<div class="ch" style="background:${ELC(x.stemEl)}">${x.stemH}<small>${x.stem}·${x.stemEl}</small></div>
           <div class="ch" style="background:${ELC(x.branchEl)}">${x.branchH}<small>${x.branch}·${x.branchEl}</small></div>`}
      </div>`).join('')}</div>`;
  }
  function elementsHtml(res) {
    const tot = Object.values(res.count).reduce((a, b) => a + b, 0) || 1;
    return `<div class="elbar">${S.ELEMENTS.map(e => res.count[e] ? `<i style="width:${res.count[e] / tot * 100}%;background:${ELC(e)}"></i>` : '').join('')}</div>
      <div class="ellegend">${S.ELEMENTS.map(e => `<span><i style="background:${ELC(e)}"></i>${e}(${S.EL_HANJA[e]}) ${res.count[e]}</span>`).join('')}</div>`;
  }
  function viewSaju() {
    const sp = sub.saju || (sub.saju = { who: me() });
    const seg = `<div class="seg">${['h', 'w'].map(p => `<button class="${sp.who === p ? 'on' : ''}" data-act="sajuWho" data-p="${p}">${esc(name(p))}</button>`).join('')}<button class="${sp.who === 'match' ? 'on' : ''}" data-act="sajuWho" data-p="match">우리 궁합</button></div>`;
    return `<h1>사주팔자</h1><p class="muted small">타고난 기운을 알면 "저 사람이 왜 저럴까"가 "아, 그래서 그렇구나"로 바뀝니다. 운명을 정하는 답이 아니라 서로를 이해하는 참고 자료로만 보세요.</p>${seg}${sp.who === 'match' ? sajuMatch() : sajuPerson(sp.who)}`;
  }
  function sajuPerson(p) {
    const pr = st.profiles[p], b = pr.birth, res = profileSaju(p);
    const sel = (pk, kind, val) => {
      const arr = kind === 's' ? S.STEMS.map((x, i) => `${x}(${S.STEMS_H[i]})`) : S.BRANCHES.map((x, i) => `${x}(${S.BRANCHES_H[i]})`);
      return `<select data-manual="${pk}.${kind}"><option value="">-</option>${arr.map((x, i) => `<option value="${i}" ${val === i ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
    };
    const m = pr.manual || {};
    const g = (pk, k) => (m[pk] ? m[pk][k] : null);
    let out = `<div class="card">
      <h3>${esc(name(p))}의 생년월일시 (양력)</h3>
      <div class="grid2">
        <label class="field"><span>생년월일</span><input type="date" data-birth="date" value="${esc(b.date)}" min="1920-01-01" max="2030-12-31"></label>
        <label class="field"><span>태어난 시각</span><input type="time" data-birth="time" value="${esc(b.time)}" ${b.unknown ? 'disabled' : ''}></label>
      </div>
      <label class="check"><input type="checkbox" data-birth="unknown" ${b.unknown ? 'checked' : ''}><span>태어난 시각을 몰라요 (시주 제외)</span></label>
      <label class="check"><input type="checkbox" data-birth="correct" ${b.correct ? 'checked' : ''}><span>진태양시 보정 (서울 기준 -30분, 대부분의 만세력 방식)</span></label>
      <p class="tiny">음력 생일만 안다면 달력 앱에서 양력으로 바꿔 넣어 주세요. 절기가 바뀌는 날 전후에 태어났다면 만세력 결과와 비교해 보세요.</p>
      <details ${pr.useManual || pr.manual ? 'open' : ''}><summary class="small" style="font-weight:700;padding:8px 0">사주 데이터 직접 입력 / 불러오기 (만세력·철학관 결과)</summary>
        <label class="check"><input type="checkbox" data-act-change="useManual" ${pr.useManual ? 'checked' : ''}><span>직접 입력한 여덟 글자를 사용</span></label>
        <div class="pillars" style="margin-top:6px">${['hour', 'day', 'month', 'year'].map(pk => `<div class="pillar"><div class="lab">${{ hour: '시', day: '일', month: '월', year: '연' }[pk]}</div>${sel(pk, 's', g(pk, 's'))}<div style="height:4px"></div>${sel(pk, 'b', g(pk, 'b'))}</div>`).join('')}</div>
        <button class="btn block" style="margin-top:8px" data-act="manualFromCalc" data-p="${p}">계산 결과를 직접 입력 칸에 복사</button>
      </details>
    </div>`;
    if (!res) return out + `<div class="speech card soft">${frog('calm', 60)}<div class="bubble">생년월일을 넣으면 개굴씨가 여덟 글자를 뽑아 줄게!</div></div>`;
    const dm = D.DAY_MASTER[res.dayMaster], el = res.dayMasterEl, info = D.EL_INFO[el];
    const missing = S.ELEMENTS.filter(e => res.count[e] === 0);
    const strong = S.ELEMENTS.filter(e => res.count[e] >= 3);
    out += `<div class="card">
      <div class="row"><h3 class="grow">${esc(name(p))}의 사주 원국</h3>${res.meta.manual ? '<span class="chip">직접 입력</span>' : `<span class="chip">${res.animal}띠</span>`}</div>
      ${pillarsHtml(res)}
      <h3 style="margin-top:14px">오행 분포</h3>${elementsHtml(res)}
      ${missing.length ? `<p class="small" style="margin-top:8px">없는 기운: <b>${missing.join(', ')}</b> — 이 기운을 가진 배우자의 모습에서 배우거나, 채워줄 수 있어요.</p>` : ''}
      ${strong.length ? `<p class="small">강한 기운: <b>${strong.join(', ')}</b> — ${strong.map(e => D.EL_INFO[e].talk).join(' ')}</p>` : ''}
    </div>
    <div class="card">
      <div class="row"><span class="chip" style="background:${info.color};color:#fff">일간 ${S.STEMS[res.dayMaster]}${el}(${S.STEMS_H[res.dayMaster]}${S.EL_HANJA[el]})</span><span class="tiny">나를 나타내는 글자 · "${dm.img}"</span></div>
      <p style="margin-top:10px">${esc(dm.nature)}</p>
      <p class="small"><b>다툴 때 나오는 모습</b><br>${esc(dm.conflict)}</p>
      <p class="small"><b>${esc(name(other(p)))}가 알아주면 좋은 것</b><br>${esc(dm.need)}</p>
    </div>`;
    return out;
  }
  function sajuMatch() {
    const a = profileSaju('h'), b = profileSaju('w');
    if (!a || !b) return `<div class="speech card soft">${frog('worry', 60)}<div class="bubble">두 사람 모두 생년월일을 넣어야 궁합을 볼 수 있어. 위에서 ${esc(name('h'))}, ${esc(name('w'))}를 각각 눌러 입력해 줘!</div></div>`;
    const ea = a.dayMasterEl, eb = b.dayMasterEl, rel = S.relation(ea, eb);
    let A = name('h'), B = name('w'), key = 'same';
    if (rel === 'aGenB') key = 'gen'; else if (rel === 'bGenA') { key = 'gen'; [A, B] = [B, A]; }
    else if (rel === 'aCtrlB') key = 'ctrl'; else if (rel === 'bCtrlA') { key = 'ctrl'; [A, B] = [B, A]; }
    const rt = D.REL_TEXT[key], fill = (s) => esc(s).replace(/\{A\}/g, esc(A)).replace(/\{B\}/g, esc(B));
    const br = S.branchRelation(a.raw.day.b, b.raw.day.b);
    const brText = { hap: ['육합(六合)', '배우자 자리(일지)가 서로 합을 이뤄요. 끌림이 크고 화해도 빠른 편이에요. 그래서 "어차피 화해하니까" 하고 함부로 말하지 않도록 조심!'],
      chung: ['충(沖)', '배우자 자리(일지)가 서로 부딪히는 관계예요. 생활 리듬과 반응 속도가 달라 충돌이 잦을 수 있어요. 그래서 타임아웃 규칙과 발언권 규칙이 특히 효과적이에요.'],
      same: ['같은 일지', '배우자 자리가 같은 글자예요. 비슷한 것을 원해서 편하지만, 같은 걸 두고 경쟁하기도 해요. 역할을 나눠 두면 좋아요.'],
      none: ['평이', '일지끼리 특별한 합이나 충은 없어요. 관계의 색깔은 매일의 습관이 만들어 갑니다.'] }[br];
    const comb = {}; S.ELEMENTS.forEach(e => { comb[e] = a.count[e] + b.count[e]; });
    const lack = S.ELEMENTS.filter(e => comb[e] === 0);
    const hCovers = S.ELEMENTS.filter(e => a.count[e] > 0 && b.count[e] === 0), wCovers = S.ELEMENTS.filter(e => b.count[e] > 0 && a.count[e] === 0);
    return `
      <div class="card">
        <div class="grid2" style="text-align:center">
          ${[['h', a], ['w', b]].map(([p, r]) => `<div><span class="dot ${p}"></span> <b>${esc(name(p))}</b><div class="chip" style="background:${ELC(r.dayMasterEl)};color:#fff;margin-top:6px">${S.STEMS[r.dayMaster]}${r.dayMasterEl} · ${D.DAY_MASTER[r.dayMaster].img}</div></div>`).join('')}
        </div>
        <h3 style="margin-top:14px">${esc(rt.t)}</h3><p>${fill(rt.d)}</p>
        <div class="card soft small" style="margin:0">💡 ${fill(rt.tip)}</div>
      </div>
      <div class="card"><h3>배우자 자리(일지): ${a.pillars[1].branch}(${a.pillars[1].branchH}) · ${b.pillars[1].branch}(${b.pillars[1].branchH}) — ${brText[0]}</h3><p class="small">${esc(brText[1])}</p></div>
      <div class="card"><h3>서로 채워주는 기운</h3>
        <p class="small">${hCovers.length ? `${esc(name('h'))}가 ${esc(name('w'))}에게 채워주는 기운: <b>${hCovers.join(', ')}</b>` : `${esc(name('h'))}만 가진 기운은 없어요.`}</p>
        <p class="small">${wCovers.length ? `${esc(name('w'))}가 ${esc(name('h'))}에게 채워주는 기운: <b>${wCovers.join(', ')}</b>` : `${esc(name('w'))}만 가진 기운은 없어요.`}</p>
        ${lack.length ? `<p class="small">둘 다 없는 기운: <b>${lack.join(', ')}</b> — ${lack.map(e => `${e}(${D.EL_INFO[e].word})`).join(', ')}의 힘은 둘이 의식적으로 연습해야 해요.</p>` : '<p class="small">둘이 합치면 다섯 기운이 모두 있어요. 함께일 때 균형이 맞는 부부예요.</p>'}
      </div>
      <div class="card"><h3>싸울 때 서로에게 이렇게</h3>
        <p class="small"><b>${esc(name('w'))} → ${esc(name('h'))}:</b> ${esc(D.DAY_MASTER[a.dayMaster].need)}</p>
        <p class="small"><b>${esc(name('h'))} → ${esc(name('w'))}:</b> ${esc(D.DAY_MASTER[b.dayMaster].need)}</p>
      </div>
      <div class="speech">${frog('calm', 56)}<div class="bubble small">사주는 "이래서 안 맞아"의 핑계가 아니라 "이렇게 다르니까 이렇게 맞춰 가자"의 지도야. 진짜 궁합은 매일 30분이 만들어!</div></div>`;
  }

  // ───────────────────────── 사랑의 언어
  function llResult(answers) {
    const c = { W: 0, T: 0, G: 0, S: 0, P: 0 };
    answers.forEach((a, i) => { if (a != null) c[D.LOVE_Q[i][a * 2]]++; });
    const order = Object.keys(c).sort((x, y) => c[y] - c[x]);
    return { c, order };
  }
  function barsHtml(c) {
    const max = 8;
    return `<div class="bars">${Object.keys(D.LOVE).sort((x, y) => c[y] - c[x]).map(k => `<div class="b"><span>${D.LOVE[k].e} ${D.LOVE[k].t}</span><span class="t"><i style="width:${c[k] / max * 100}%;background:var(--accent)"></i></span><b>${c[k]}</b></div>`).join('')}</div>`;
  }
  function viewLove() {
    const sl = sub.love || (sub.love = { who: me() });
    const seg = `<div class="seg">${P.map(p => `<button class="${sl.who === p ? 'on' : ''}" data-act="loveWho" data-p="${p}">${esc(name(p))}</button>`).join('')}<button class="${sl.who === 'cmp' ? 'on' : ''}" data-act="loveWho" data-p="cmp">둘이 비교</button></div>`;
    let body;
    if (sl.who === 'cmp') {
      body = P.map(p => {
        const r = st.ll[p];
        if (!r || !r.done) return `<div class="card"><h3><span class="dot ${p}"></span> ${esc(name(p))}</h3><p class="tiny">아직 테스트 전이에요.</p></div>`;
        const res = llResult(r.answers), top = res.order.slice(0, 2);
        return `<div class="card"><h3><span class="dot ${p}"></span> ${esc(name(p))}의 언어: ${top.map(k => D.LOVE[k].e + ' ' + D.LOVE[k].t).join(' · ')}</h3>
          ${barsHtml(res.c)}
          <p class="small" style="margin-top:10px"><b>${esc(name(other(p)))}가 ${esc(name(p))}에게 사랑을 주는 법</b></p>
          <ul class="list small">${top.flatMap(k => D.LOVE[k].tips.slice(0, 3)).map(t => `<li>${esc(t)}</li>`).join('')}</ul>
          ${r.memo ? `<p class="small"><b>${esc(name(p))}의 메모</b><br>${esc(r.memo)}</p>` : ''}</div>`;
      }).join('') + `<div class="speech">${frog('love', 56)}<div class="bubble small">내가 받고 싶은 방식이 아니라, 상대가 받고 싶은 방식으로! 그게 사랑의 번역이야.</div></div>`;
    } else {
      body = loveQuiz(sl.who);
    }
    return `<h1>사랑의 언어</h1><p class="muted small">사람마다 사랑을 느끼는 "언어"가 달라요. 20문항, 각자 5분. 더 끌리는 쪽을 고르세요.</p>${seg}${body}`;
  }
  function loveQuiz(p) {
    const r = st.ll[p] || (st.ll[p] = { answers: Array(D.LOVE_Q.length).fill(null), done: false, memo: '', ts: 0 });
    if (r.done) {
      const res = llResult(r.answers), top = D.LOVE[res.order[0]];
      return `<div class="speech card soft">${frog('love', 64)}<div class="bubble">${esc(name(p))}의 1순위 사랑의 언어는 <b>${top.e} ${top.t}</b>!</div></div>
        <div class="card">${barsHtml(res.c)}<p style="margin-top:10px">${esc(top.d)}</p>
          <p class="small"><b>2순위 ${D.LOVE[res.order[1]].e} ${D.LOVE[res.order[1]].t}</b> — ${esc(D.LOVE[res.order[1]].d)}</p></div>
        <div class="card"><label class="field"><span>"나는 ___할 때 사랑받는 느낌이 들어" (구체적인 예 3가지)</span><textarea data-llmemo="${p}">${esc(r.memo || '')}</textarea></label></div>
        <button class="btn block" data-act="llReset" data-p="${p}">다시 하기</button>`;
    }
    const i = r.answers.findIndex(a => a == null), idx = i < 0 ? 0 : i, q = D.LOVE_Q[idx];
    const answered = r.answers.filter(a => a != null).length;
    return `<div class="card">
      <div class="row"><b>${esc(name(p))}</b><span class="grow"></span><span class="tiny">${answered}/${D.LOVE_Q.length}</span></div>
      <div class="progress" style="margin:8px 0 14px"><i style="width:${answered / D.LOVE_Q.length * 100}%"></i></div>
      <p class="muted small">나는 이럴 때 더 사랑받는다고 느낀다</p>
      <button class="qopt" data-act="llAns" data-p="${p}" data-i="${idx}" data-a="0">${esc(q[1])}</button>
      <button class="qopt" data-act="llAns" data-p="${p}" data-i="${idx}" data-a="1">${esc(q[3])}</button>
      ${answered ? `<button class="btn ghost" data-act="llBack" data-p="${p}">← 이전 문항</button>` : ''}
    </div>`;
  }

  // ───────────────────────── 도구
  function viewTools() {
    const ts = sub.tools || (sub.tools = { open: null });
    const item = (k, ico, t, d) => `<button class="card row" style="width:100%;text-align:left" data-act="toolOpen" data-k="${k}"><span style="font-size:26px">${ico}</span><span class="grow"><b>${t}</b><br><span class="tiny">${d}</span></span><span>›</span></button>`;
    if (ts.open) return toolDetail(ts.open);
    return `<h1>도구</h1>
      ${item('pledge', '📜', '하지 않기 서약', '욕·부수기·버리기·탓하기… 우리가 하지 않을 것')}
      ${item('money', '💳', '돈 대화', '비싼 물건 규칙 · 눈치 없이 묻는 법 · 구매 공유 카드')}
      ${item('repair', '🩹', '회복 문장', '싸우는 도중 관계를 살리는 한마디')}
      ${item('timer', '⏱️', '말하기 타이머', '발언권 · 3분 끼어들지 않기 연습')}
      ${item('safety', '🆘', '안전 연락처', '위협·폭력이 있을 때 바로 도움받기')}
      ${item('sync', '🔄', '동기화 · 백업', '각자 폰 기록 합치기, 백업/복원')}
      ${item('settings', '⚙️', '설정', '이름 · 시작일 · 테마 · 초기화')}
      ${st.timeouts.length ? `<p class="tiny">지금까지 개굴 타임 ${st.timeouts.length}회 — 멈춘 횟수만큼 관계를 지킨 거예요.</p>` : ''}`;
  }
  function toolDetail(k) {
    const back = `<button class="btn ghost" data-act="toolOpen" data-k="">← 도구</button>`;
    if (k === 'pledge') {
      return `${back}<h1>하지 않기 서약</h1>
        <div class="card">${D.DONTS.map(x => `<div class="dont"><div class="x">✕ ${esc(x.t)}</div><div class="o">→ 대신: ${esc(x.alt)}</div></div>`).join('')}
          ${st.pledge.custom.map((c, i) => `<div class="dont"><div class="x">✕ ${esc(c)} <button class="btn ghost small" data-act="delCustom" data-i="${i}" aria-label="삭제">삭제</button></div></div>`).join('')}
          <div class="row" style="margin-top:10px"><input type="text" id="customIn" class="grow" placeholder="우리만의 약속 추가 (예: 밤 12시 넘어서 싸우지 않기)"><button class="btn" data-act="addCustom">추가</button></div>
        </div>
        <div class="card soft"><p><b>서약</b> — 우리는 서로를 이기기 위해서가 아니라 같은 편이 되기 위해 싸운다. 위의 행동을 하지 않으며, 했을 때는 숨기지 않고 사과하고 다시 약속으로 돌아온다.</p>
          <div class="grid2">${P.map(p => st.pledge[p] ? `<div class="chip ok" style="justify-content:center;padding:10px"><span class="dot ${p}"></span>${esc(name(p))} 서명 ${esc(st.pledge[p].date)}</div>` : `<button class="btn primary" data-act="sign" data-p="${p}">${esc(name(p))} 서명</button>`).join('')}</div>
          <button class="btn ghost block small" data-act="resign" style="margin-top:8px">서명 갱신 (다시 서명하기)</button></div>`;
    }
    if (k === 'money') {
      const r = st.money.rules;
      return `${back}<h1>돈 대화</h1>
        <div class="speech" style="margin-bottom:12px">${frog('happy', 56)}<div class="bubble small">규칙이 있으면 눈치가 필요 없어! 규칙 안이면 "예쁘다~", 규칙 밖이면 "같이 상의하자". 끝!</div></div>
        <div class="card"><h3>우리의 소비 규칙</h3>
          <div class="grid2">
            <label class="field"><span>사기 전에 상의할 금액 (만 원 이상)</span><input type="number" min="0" data-rule="limit" value="${esc(r.limit)}"></label>
            <label class="field"><span>생각 시간 (시간)</span><input type="number" min="0" data-rule="wait" value="${esc(r.wait)}"></label>
            <label class="field"><span>${esc(name('h'))} 자유 용돈 (월, 만 원)</span><input type="number" min="0" data-rule="allowH" value="${esc(r.allowH)}"></label>
            <label class="field"><span>${esc(name('w'))} 자유 용돈 (월, 만 원)</span><input type="number" min="0" data-rule="allowW" value="${esc(r.allowW)}"></label>
          </div>
          <label class="field"><span>함께 모을 목표</span><input type="text" data-rule="goal" value="${esc(r.goal)}" placeholder="예: 내년 여름 제주 여행 200만 원"></label>
          <p class="small muted">자유 용돈 안의 소비는 묻지도 따지지도 않기. ${esc(r.limit)}만 원 이상은 사기 전에 상의하고, ${esc(r.wait)}시간 생각해 보기.</p>
        </div>
        <div class="card"><h3>눈치 주지 않고 묻는 3단계</h3>
          <ol class="list small"><li><b>관심·인정 먼저</b> — "이거 마음에 들었구나. 예쁘다."</li><li><b>내 감정은 나-전달법</b> — "나는 이번 달 카드값이 조금 불안해."</li><li><b>함께 볼 것을 제안</b> — "주말에 같이 예산 한번 볼까?"</li></ol>
          <p class="small" style="margin-top:8px"><b>하지 않기:</b> 한숨, "또 샀어?", 가격 캐묻기, 다른 사람 앞에서 말하기, 지난 소비 끌어오기</p>
          <p class="small"><b>산 사람은:</b> 숨기지 않고 먼저 공유하기 — "나 이거 샀어. 규칙 안이야 / 규칙 넘어서 미안, 같이 이야기하자."</p>
        </div>
        <div class="card"><h3>구매 공유 카드</h3>
          <label class="field"><span>무엇을</span><input type="text" id="buyWhat" placeholder="예: 겨울 코트"></label>
          <div class="grid2"><label class="field"><span>가격 (만 원)</span><input type="number" id="buyPrice" min="0"></label>
          <label class="field"><span>상태</span><select id="buyKind"><option value="plan">사고 싶어요 (상의)</option><option value="done">샀어요 (공유)</option></select></label></div>
          <label class="field"><span>왜 갖고 싶은지 / 나에게 주는 기쁨</span><input type="text" id="buyWhy"></label>
          <button class="btn primary block" data-act="buyAdd">${esc(name(me()))}가 공유하기</button>
          <div style="margin-top:12px">${st.money.log.slice().reverse().slice(0, 12).map(x => {
            const over = Number(x.price) >= Number(r.limit);
            return `<div class="msg"><div class="meta"><span class="dot ${x.by}"></span> ${esc(name(x.by))} · ${fmtDate(x.at)} · ${x.kind === 'plan' ? '상의 요청' : '구매 공유'} ${over ? '<span class="chip">상의 기준 이상</span>' : '<span class="chip ok">규칙 안</span>'}</div>
              <b>${esc(x.what)}</b> ${x.price ? esc(x.price) + '만 원' : ''}${x.why ? `<br><span class="small">${esc(x.why)}</span>` : ''}
              ${x.reply ? `<div class="small" style="margin-top:4px">↳ ${esc(name(other(x.by)))}: ${esc(x.reply)}</div>` : (x.by !== me() ? `<div class="row" style="margin-top:6px"><button class="btn small" data-act="buyReply" data-id="${x.id}" data-r="좋다! 잘 샀어 😊">좋다!</button><button class="btn small" data-act="buyReply" data-id="${x.id}" data-r="마음에 들었구나. 주말에 같이 예산 한번 보자">같이 보자</button><button class="btn small" data-act="buyReply" data-id="${x.id}" data-r="고마워, 먼저 말해줘서">말해줘서 고마워</button></div>` : '')}</div>`;
          }).join('') || '<p class="tiny">아직 공유한 구매가 없어요.</p>'}</div>
        </div>`;
    }
    if (k === 'repair') {
      return `${back}<h1>회복 문장</h1><p class="muted small">싸우는 도중 이 중 하나를 말해 보세요. 상대가 회복 문장을 쓰면, 화가 나도 일단 받아주는 게 규칙!</p>
        <div class="card">${D.REPAIRS.map(x => `<div class="check" style="justify-content:space-between"><span>"${esc(x)}"</span></div>`).join('')}</div>`;
    }
    if (k === 'timer') {
      return `${back}<h1>말하기 타이머</h1><p class="muted small">타이머가 끝날 때까지 듣는 사람은 끼어들지 않아요. 끝나면 들은 내용을 요약해 주세요.</p>
        <div class="card" style="text-align:center">${frog('calm', 80)}<div class="timer" id="miniTime">${fmtTime(mini.left)}</div>
          <div class="row" style="justify-content:center">${[1, 2, 3, 5].map(m => `<button class="btn" data-act="miniTimer" data-m="${m}">${m}분</button>`).join('')}<button class="btn ghost" data-act="miniStop">정지</button></div></div>`;
    }
    if (k === 'safety') return back + safetyHtml();
    if (k === 'sync') {
      return `${back}<h1>동기화 · 백업</h1>
        <div class="card"><h3>각자 폰에서 쓸 때</h3>
          <ol class="list small"><li>한 사람이 아래 <b>기록 코드 만들기</b> → 카카오톡 등으로 상대에게 보냄</li><li>받은 사람은 그 코드를 <b>기록 합치기</b> 칸에 붙여넣기</li><li>합친 사람이 다시 코드를 만들어 보내면 두 폰이 같아져요</li></ol>
          <p class="tiny">같은 날의 기록은 더 나중에 수정한 쪽이 남아요. 서버로 아무것도 보내지 않습니다.</p>
          <button class="btn primary block" data-act="exportCode">기록 코드 만들기</button>
          <textarea id="codeOut" readonly style="margin-top:8px" placeholder="여기에 코드가 나타나요"></textarea>
          <div class="row" style="margin-top:6px"><button class="btn grow" data-act="copyCode">복사</button><button class="btn grow" data-act="shareCode">공유</button></div>
        </div>
        <div class="card"><h3>기록 합치기 / 복원</h3><textarea id="codeIn" placeholder="받은 코드를 붙여넣으세요"></textarea>
          <button class="btn primary block" style="margin-top:8px" data-act="importCode">합치기</button></div>`;
    }
    if (k === 'settings') {
      return `${back}<h1>설정</h1>
        <div class="card"><div class="grid2">
          <label class="field"><span>남편 이름(호칭)</span><input type="text" data-name="h" value="${esc(name('h'))}" maxlength="12"></label>
          <label class="field"><span>아내 이름(호칭)</span><input type="text" data-name="w" value="${esc(name('w'))}" maxlength="12"></label></div>
          <label class="field"><span>30일 과정 시작일</span><input type="date" id="startIn" value="${esc(st.startDate || ymd())}"></label>
          <button class="btn block" data-act="saveStart">시작일 저장</button></div>
        <div class="card"><h3>화면 테마</h3><div class="seg">${[['auto', '자동'], ['light', '밝게'], ['dark', '어둡게']].map(([v, t]) => `<button class="${st.theme === v ? 'on' : ''}" data-act="theme" data-v="${v}">${t}</button>`).join('')}</div></div>
        <div class="card danger"><h3>모든 기록 지우기</h3><p class="small">이 폰의 모든 기록이 사라져요. 먼저 동기화 · 백업에서 코드를 만들어 두세요.</p><button class="btn block" data-act="reset">초기화</button></div>
        <p class="tiny">개굴씨 부부연구소 v1.0 · 이 앱은 전문 상담을 대신하지 않아요. 어려움이 계속되면 부부상담 전문가와 함께하세요.</p>`;
    }
    return back;
  }
  function safetyHtml() {
    return `<h1>안전 연락처</h1>
      <div class="card danger"><p><b>이럴 땐 바로 도움을 요청하세요.</b></p>
        <ul class="list small"><li>몸을 밀치거나, 때리거나, 물건을 상대에게 던진 적이 있을 때</li><li>물건을 부수는 행동이 점점 심해질 때</li><li>"죽겠다", "죽이겠다" 같은 말이 나올 때</li><li>집에 있는 것이 무섭다고 느낄 때</li></ul>
        <p class="small">이런 상황은 "서로 노력하면 되는 문제"를 넘어선 안전의 문제예요. 도움을 청하는 건 관계를 포기하는 게 아니라 지키는 거예요.</p></div>
      <div class="card">${D.SAFETY.map(s => `<div class="check" style="justify-content:space-between"><span><b>${s.n}</b><br><span class="tiny">${esc(s.t)}</span></span><a class="btn primary" href="tel:${s.n}">전화</a></div>`).join('')}</div>
      <p class="tiny">가까운 건강가정·다문화가족지원센터(가족센터)에서 무료 또는 저렴한 부부상담을 받을 수 있어요.</p>`;
  }

  // ───────────────────────── 개굴 타임 (타임아웃)
  const to = { left: 0, iv: null, biv: null };
  function openTimeout() {
    st.timeouts.push({ id: uid(), by: me(), at: now() }); save();
    to.left = 20 * 60;
    openSheet(`
      <div style="text-align:center">${frog('calm', 96)}<h1 style="margin-top:4px">개굴 타임</h1>
        <p class="muted small">지금은 대화를 멈추고, 서로 다른 공간에서 몸을 진정시키는 시간이에요.<br>20분 뒤에 꼭 다시 만나요.</p>
        <div class="breath" id="breath"><span class="breath-label" id="breathLabel">들이쉬고</span></div>
        <div class="timer" id="toTime">20:00</div></div>
      <div class="card small"><b>지금 하면 좋은 것</b><ul class="list"><li>방을 옮기기 · 창문 열기 · 찬물 세수</li><li>호흡: 4초 들이쉬고 6초 내쉬기 (위 원을 따라)</li><li>상대 탓 생각이 올라오면 "지금은 몸부터"라고 속으로 말하기</li></ul>
        <b>하지 않기</b><ul class="list"><li>따라가서 말 걸기 · 문 쾅 닫기 · 물건 만지기</li><li>메시지로 싸움 이어가기</li></ul></div>
      <div class="card soft small"><b>돌아와서 첫마디</b><br>"아까 멈춰 줘서 고마워. 내가 ___한 건 내 몫이야. 다시 천천히 이야기해 볼까?"</div>
      <p class="tiny" style="text-align:center">위협을 느낀다면 <a href="tel:112">112</a> · <a href="tel:1366">1366</a></p>
      <button class="btn primary block" data-act="closeSheet">진정됐어요, 돌아가기</button>`, () => { clearInterval(to.iv); clearInterval(to.biv); });
    let phase = 0;
    const b = () => { const el = $('#breath'), lb = $('#breathLabel'); if (!el) return; phase = 1 - phase; el.classList.toggle('in', phase === 1); lb.textContent = phase ? '들이쉬고' : '내쉬고'; };
    b(); let t = 0;
    to.biv = setInterval(() => { t++; if ((phase === 1 && t >= 4) || (phase === 0 && t >= 6)) { t = 0; b(); } }, 1000);
    to.iv = setInterval(() => {
      to.left--; const el = $('#toTime'); if (el) el.textContent = fmtTime(Math.max(0, to.left));
      if (to.left <= 0) { clearInterval(to.iv); beep(3); if (el) el.textContent = '다시 만날 시간'; }
    }, 1000);
  }

  // 미니 타이머
  const mini = { left: 180, iv: null };
  function startMini(m) {
    clearInterval(mini.iv); mini.left = m * 60; paintMini(); toast(`${m}분 말하기 시작! 듣는 사람은 끼어들기 금지`);
    mini.iv = setInterval(() => { mini.left--; paintMini(); if (mini.left <= 0) { clearInterval(mini.iv); beep(2); toast('끝! 들은 내용을 요약해 주세요'); } }, 1000);
  }
  function paintMini() { const el = $('#miniTime'); if (el) el.textContent = fmtTime(Math.max(0, mini.left)); }

  // ───────────────────────── 동기화
  function encode(obj) { const json = JSON.stringify(obj); return 'GAEGUL1:' + btoa(unescape(encodeURIComponent(json))); }
  function decode(code) {
    const c = code.trim().replace(/\s+/g, '');
    if (!c.startsWith('GAEGUL1:')) throw new Error('코드 형식이 달라요');
    return JSON.parse(decodeURIComponent(escape(atob(c.slice(8)))));
  }
  const newer = (a, b) => (!a ? b : !b ? a : ((b.ts || 0) > (a.ts || 0) ? b : a));
  const unionById = (a = [], b = []) => { const m = new Map(); [...a, ...b].forEach(x => { if (x && x.id) m.set(x.id, Object.assign({}, m.get(x.id), x)); }); return [...m.values()].sort((x, y) => x.at - y.at); };
  function merge(r) {
    P.forEach(p => {
      st.profiles[p] = newer(st.profiles[p], r.profiles && r.profiles[p]);
      st.ll[p] = newer(st.ll[p], r.ll && r.ll[p]);
      st.pledge[p] = newer(st.pledge[p], r.pledge && r.pledge[p]);
    });
    if (!st.startDate || (r.startDate && r.startDate < st.startDate)) st.startDate = r.startDate || st.startDate;
    Object.keys(r.days || {}).forEach(n => { st.days[n] = st.days[n] || {}; P.forEach(p => { const v = newer(st.days[n][p], r.days[n][p]); if (v) st.days[n][p] = v; }); });
    Object.keys(r.daily || {}).forEach(d => { st.daily[d] = st.daily[d] || {}; P.forEach(p => { const v = newer(st.daily[d][p], r.daily[d][p]); if (v) st.daily[d][p] = v; }); });
    st.pledge.custom = Array.from(new Set([...(st.pledge.custom || []), ...((r.pledge && r.pledge.custom) || [])]));
    if (r.money) { st.money.rules = newer(st.money.rules, r.money.rules); st.money.log = unionById(st.money.log, r.money.log); }
    st.messages = unionById(st.messages, r.messages);
    st.timeouts = unionById(st.timeouts, r.timeouts);
    save();
  }

  // ───────────────────────── 이벤트
  const acts = {
    closeSheet,
    openDay: (el) => { sub.program = { day: Number(el.dataset.n) }; go('program'); },
    backProgram: () => { sub.program = {}; go('program'); },
    sessToggle: (el) => { const n = Number(el.dataset.n); if (session.day === n && session.running) pauseSession(); else startSession(n); },
    sessNext: (el) => { const n = Number(el.dataset.n); if (session.day !== n) { session.day = n; session.idx = 0; session.left = D.STEP_FRAME[0].m * 60; } nextStep(); },
    miniTimer: (el) => startMini(Number(el.dataset.m)),
    miniStop: () => { clearInterval(mini.iv); toast('타이머 정지'); },
    toggleDone: (el) => {
      const n = Number(el.dataset.n), r = dayRec(n, me()); r.done = !r.done; r.ts = now(); save();
      if (r.done) {
        const both = isDone(n, 'h') && isDone(n, 'w');
        openSheet(`<div style="text-align:center">${frog('cheer', 110)}<h1>${both ? `Day ${n} 둘 다 완료!` : `${esc(name(me()))} Day ${n} 완료!`}</h1>
          <p>${both ? '오늘도 둘이 같은 편이 되었어. 서로 "고생했어" 한마디 해주자!' : `${esc(name(other(me())))}도 완료하면 이 날이 초록색이 돼.`}</p>
          <button class="btn primary block" data-act="closeSheet">좋아!</button></div>`);
      }
      render();
    },
    sendMsg: () => { const i = $('#msgIn'); const t = i.value.trim(); if (!t) return; st.messages.push({ id: uid(), from: me(), text: t, at: now() }); save(); render(); toast('남겼어요 💚'); },
    safety: () => openSheet(safetyHtml()),
    sajuWho: (el) => { sub.saju.who = el.dataset.p; render(); },
    manualFromCalc: (el) => {
      const p = el.dataset.p, b = st.profiles[p].birth;
      if (!b.date) return toast('먼저 생년월일을 입력해 주세요');
      const r = S.calc(b.date, b.unknown ? null : (b.time || null), b.correct);
      st.profiles[p].manual = { year: r.raw.year, month: r.raw.month, day: r.raw.day, hour: r.raw.hour };
      st.profiles[p].ts = now(); save(); render(); toast('복사했어요. 다른 글자가 있으면 고쳐 주세요');
    },
    loveWho: (el) => { sub.love.who = el.dataset.p; render(); },
    llAns: (el) => {
      const p = el.dataset.p, r = st.ll[p]; r.answers[Number(el.dataset.i)] = Number(el.dataset.a); r.ts = now();
      if (r.answers.every(a => a != null)) r.done = true;
      save(); render();
    },
    llBack: (el) => { const r = st.ll[el.dataset.p]; const i = r.answers.findIndex(a => a == null); const j = (i < 0 ? r.answers.length : i) - 1; if (j >= 0) r.answers[j] = null; r.ts = now(); save(); render(); },
    llReset: (el) => { if (!confirm('사랑의 언어 테스트를 다시 할까요?')) return; st.ll[el.dataset.p] = { answers: Array(D.LOVE_Q.length).fill(null), done: false, memo: (st.ll[el.dataset.p] || {}).memo || '', ts: now() }; save(); render(); },
    toolOpen: (el) => { sub.tools.open = el.dataset.k || null; render(); window.scrollTo(0, 0); },
    sign: (el) => { st.pledge[el.dataset.p] = { date: ymd(), ts: now() }; save(); render(); toast('서명 완료! 개굴씨가 증인이야 🐸'); },
    resign: () => { P.forEach(p => { st.pledge[p] = null; }); save(); render(); },
    addCustom: () => { const i = $('#customIn'); const t = i.value.trim(); if (!t) return; st.pledge.custom.push(t); save(); render(); },
    delCustom: (el) => { st.pledge.custom.splice(Number(el.dataset.i), 1); save(); render(); },
    buyAdd: () => {
      const what = $('#buyWhat').value.trim(); if (!what) return toast('무엇을 샀는지/사고 싶은지 적어 주세요');
      st.money.log.push({ id: uid(), by: me(), at: now(), what, price: $('#buyPrice').value, kind: $('#buyKind').value, why: $('#buyWhy').value.trim(), reply: '' });
      save(); render(); toast('공유했어요. 먼저 말해 준 것만으로 멋져요!');
    },
    buyReply: (el) => { const x = st.money.log.find(y => y.id === el.dataset.id); if (x) { x.reply = el.dataset.r; save(); render(); } },
    exportCode: () => { const o = Object.assign({}, st); delete o.me; delete o.theme; $('#codeOut').value = encode(o); toast('코드를 만들었어요'); },
    copyCode: async () => { const v = $('#codeOut').value; if (!v) return toast('먼저 코드를 만들어 주세요'); try { await navigator.clipboard.writeText(v); toast('복사했어요'); } catch (e) { $('#codeOut').select(); document.execCommand('copy'); toast('복사했어요'); } },
    shareCode: async () => { const v = $('#codeOut').value; if (!v) return toast('먼저 코드를 만들어 주세요'); if (navigator.share) { try { await navigator.share({ title: '개굴씨 기록 코드', text: v }); } catch (e) { /* 취소 */ } } else acts.copyCode(); },
    importCode: () => { try { merge(decode($('#codeIn').value)); toast('기록을 합쳤어요!'); render(); } catch (e) { toast('코드를 읽을 수 없어요: ' + e.message); } },
    saveStart: () => { const v = $('#startIn').value; if (v) { st.startDate = v; save(); toast('시작일을 저장했어요'); } },
    theme: (el) => { st.theme = el.dataset.v; applyTheme(); save(); render(); },
    reset: () => { if (confirm('정말 모든 기록을 지울까요? 되돌릴 수 없어요.')) { localStorage.removeItem(KEY); st = blank(); render(); onboard(); } },
    pickMe: (el) => { st.me = el.dataset.p; save(); closeSheet(); render(); },
    obDone: () => {
      [['h', '#obH'], ['w', '#obW']].forEach(([p, id]) => { const v = $(id).value.trim(); if (v) { st.profiles[p].name = v; st.profiles[p].ts = now(); } });
      st.startDate = $('#obStart').value || ymd();
      st.me = document.querySelector('input[name=obMe]:checked').value;
      save(); closeSheet(); render();
    }
  };

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]'); if (t) { if (t.dataset.tab === 'program') sub.program = {}; if (t.dataset.tab === 'tools') sub.tools = { open: null }; go(t.dataset.tab); return; }
    const a = e.target.closest('[data-act]'); if (a && acts[a.dataset.act]) { e.preventDefault(); acts[a.dataset.act](a); }
  });
  $('#sheetBg').addEventListener('click', closeSheet);
  $('#timeoutFab').addEventListener('click', openTimeout);
  $('#whoBtn').addEventListener('click', () => {
    openSheet(`<div style="text-align:center">${frog('happy', 80)}<h1>지금 누가 쓰고 있나요?</h1></div>
      <div class="grid2">${P.map(p => `<button class="btn ${me() === p ? 'primary' : ''}" style="min-height:64px" data-act="pickMe" data-p="${p}"><span class="dot ${p}"></span>${esc(name(p))}</button>`).join('')}</div>
      <p class="tiny" style="text-align:center;margin-top:10px">일지와 지킴이는 사용 중인 사람의 이름으로 기록돼요.</p>`);
  });

  // 입력 저장 (input/change 위임)
  function onInput(e) {
    const el = e.target, p = me();
    if (el.dataset.daily) { const r = dailyRec(ymd(), p); r[el.dataset.daily] = el.checked; r.ts = now(); save(); if (D.DAILY.every(x => r[x.id])) toast('오늘 약속을 전부 지켰어요! 개굴~ 🎉'); return; }
    if (el.dataset.note) { const n = sub.program.day, r = dayRec(n, p); r.notes[el.dataset.note] = el.value; r.ts = now(); save(); return; }
    if (el.dataset.moodk) { const n = sub.program.day, r = dayRec(n, p); r[el.dataset.moodk] = Number(el.value); r.ts = now(); $('#v-' + el.dataset.moodk).textContent = el.value; save(); return; }
    if (el.dataset.llmemo) { const r = st.ll[el.dataset.llmemo]; r.memo = el.value; r.ts = now(); save(); return; }
    if (el.dataset.rule) { st.money.rules[el.dataset.rule] = el.type === 'number' ? Number(el.value) : el.value; st.money.rules.ts = now(); save(); return; }
    if (el.dataset.name) { st.profiles[el.dataset.name].name = el.value.trim() || (el.dataset.name === 'h' ? '남편' : '아내'); st.profiles[el.dataset.name].ts = now(); save(); if (e.type === 'change') render(); return; }
    if (e.type !== 'change') return;
    const sp = sub.saju && sub.saju.who;
    if (el.dataset.birth && (sp === 'h' || sp === 'w')) {
      const b = st.profiles[sp].birth, k = el.dataset.birth;
      b[k] = el.type === 'checkbox' ? el.checked : el.value; st.profiles[sp].ts = now(); save(); render(); return;
    }
    if (el.dataset.actChange === 'useManual' && (sp === 'h' || sp === 'w')) {
      const pr = st.profiles[sp]; pr.useManual = el.checked;
      if (el.checked && !pr.manual) pr.manual = { year: null, month: null, day: null, hour: null };
      pr.ts = now(); save(); render(); return;
    }
    if (el.dataset.manual && (sp === 'h' || sp === 'w')) {
      const pr = st.profiles[sp]; const [pk, kind] = el.dataset.manual.split('.');
      pr.manual = pr.manual || {}; const cur = pr.manual[pk] || { s: null, b: null };
      cur[kind] = el.value === '' ? null : Number(el.value); pr.manual[pk] = cur;
      pr.ts = now(); save(); render();
    }
  }
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);


  function applyTheme() {
    if (st.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', st.theme);
  }

  function onboard() {
    openSheet(`<div style="text-align:center">${frog('cheer', 110)}<h1>안녕! 나는 개굴씨야</h1>
      <p class="muted">둘이 같은 편이 되는 30일, 내가 매일 옆에서 도와줄게.</p></div>
      <div class="grid2"><label class="field"><span>남편 호칭</span><input type="text" id="obH" placeholder="남편" maxlength="12"></label>
      <label class="field"><span>아내 호칭</span><input type="text" id="obW" placeholder="아내" maxlength="12"></label></div>
      <label class="field"><span>30일 과정 시작일</span><input type="date" id="obStart" value="${ymd()}"></label>
      <p class="small" style="font-weight:700;margin-bottom:4px">이 폰은 누가 주로 쓰나요?</p>
      <div class="grid2"><label class="check"><input type="radio" name="obMe" value="h" checked><span>남편</span></label><label class="check"><input type="radio" name="obMe" value="w"><span>아내</span></label></div>
      <div class="card soft small" style="margin-top:10px">모든 기록은 이 폰 안에만 저장돼요. 각자 폰에 설치했다면 도구 → 동기화로 기록을 합칠 수 있어요.</div>
      <button class="btn primary block" data-act="obDone">시작하기</button>`);
  }

  // 시작
  applyTheme();
  render();
  if (!st.me) onboard();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.Capacitor) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
