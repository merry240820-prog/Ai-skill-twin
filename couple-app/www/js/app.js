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
      rules3: { h: null, w: null },
      plan: {},
      goals: {},
      baby: { birth: '', ts: 0 },
      short: false,
      epds: [],
      signs: { checked: {}, ts: 0 },
      voice: { on: true, rate: 0.92, pitch: 1.02, voice: null, auto: true, breath: true },
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
        rules3: Object.assign(b.rules3, s.rules3),
        voice: Object.assign(b.voice, s.voice),
        baby: Object.assign(b.baby, s.baby),
        signs: Object.assign(b.signs, s.signs),
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

  // 🔊 낭독 버튼: 렌더할 때마다 문장을 등록하고 번호로 부른다
  let sayReg = [];
  function sayBtn(text, label) {
    if (!window.Voice || !Voice.available()) return '';
    const i = sayReg.push(text) - 1;
    return `<button class="say" data-act="say" data-i="${i}" aria-label="소리로 듣기">🔊${label ? ' ' + label : ''}</button>`;
  }
  let sayingBtn = null;
  function say(text, btn, opts) {
    if (!window.Voice) return;
    if (btn && btn === sayingBtn && Voice.speaking) { Voice.stop(); return; }
    $$('.say.on').forEach(b => b.classList.remove('on'));
    sayingBtn = btn || null; if (btn) btn.classList.add('on');
    Voice.speak(text, Object.assign({ force: !!btn }, opts || {}));
  }
  function narrate(text, opts) { if (window.Voice && st.voice.on) say(text, null, opts); }

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

  function frame() { return st.short ? D.STEP_FRAME_SHORT : D.STEP_FRAME; }
  const totalMin = () => frame().reduce((a, x) => a + x.m, 0);
  function babyDays() { if (!st.baby.birth) return null; return Math.floor((parseYmd(ymd()) - parseYmd(st.baby.birth)) / DAY_MS) + 1; }
  function lastEpds() { return st.epds.slice().sort((a, b) => b.at - a.at)[0] || null; }

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
    sayReg = []; sayingBtn = null;
    const v = $('#view');
    v.innerHTML = ({ home: viewHome, program: viewProgram, mom: viewMom, love: viewLove, tools: viewTools })[tab]();
    afterRender();
  }
  function afterRender() { if (session.day && tab === 'program' && sub.program && sub.program.day === session.day) paintSession(); }

  // ───────────────────────── 홈
  function together() {
    if (!st.startDate) return 1;
    return Math.max(1, Math.floor((parseYmd(ymd()) - parseYmd(st.startDate)) / DAY_MS) + 1);
  }
  // 오늘 내가 상대에게 줄 사랑 미션 (상대의 사랑의 언어 기반)
  function missionFor(p, date = ymd()) {
    const o = other(p), r = st.ll[o];
    let list = D.MISSIONS, lang = null;
    if (r && r.done) { const res = llResult(r.answers); lang = res.order[0]; list = [...D.LOVE[res.order[0]].tips, ...D.LOVE[res.order[1]].tips]; }
    const dn = Math.floor(parseYmd(date) / DAY_MS) + (p === 'h' ? 0 : 3);
    return { text: list[dn % list.length], lang };
  }
  function letterHtml(m) {
    const mine = m.from === me();
    return `<div class="letter from-${m.from}"><div class="meta"><span class="dot ${m.from}"></span>${esc(name(m.from))} → ${esc(name(other(m.from)))} · ${fmtDate(m.at)}<span class="grow"></span>
      ${!mine ? sayBtn(`${name(m.from)}의 편지입니다. ${m.text}`) : ''}</div>
      <div class="body">${esc(m.text)}</div>
      ${mine ? (m.heart ? '<span class="tiny">💗 ' + esc(name(other(m.from))) + '가 마음을 받았어요</span>' : '<span class="tiny">아직 읽지 않았어요</span>')
        : `<button class="heartbtn" data-act="heart" data-id="${m.id}" aria-label="마음 받기">${m.heart ? '💗' : '🤍'}</button><span class="tiny">${m.heart ? '마음 받았어요' : '눌러서 마음 받기'}</span>`}</div>`;
  }
  function mailboxHtml(limit) {
    const o = other(me()), msgs = st.messages.slice().reverse().slice(0, limit || 50);
    return `<div class="card">
      <div class="tpls">${D.LOVE_TEMPLATES.map(t => `<button data-act="tpl" data-t="${esc(t)}">${esc(t.replace('___', '…'))}</button>`).join('')}</div>
      <textarea id="msgIn" placeholder="${esc(name(o))}에게 고마움, 칭찬, 응원, 사과를 남겨요" maxlength="500" style="min-height:64px"></textarea>
      <button class="btn primary block" style="margin-top:8px" data-act="sendMsg">💌 ${esc(name(o))}에게 보내기</button>
      <div style="margin-top:12px">${msgs.length ? msgs.map(letterHtml).join('') : '<p class="tiny">아직 편지가 없어요. 오늘 고마웠던 한 가지부터 시작해 볼까요?</p>'}</div>
    </div>`;
  }
  function viewHome() {
    const p = me(), o = other(p), n = currentDay(), day = D.DAYS[n - 1];
    const today = ymd();
    const r = dailyRec(today, p), ro = (st.daily[today] && st.daily[today][o]) || {};
    const kept = D.DAILY.filter(x => r[x.id]).length, keptO = D.DAILY.filter(x => ro[x.id]).length;
    const doneBoth = Object.keys(st.days).filter(k => isDone(k, 'h') && isDone(k, 'w')).length;
    const unread = st.messages.filter(m => m.from === o && !m.heart).length;
    const greet = kept >= 6 ? ['cheer', `와, 오늘 약속을 ${kept}개나 지켰어! 정말 잘하고 있어.`]
      : isDone(n, p) ? ['love', `오늘 과정 완료! ${name(o)}에게 고마운 점 하나 편지로 남겨 볼까?`]
        : ['happy', `안녕, ${name(p)}! 오늘은 Day ${n}, "${day.t}" 차례야. 둘이 30분, 같은 편이 되어 앉아 보자.`];
    const ms = missionFor(p), md = !!r.mission;
    const bank = weekStats(weekOf(today));
    return `
      <div class="hero">
        <div class="couple"><span class="dot h"></span>${esc(name('h'))} <span class="heart">♥</span> <span class="dot w"></span>${esc(name('w'))}<span class="dcount">함께 노력한 지 ${together()}일째</span></div>
        <div class="speech">${frog(greet[0], 70)}<div class="bubble">${esc(greet[1])}</div>${sayBtn(greet[1])}</div>
      </div>
      ${rulesBanner()}
      ${momCard()}

      <div class="card">
        <div class="row"><span class="chip">${day.w}주차 · ${esc(D.WEEKS[day.w - 1].t)}</span><span class="grow"></span>
          <span class="chip ${isDone(n, 'h') ? 'ok' : ''}"><span class="dot h"></span>${esc(name('h'))}</span>
          <span class="chip ${isDone(n, 'w') ? 'ok' : ''}"><span class="dot w"></span>${esc(name('w'))}</span></div>
        <h1>Day ${n}. ${esc(day.t)}</h1>
        <p class="muted small">오늘의 약속 · ${esc(day.promise)}</p>
        <button class="btn primary block" data-act="openDay" data-n="${n}">오늘 30분 과정 시작하기 →</button>
        <div class="progress" style="margin-top:12px" aria-label="30일 진행률"><i style="width:${Math.round(doneBoth / 30 * 100)}%"></i></div>
        <p class="tiny" style="margin:4px 0 0">둘 다 완료한 날 ${doneBoth}/30 · ${esc(name(p))} 약속 연속 ${streak(p)}일</p>
      </div>

      <div class="card ${md ? 'leaf' : ''}">
        <div class="titlerow"><h3>💗 오늘 ${esc(name(o))}에게 줄 사랑</h3>${sayBtn('오늘의 사랑 미션. ' + ms.text)}</div>
        <div class="mission ${md ? 'done' : ''}"><span class="big">${ms.lang ? D.LOVE[ms.lang].e : '🎁'}</span>
          <div class="grow"><div class="mt" style="font-weight:700">${esc(ms.text)}</div>
          <div class="tiny">${ms.lang ? `${esc(name(o))}의 사랑의 언어: ${D.LOVE[ms.lang].t}` : `사랑의 언어 테스트를 하면 ${esc(name(o))}에게 꼭 맞는 미션이 나와요`}</div></div></div>
        <button class="btn ${md ? '' : 'primary'} block" style="margin-top:10px" data-act="mission">${md ? '✓ 오늘 사랑 전했어요' : '했어요! 체크하기'}</button>
      </div>

      <div class="card">
        <div class="titlerow"><h3>이번 주 감정 통장</h3><button class="btn ghost small" data-act="goWeekly">자세히</button></div>
        <div class="bank"><i class="pos" style="width:${bank.posPct}%"></i><i class="neg" style="width:${bank.negPct}%"></i></div>
        <p class="small" style="margin:0">좋은 일 <b>${bank.pos}</b> : 아픈 일 <b>${bank.neg}</b> ${bank.neg ? `(${(bank.pos / bank.neg).toFixed(1)} : 1)` : ''} · 목표 5 : 1</p>
      </div>

      <h2>오늘의 지킴이 <span class="tiny">${esc(name(p))} · ${today}</span></h2>
      <div class="card">
        ${D.DAILY.map(x => `<label class="check"><input type="checkbox" data-daily="${x.id}" ${r[x.id] ? 'checked' : ''}><span>${esc(x.t)}</span></label>`).join('')}
        <p class="tiny" style="margin-top:8px">${esc(name(o))}는 오늘 ${keptO}/${D.DAILY.length}개 체크했어요. 자기 전에 각자 솔직하게. 상대 체크에 토 달기 금지!</p>
      </div>

      <h2>💌 사랑 우체통 ${unread ? `<span class="chip ok">새 편지 ${unread}</span>` : ''}</h2>
      ${mailboxHtml(4)}

      <div class="card danger small">
        <b>안전이 먼저예요.</b> 몸을 다치거나 위협을 느낀다면 이 앱으로 해결하려 하지 말고 바로 도움을 요청하세요.
        <div class="row" style="margin-top:8px">${D.SAFETY.slice(0, 2).map(x => `<a class="btn" href="tel:${x.n}">${x.n}</a>`).join('')}<button class="btn ghost" data-act="safety">더 보기</button></div>
      </div>`;
  }

  function rulesBanner() {
    const both = st.rules3.h && st.rules3.w;
    if (both) {
      return `<button class="card gold" style="width:100%;text-align:left" data-act="toolGo" data-k="rules"><b>우리 3대 규칙</b> <span class="chip ok">둘 다 합의</span><br>
        <span class="small">${D.RULES3.map((r, i) => `${i + 1}. ${esc(r.t)}`).join(' · ')}</span></button>`;
    }
    return `<div class="card warm"><b>먼저, 우리 3대 규칙에 합의해요</b>
      <p class="small" style="margin:4px 0 8px">욕설·협박 0회 · 동의 없는 신체접촉 0회 · "멈춤" = 10분 분리. 이 세 가지가 지켜져야 대화 연습이 의미가 있어요.</p>
      <button class="btn warm block" data-act="toolGo" data-k="rules">3대 규칙 읽고 서명하기</button></div>`;
  }

  // ───────────────────────── 30일 과정
  function viewProgram() {
    const sp = sub.program || (sub.program = {});
    if (sp.day) return viewDay(sp.day);
    const mode = sp.mode || 'road';
    const seg = `<div class="seg">${[['road', '개선 로드맵'], ['days', '30일 과정'], ['week', '주간 점검']].map(([k, t]) => `<button class="${mode === k ? 'on' : ''}" data-act="progMode" data-k="${k}">${t}</button>`).join('')}</div>`;
    const body = mode === 'days' ? programDays() : mode === 'week' ? viewWeekly() : viewRoadmap();
    return `<h1>우리의 개선 과정</h1>${seg}${body}`;
  }
  function programDays() {
    const cur = currentDay();
    return `
      <p class="muted small">매일 ${totalMin()}분 · ${frame().map(x => `${x.t} ${x.m}분`).join(' → ')}. 각 단계는 아나운서 음성으로 안내돼요.</p>
      <label class="switch"><span class="small"><b>👶 신생아 모드 (하루 10분)</b><br><span class="tiny">출산 후 100일까지는 짧게 해도 충분해요. 꾸준함이 길이보다 중요해요.</span></span><input type="checkbox" data-short="1" ${st.short ? 'checked' : ''}></label>
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
      <p class="tiny" style="margin-top:14px">진한 색: 둘 다 완료 · 연한 색: 한 명만 완료</p>`;
  }

  // 로드맵
  function planDone(it) {
    if (it.auto === 'rules3') return !!(st.rules3.h && st.rules3.w);
    if (it.auto === 'epds') { const l = lastEpds(); return !!(l && now() - l.at < 15 * DAY_MS); }
    if (it.auto === 'll') return !!(st.ll.h && st.ll.h.done && st.ll.w && st.ll.w.done);
    return !!(st.plan[it.id] && st.plan[it.id].done);
  }
  function viewRoadmap() {
    const cur = currentDay();
    const nowIdx = !(st.rules3.h && st.rules3.w) ? 0 : cur <= 7 ? 1 : cur <= 14 ? 2 : cur <= 21 ? 3 : cur <= 28 ? 4 : 5;
    return `
      <div class="speech card soft" style="margin-bottom:16px">${frog('calm', 56)}<div class="bubble small">순서가 중요해. 먼저 안전, 그다음 멈추기, 듣기, 탓 대신 나, 그리고 사랑 채우기. 한 단계씩 같이 올라가자.</div></div>
      ${D.ROADMAP.map((st0, i) => {
        const done = st0.items.filter(planDone).length, all = st0.items.length;
        const cls = i === nowIdx ? 'now' : done === all ? 'clear' : '';
        return `<div class="stage ${cls}"><div class="badge">${done === all ? '✓' : st0.icon}</div>
          <div class="card">
            <div class="titlerow"><div><span class="tiny">${i}단계 · ${esc(st0.when)}${i === nowIdx ? ' · <b style="color:var(--accent)">지금 여기</b>' : ''}</span><h3 style="margin:2px 0 0">${esc(st0.t)}</h3></div>${sayBtn(`${i}단계, ${st0.t}. ${st0.goal} ${st0.why} 할 일은, ${st0.items.map(x => x.t).join('. ')}. 확인 기준은, ${st0.measure}.`)}</div>
            <p class="small" style="margin:6px 0 2px"><b>${esc(st0.goal)}</b></p>
            <p class="small muted">${esc(st0.why)}</p>
            ${st0.items.map(it => `<label class="check"><input type="checkbox" data-plan="${it.id}" ${planDone(it) ? 'checked' : ''} ${it.auto ? 'disabled' : ''}><span class="small">${esc(it.t)}${it.auto ? ' <span class="tiny">(자동 체크)</span>' : ''}</span></label>`).join('')}
            <p class="tiny" style="margin:8px 0 0">📏 확인 기준 · ${esc(st0.measure)}</p>
          </div></div>`;
      }).join('')}
      <h2>2~4주 뒤, 이렇게 판단해요</h2>
      ${D.DECISION.map(x => `<div class="verdict ${x.c}"><b>${esc(x.t)}</b><br>${esc(x.d)}</div>`).join('')}
      <p class="tiny" style="margin-top:10px">판단은 감이 아니라 [주간 점검]의 숫자로 해요.</p>`;
  }

  // 주간 점검
  function weekOf(date) {
    if (!st.startDate) return 1;
    return Math.max(1, Math.floor((parseYmd(date) - parseYmd(st.startDate)) / DAY_MS / 7) + 1);
  }
  function weekDates(w) {
    const base = st.startDate ? parseYmd(st.startDate) : parseYmd(ymd());
    return Array.from({ length: 7 }, (_, i) => ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() + (w - 1) * 7 + i)));
  }
  function personWeek(p, w) {
    const dates = weekDates(w), today = ymd();
    const recs = dates.filter(d => d <= today).map(d => st.daily[d] && st.daily[d][p]).filter(r => r && r.ts);
    const cnt = (id) => recs.filter(r => r[id]).length;
    const miss = (id) => recs.filter(r => !r[id]).length;
    const dayNums = Array.from({ length: 7 }, (_, i) => (w - 1) * 7 + i + 1).filter(n => n <= 30);
    const moods = dayNums.map(n => st.days[n] && st.days[n][p]).filter(Boolean);
    const avg = (k) => { const v = moods.map(m => m[k]).filter(x => x != null); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '-'; };
    const sent = st.messages.filter(m => m.from === p && dates.includes(ymd(new Date(m.at)))).length;
    return {
      filled: recs.length, curse: miss('noCurse'), touch: miss('noTouch'), brk: miss('noBreak'),
      listen: cnt('listen'), noBlame: cnt('noBlame'), love: cnt('love'), mission: recs.filter(r => r.mission).length,
      sent, before: avg('before'), after: avg('after'), done: dayNums.filter(n => isDone(n, p)).length
    };
  }
  function weekStats(w) {
    const a = personWeek('h', w), b = personWeek('w', w);
    const pos = [a, b].reduce((t, x) => t + x.listen + x.noBlame + x.love + x.mission + x.sent + x.done, 0);
    const neg = [a, b].reduce((t, x) => t + x.curse + x.touch + x.brk, 0);
    const posPct = pos + neg ? Math.round(pos / (pos + neg) * 100) : 0;
    const negPct = pos + neg ? 100 - posPct : 0;
    return { h: a, w: b, pos, neg, posPct, negPct };
  }
  function viewWeekly() {
    const curW = weekOf(ymd()), sp = sub.program;
    const w = sp.week || curW;
    const s = weekStats(w), viol = s.h.curse + s.h.touch + s.w.curse + s.w.touch;
    const filled = s.h.filled + s.w.filled;
    const verdict = !filled ? ['warn', '아직 이번 주 지킴이 기록이 없어요. 매일 밤 각자 체크해야 점검이 정확해져요.']
      : viol >= 2 ? ['stop', `이번 주 욕설·협박 또는 동의 없는 신체접촉 체크가 ${viol}번 빠졌어요. 3대 규칙의 약속대로, 둘 중 누구라도 전문 개입 상담을 요청할 수 있어요. 혼자 견디지 마세요.`]
        : viol === 1 ? ['warn', '규칙이 한 번 흔들렸어요. 24시간 안의 사과가 있었는지 확인하고, 다음 주엔 0을 목표로 해요.']
          : s.neg === 0 ? ['ok', '이번 주 아픈 일 0! 정말 큰 변화예요. 서로에게 꼭 말로 칭찬해 주세요.'] : ['ok', '3대 규칙을 지켰어요. 이제 듣기와 사랑 표현을 조금씩 늘려 봐요.'];
    const col = (p, x) => `<div class="card"><div class="titlerow"><h3><span class="dot ${p}"></span> ${esc(name(p))}</h3><span class="tiny">기록 ${x.filled}/7일</span></div>
      <div class="kpi">
        <div><b style="color:${x.curse ? 'var(--danger)' : 'var(--leaf)'}">${x.curse}</b><span>욕설·협박 체크 빠짐</span></div>
        <div><b style="color:${x.touch ? 'var(--danger)' : 'var(--leaf)'}">${x.touch}</b><span>신체접촉 체크 빠짐</span></div>
        <div><b>${x.done}</b><span>과정 완료</span></div>
        <div><b>${x.listen}</b><span>끝까지 듣기</span></div>
        <div><b>${x.mission + x.love}</b><span>사랑 표현·미션</span></div>
        <div><b>${x.sent}</b><span>보낸 편지</span></div>
      </div>
      <p class="small" style="margin:8px 0 0">마음 온도 평균 ${x.before} → ${x.after}</p>
      <label class="field" style="margin:10px 0 0"><span>다음 주 ${esc(name(p))}의 한 가지 목표</span><input type="text" data-goal="${w}.${p}" value="${esc((st.goals[w] && st.goals[w][p] && st.goals[w][p].text) || '')}" placeholder="예: 화나면 소리 대신 '멈춤' 말하기"></label></div>`;
    return `
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <button class="btn ghost" data-act="week" data-w="${w - 1}" ${w <= 1 ? 'disabled' : ''}>← 이전</button><b>${w}주차 <span class="tiny">${weekDates(w)[0].slice(5)} ~ ${weekDates(w)[6].slice(5)}</span></b>
        <button class="btn ghost" data-act="week" data-w="${w + 1}" ${w >= curW ? 'disabled' : ''}>다음 →</button></div>
      <div class="card">
        <div class="titlerow"><h3>감정 통장</h3>${sayBtn(`${w}주차 점검입니다. 좋은 일 ${s.pos}, 아픈 일 ${s.neg}. ${verdict[1]}`)}</div>
        <div class="bank"><i class="pos" style="width:${s.posPct}%"></i><i class="neg" style="width:${s.negPct}%"></i></div>
        <p class="small" style="margin:0">좋은 일 <b>${s.pos}</b> : 아픈 일 <b>${s.neg}</b> · 목표 5 : 1 이상</p>
        <div class="verdict ${verdict[0]}">${esc(verdict[1])}</div>
      </div>
      ${col('h', s.h)}${col('w', s.w)}
      <p class="tiny">"체크 빠짐"은 그날 지킴이를 기록했지만 그 항목을 체크하지 않은 날 수예요. 각자 폰을 쓰면 동기화한 뒤에 봐야 정확해요.</p>`;
  }

  // 세션 타이머 (메모리)
  const session = { day: null, idx: 0, left: 0, running: false, iv: null };
  function sessionSteps() { return frame(); }
  function stepNarration(n, i) {
    const d = D.DAYS[n - 1], s = frame()[i];
    const body = { checkin: '', learn: d.learn, practice: d.ex, close: '오늘의 약속. ' + d.promise }[s.k];
    return [`${i + 1}단계, ${s.t}. ${s.m}분입니다.`, s.d, body];
  }
  function startSession(n) {
    const fresh = session.day !== n || (session.idx === 0 && session.left === frame()[0].m * 60);
    if (session.day !== n) { session.day = n; session.idx = 0; session.left = frame()[0].m * 60; }
    if (fresh && st.voice.auto) narrate([`${n}일차, ${D.DAYS[n - 1].t}. 지금부터 ${totalMin()}분 과정을 시작할게요.`, ...stepNarration(n, 0)]);
    session.running = true; clearInterval(session.iv);
    session.iv = setInterval(tick, 1000); paintSession();
  }
  function pauseSession() { session.running = false; clearInterval(session.iv); paintSession(); }
  function nextStep() {
    if (session.idx < frame().length - 1) {
      session.idx++; session.left = frame()[session.idx].m * 60;
      if (st.voice.auto) narrate(stepNarration(session.day, session.idx));
    } else {
      session.left = 0; pauseSession(); toast('오늘 과정 끝! 일지를 적고 완료를 눌러주세요.');
      if (st.voice.auto) narrate('오늘 과정이 모두 끝났어요. 오늘도 같은 편이 되어 준 서로에게 고맙다고 말해 주세요. 그리고 일지를 적고 완료를 눌러 주세요.');
    }
    paintSession();
  }
  function tick() {
    if (!session.running) return;
    session.left--;
    if (session.left <= 0) { beep(session.idx === frame().length - 1 ? 3 : 2); nextStep(); return; }
    paintSession();
  }
  function paintSession() {
    const box = $('#sessBox'); if (!box || !sub.program || sub.program.day !== session.day) return;
    const s = frame()[session.idx];
    const total = frame().reduce((a, x) => a + x.m * 60, 0);
    const passed = frame().slice(0, session.idx).reduce((a, x) => a + x.m * 60, 0) + (s.m * 60 - session.left);
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
      checkin: '', learn: `<div class="card soft small" style="margin:8px 0 0"><div class="titlerow"><span>${esc(d.learn)}</span>${sayBtn(d.learn)}</div></div>`,
      practice: `<div class="card small pre" style="margin:8px 0 0"><div class="titlerow"><span>${esc(d.ex)}</span>${sayBtn(d.ex)}</div></div>
        <div class="row small" style="margin-top:6px"><span class="tiny">말하기 타이머</span>${[1, 2, 3].map(m => `<button class="btn ghost" data-act="miniTimer" data-m="${m}">${m}분</button>`).join('')}</div>`,
      close: `<div class="card gold small" style="margin:8px 0 0"><div class="titlerow"><span><b>오늘의 약속</b><br>${esc(d.promise)}</span>${sayBtn('오늘의 약속. ' + d.promise)}</div></div>`
    })[k];
    const mood = (key, label) => `<label class="field"><span>${label}: <b id="v-${key}">${r[key] == null ? '-' : r[key]}</b>/10</span>
      <input type="range" min="0" max="10" value="${r[key] == null ? 5 : r[key]}" data-moodk="${key}" style="width:100%;accent-color:var(--accent)"></label>`;
    return `
      <div class="row"><button class="btn ghost" data-act="backProgram">← 30일 목록</button><span class="grow"></span>${sayBtn([`${n}일차, ${d.t}.`, d.frog, '오늘 배울 내용입니다.', d.learn, '함께 연습해 볼게요.', d.ex, '오늘의 약속.', d.promise], '전체 듣기')}</div>
      <p class="tiny" style="margin:12px 0 0">${d.w}주차 · ${esc(D.WEEKS[d.w - 1].t)}</p>
      <h1>Day ${n}. ${esc(d.t)}</h1>
      <div class="speech" style="margin-bottom:12px">${frog(n === 30 ? 'cheer' : 'happy', 64)}<div class="bubble">${esc(d.frog)}</div>${sayBtn(d.frog)}</div>

      <label class="switch" style="border:0;padding:0 0 8px"><span class="small"><b>👶 신생아 모드 (하루 10분)</b> · 아기를 안고도 할 수 있게 짧게</span><input type="checkbox" data-short="1" ${st.short ? 'checked' : ''}></label>
      <div class="card" id="sessBox">
        <div class="row"><b id="sessStep">${active ? '' : '1/4 · ' + frame()[0].t}</b><span class="grow"></span><span class="tiny">총 ${totalMin()}분 · ${st.voice.auto ? '🔊 단계 음성 안내 켜짐' : '음성 안내 꺼짐'}</span></div>
        <div class="timer" id="sessTime">${active ? '' : fmtTime(frame()[0].m * 60)}</div>
        <div class="progress"><i id="sessBar" style="width:0"></i></div>
        <div class="row" style="margin-top:10px"><button class="btn primary grow" id="sessToggle" data-act="sessToggle" data-n="${n}">시작</button><button class="btn" data-act="sessNext" data-n="${n}">다음 단계 →</button></div>
      </div>

      <div class="card steps">
        ${frame().map((s, i) => `<div class="step"><div class="n">${i + 1}</div><div class="grow">
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

  // ───────────────────────── 산후 케어
  function epdsLevel(r) {
    if (r.urgent) return ['stop', '긴급', '스스로를 해치고 싶은 생각이 있었다고 답했어요. 점수와 상관없이 오늘 바로 도움을 받아야 해요. 109(24시간) 또는 1577-0199에 전화하고, 혼자 있지 않게 해 주세요.'];
    if (r.score >= 13) return ['stop', '높음', '산후우울증 가능성이 높아요. 이번 주 안에 보건소·정신건강복지센터·병원 상담을 받아 주세요. 치료하면 좋아지는 병이에요.'];
    if (r.score >= 10) return ['warn', '주의', '산후우울 가능성이 있어요. 보건소에서 무료 상담을 받아 보고, 2주 뒤 다시 점검해요. 잠과 휴식을 최우선으로.'];
    return ['ok', '양호', '지금은 비교적 괜찮아요. 출산 후 1년까지는 언제든 달라질 수 있으니 2주마다 점검해요.'];
  }
  function momCard() {
    const bd = babyDays(), l = lastEpds(), p = me();
    const r = dailyRec(ymd(), 'h'), care = D.CARE.filter(c => r['care_' + c.id]).length;
    const due = !l || now() - l.at > 14 * DAY_MS;
    if (!bd) return `<button class="card leaf" style="width:100%;text-align:left" data-act="goMom"><b>🤱 산후 케어</b><br><span class="small">막내 출생일을 넣으면 회복 단계에 맞춰 도와드려요.</span></button>`;
    return `<div class="card leaf">
      <div class="titlerow"><h3>🤱 막내 태어난 지 ${bd}일째</h3><button class="btn ghost small" data-act="goMom">산후 케어 ›</button></div>
      <p class="small" style="margin:4px 0 8px">${bd <= 14 ? '산후 2주 안쪽: 감정 기복(베이비 블루스)이 흔한 시기예요.' : bd <= 56 ? '산후 회복기(6~8주): 2주가 지나도 우울·짜증이 이어지면 산후우울증을 점검할 때예요.' : '출산 후 1년까지는 산후우울이 올 수 있어요. 2주마다 마음 점검을 이어가요.'}</p>
      <div class="row small"><span class="chip ${care >= 4 ? 'ok' : ''}">${esc(name('h'))}의 오늘 돌봄 ${care}/${D.CARE.length}</span>
        <span class="chip ${l && !due ? 'ok' : ''}">${l ? `마음 점검 ${fmtDate(l.at).split(' ')[0]} · ${epdsLevel(l)[1]}` : '마음 점검 전'}</span></div>
      ${due ? `<button class="btn primary block" style="margin-top:10px" data-act="goMom" data-k="check">${esc(name('w'))}의 마음 점검하기 (2분)</button>` : ''}
    </div>`;
  }
  function viewMom() {
    const sm = sub.mom || (sub.mom = { k: me() === 'h' ? 'care' : 'check' });
    const segs = [['check', '마음 점검'], ['care', '남편 돌봄'], ['clear', '또렷하게'], ['know', '알아두기']];
    const seg = `<div class="seg">${segs.map(([k, t]) => `<button class="${sm.k === k ? 'on' : ''}" data-act="momSeg" data-k="${k}">${t}</button>`).join('')}</div>`;
    const bd = babyDays();
    const emergency = `<div class="card danger small"><b>바로 도움이 필요할 때</b> — 스스로나 아기를 해칠 것 같은 생각, 환청·혼란, 며칠째 전혀 못 잠.<br>혼자 두지 말고 바로 연락하세요.
      <div class="row" style="margin-top:8px"><a class="btn" href="tel:109">109</a><a class="btn" href="tel:15770199">1577-0199</a><a class="btn" href="tel:119">119</a></div></div>`;
    const body = { check: momCheck, care: momCare, clear: momClear, know: momKnow }[sm.k]();
    return `<h1>🤱 산후 케어</h1>
      <div class="card"><div class="grid2">
        <label class="field" style="margin:0"><span>막내 출생일</span><input type="date" data-baby="birth" value="${esc(st.baby.birth)}"></label>
        <div class="stat" style="align-self:center"><b>${bd ? bd + '일째' : '-'}</b><span>${bd ? (bd <= 42 ? '산욕기 (회복 최우선)' : '산후 회복 중') : '출생일을 넣어 주세요'}</span></div></div></div>
      ${seg}${body}${emergency}`;
  }
  function momCheck() {
    const sm = sub.mom, ans = sm.ans || (sm.ans = Array(D.EPDS.length).fill(null));
    const i = ans.findIndex(a => a == null);
    let quiz;
    if (sm.result) {
      const r = sm.result, lv = epdsLevel(r);
      quiz = `<div class="card"><div class="titlerow"><h3>점검 결과 · ${r.score}점 / 30</h3>${sayBtn(`마음 점검 결과는 ${r.score}점, ${lv[1]}입니다. ${lv[2]}`)}</div>
        <div class="verdict ${lv[0]}"><b>${lv[1]}</b><br>${esc(lv[2])}</div>
        <p class="tiny" style="margin-top:8px">에든버러 산후우울 척도(EPDS)를 참고한 자가 점검이에요. 진단이 아니에요. 한국에서는 보통 10점 이상이면 상담을 권해요.</p>
        ${r.saved ? '<p class="small">저장했어요.</p>' : `<div class="grid2"><button class="btn primary" data-act="epdsSave" data-share="1">저장 (남편과 공유)</button><button class="btn" data-act="epdsSave" data-share="0">나만 보기로 저장</button></div>`}
        <button class="btn ghost block" style="margin-top:8px" data-act="epdsRestart">다시 하기</button></div>`;
    } else if (i >= 0) {
      const q = D.EPDS[i];
      quiz = `<div class="card">
        <div class="row"><b>지난 7일 동안</b><span class="grow"></span><span class="tiny">${i + 1}/${D.EPDS.length}</span></div>
        <div class="progress" style="margin:8px 0 12px"><i style="width:${i / D.EPDS.length * 100}%"></i></div>
        <div class="titlerow"><h3>${esc(q.q)}</h3>${sayBtn(`지난 7일 동안, ${q.q}. ${q.o.map(x => x[0]).join(', ')}`)}</div>
        ${q.o.map(([t, sc]) => `<button class="qopt" data-act="epdsAns" data-i="${i}" data-s="${sc}">${esc(t)}</button>`).join('')}
        ${i ? '<button class="btn ghost" data-act="epdsBack">← 이전</button>' : ''}
        <p class="tiny">${esc(name('w'))}가 직접, 편하게 답해 주세요. 정답은 없어요.</p></div>`;
    }
    const hist = st.epds.slice().sort((a, b) => b.at - a.at).slice(0, 6);
    const signs = st.signs.checked || {};
    const sc = D.PPD_SIGNS.filter((x, k) => signs[k]).length, urgentSign = D.PPD_SIGNS.some((x, k) => x.urgent && signs[k]);
    return `
      <div class="speech card soft" style="margin-bottom:12px">${frog('calm', 56)}<div class="bubble small">${esc(name('w'))}, 두 아이를 품고 키우느라 정말 애쓰고 있어. 이 점검은 엄마를 평가하는 게 아니라, 도움이 필요한 때를 놓치지 않으려는 거야.</div></div>
      ${quiz || ''}
      ${hist.length ? `<div class="card"><h3>점검 기록</h3>${hist.map(r => { const lv = epdsLevel(r); return `<div class="check" style="justify-content:space-between"><span class="small">${fmtDate(r.at)} · ${esc(name(r.by))}${r.share ? '' : ' · 🔒나만 보기'}</span><span class="chip ${lv[0] === 'ok' ? 'ok' : ''}">${r.score}점 · ${lv[1]}</span></div>`; }).join('')}</div>` : ''}
      <h2>${esc(name('h'))}가 옆에서 보는 신호</h2>
      <div class="card">
        ${D.PPD_SIGNS.map((x, k) => `<label class="check"><input type="checkbox" data-sign="${k}" ${signs[k] ? 'checked' : ''}><span class="small">${x.urgent ? '⚠️ ' : ''}${esc(x.t)}</span></label>`).join('')}
        <div class="verdict ${urgentSign ? 'stop' : sc >= 3 ? 'warn' : 'ok'}">${urgentSign ? '⚠️ 응급 신호가 있어요. 오늘 바로 109 · 1577-0199 · 119에 연락하고, 아내를 혼자 두지 마세요.' : sc >= 3 ? `신호 ${sc}개. 2주 넘게 이어진다면 "같이 보건소 가 볼까? 내가 예약할게"라고 먼저 제안해 주세요.` : `신호 ${sc}개. 지금처럼 잠과 휴식을 챙겨 주세요.`}</div>
      </div>`;
  }
  function momCare() {
    const r = dailyRec(ymd(), 'h');
    const past = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return ymd(d); });
    const week = past.reduce((t, d) => t + D.CARE.filter(c => st.daily[d] && st.daily[d].h && st.daily[d].h['care_' + c.id]).length, 0);
    const done = D.CARE.filter(c => r['care_' + c.id]).length;
    return `
      <div class="hero"><div class="speech">${frog(done >= 5 ? 'cheer' : 'happy', 60)}<div class="bubble small">${esc(name('h'))}, 지금 ${esc(name('w'))}에게 가장 필요한 건 "뭐 도와줄까?"가 아니라 <b>묻기 전에 맡아서 끝내는 것</b>이야. 오늘 ${done}개 했어!</div>${sayBtn(`${name('h')}님, 오늘의 돌봄입니다. ${D.CARE.map(c => c.t).join('. ')}.`)}</div></div>
      <div class="card">
        ${D.CARE.map(c => `<label class="check" style="align-items:flex-start"><input type="checkbox" data-care="${c.id}" ${r['care_' + c.id] ? 'checked' : ''} style="margin-top:3px"><span><b class="small">${esc(c.t)}</b><br><span class="tiny">${esc(c.why)}</span></span></label>`).join('')}
        <p class="tiny" style="margin-top:8px">최근 7일 돌봄 ${week}회 · ${esc(name('h'))} 폰에서 체크하세요.</p>
      </div>
      <h2>${esc(name('w'))}에게 이렇게 말해 보세요</h2>
      <div class="card">${D.PPD_SAY.map(t => `<div class="check" style="justify-content:space-between"><span class="small">${esc(t)}</span>${sayBtn(t.replace(/"/g, ''))}</div>`).join('')}</div>
      <div class="card warm small"><b>산후 기간에도 3대 규칙은 그대로예요.</b> 수면 부족과 산후우울은 분노를 키울 수 있어요. 이해하되, 욕설·협박·동의 없는 신체접촉은 "멈춤"으로 분리하고, 동시에 치료를 돕는 것. 둘 다 해야 해요.</div>`;
  }
  function momClear() {
    return `
      <div class="speech card soft" style="margin-bottom:12px">${frog('happy', 56)}<div class="bubble small">두리뭉실한 말은 듣는 사람에게 "결국 내가 다 챙겨야 하네"로 들려. 특히 산후엔 생각할 여유가 없어서 <b>언제 · 무엇을 · 누가</b>가 분명한 말이 사랑이야.</div></div>
      <div class="card">${D.VAGUE.map(([a, b]) => `<div class="dont"><div class="x">✕ ${esc(a)}</div><div class="o">→ ${esc(b)}</div></div>`).join('')}
        <div style="margin-top:10px">${sayBtn(['두리뭉실 대신 또렷하게.', ...D.VAGUE.map(([a, b]) => `${a.replace(/"/g, '')} 대신, ${b.replace(/"/g, '')}`)], '전체 듣기')}</div></div>
      <div class="card"><h3>오늘의 연습</h3><ol class="list small">
        <li>위에서 내가 자주 쓰는 말 하나를 고른다.</li><li>오늘 그 말이 나오려 할 때 오른쪽 문장으로 바꿔 말한다 (3번).</li>
        <li>하루에 하나는 내가 먼저 정해서 제안한다. 예: "이번 주 토요일 오전엔 내가 두 아이 데리고 나갈게."</li>
        <li>"싫다"는 웃지 않고 한 번에 분명히. 그게 상대를 존중하는 방법이에요.</li></ol>
        <p class="tiny">홈의 오늘의 지킴이 "또렷하게 말하기"에 체크해요.</p></div>`;
  }
  function momKnow() {
    return `
      <div class="row" style="margin-bottom:10px">${sayBtn([...D.PPD_FACTS.map(f => `${f.t}. ${f.d}`), '도움받을 곳.', ...D.PPD_HELP.map(h => `${h.t}. ${h.d}`)], '전체 듣기')}</div>
      ${D.PPD_FACTS.map(f => `<div class="card"><h3>${esc(f.t)}</h3><p class="small" style="margin:0">${esc(f.d)}</p></div>`).join('')}
      <h2>도움받을 곳 (무료·저렴)</h2>
      <div class="card">${D.PPD_HELP.map(h => `<div class="dont"><b>${esc(h.t)}</b><div class="small">${esc(h.d)}</div></div>`).join('')}</div>`;
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
    const sl = sub.love || (sub.love = { who: 'mission' });
    const seg = `<div class="seg">${[['mission', '사랑 미션'], ['mail', '우체통'], [me(), '언어 테스트'], ['cmp', '둘이 비교']].map(([k, t]) => `<button class="${sl.who === k || (k === me() && (sl.who === 'h' || sl.who === 'w')) ? 'on' : ''}" data-act="loveWho" data-p="${k}">${t}</button>`).join('')}</div>`;
    let body;
    if (sl.who === 'mission') body = loveMission();
    else if (sl.who === 'mail') body = mailboxHtml();
    else if (sl.who === 'cmp') {
      body = P.map(p => {
        const r = st.ll[p];
        if (!r || !r.done) return `<div class="card"><h3><span class="dot ${p}"></span> ${esc(name(p))}</h3><p class="tiny">아직 테스트 전이에요.</p></div>`;
        const res = llResult(r.answers), top = res.order.slice(0, 2);
        const how = top.flatMap(k => D.LOVE[k].tips.slice(0, 3));
        return `<div class="card"><div class="titlerow"><h3><span class="dot ${p}"></span> ${esc(name(p))}의 언어: ${top.map(k => D.LOVE[k].e + ' ' + D.LOVE[k].t).join(' · ')}</h3>${sayBtn(`${name(p)}의 사랑의 언어는 ${D.LOVE[top[0]].t}, 그리고 ${D.LOVE[top[1]].t}입니다. ${name(other(p))}가 사랑을 주는 방법. ${how.join('. ')}.`)}</div>
          ${barsHtml(res.c)}
          <p class="small" style="margin-top:10px"><b>${esc(name(other(p)))}가 ${esc(name(p))}에게 사랑을 주는 법</b></p>
          <ul class="list small">${how.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
          ${r.memo ? `<p class="small"><b>${esc(name(p))}의 메모</b><br>${esc(r.memo)}</p>` : ''}</div>`;
      }).join('') + `<div class="speech">${frog('love', 56)}<div class="bubble small">내가 받고 싶은 방식이 아니라, 상대가 받고 싶은 방식으로! 그게 사랑의 번역이야.</div></div>`;
    } else {
      const who = (sl.who === 'h' || sl.who === 'w') ? sl.who : me();
      body = `<div class="seg">${P.map(p => `<button class="${who === p ? 'on' : ''}" data-act="loveWho" data-p="${p}">${esc(name(p))}</button>`).join('')}</div>
        <p class="muted small">사람마다 사랑을 느끼는 "언어"가 달라요. 20문항, 각자 5분. 더 끌리는 쪽을 고르세요.</p>` + loveQuiz(who);
    }
    return `<h1>💗 사랑 채우기</h1>${seg}${body}`;
  }
  function loveMission() {
    const p = me(), o = other(p), today = ymd(), r = dailyRec(today, p), ms = missionFor(p);
    const past = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return ymd(d); });
    const doneDays = past.filter(d => st.daily[d] && st.daily[d][p] && st.daily[d][p].mission).length;
    const oDone = past.filter(d => st.daily[d] && st.daily[d][o] && st.daily[d][o].mission).length;
    const lang = ms.lang ? D.LOVE[ms.lang] : null;
    return `
      <div class="hero"><div class="speech">${frog('love', 64)}<div class="bubble">${esc(name(o))}${lang ? `는 <b>${lang.e} ${lang.t}</b>으로 사랑을 느껴. ` : '에게 '}오늘은 이걸 해볼까?<br><b>${esc(ms.text)}</b></div>${sayBtn(`오늘의 사랑 미션입니다. ${ms.text}`)}</div></div>
      <button class="btn ${r.mission ? '' : 'primary'} block" data-act="mission">${r.mission ? '✓ 오늘 사랑 전했어요 (취소하려면 누르기)' : '💗 했어요!'}</button>
      <div class="grid2" style="margin-top:12px">
        <div class="card stat"><b>${doneDays}/7</b><span>최근 7일 ${esc(name(p))}의 미션</span></div>
        <div class="card stat"><b>${oDone}/7</b><span>최근 7일 ${esc(name(o))}의 미션</span></div>
      </div>
      ${lang ? `<div class="card"><h3>${esc(name(o))}에게 사랑이 잘 도착하는 방법</h3><ul class="list small">${lang.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul><p class="tiny">${esc(lang.d)}</p></div>`
        : `<div class="card soft small">${esc(name(o))}가 [언어 테스트]를 하면, ${esc(name(o))}에게 꼭 맞는 미션이 매일 나와요.</div>`}
      <div class="card"><h3>칭찬 한 줄 바로 보내기</h3>
        <div class="tpls" style="flex-wrap:wrap">${['고마워, 당신 덕분이야.', '오늘 정말 멋졌어.', '사랑해.', '당신 노력하는 거 다 보여.', '오늘도 수고 많았어.'].map(t => `<button data-act="quickLove" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <p class="tiny">누르면 바로 ${esc(name(o))}의 사랑 우체통에 들어가요.</p></div>`;
  }
  function loveQuiz(p) {
    const r = st.ll[p] || (st.ll[p] = { answers: Array(D.LOVE_Q.length).fill(null), done: false, memo: '', ts: 0 });
    if (r.done) {
      const res = llResult(r.answers), top = D.LOVE[res.order[0]];
      return `<div class="speech card soft">${frog('love', 64)}<div class="bubble">${esc(name(p))}의 1순위 사랑의 언어는 <b>${top.e} ${top.t}</b>!</div>${sayBtn(`${name(p)}의 1순위 사랑의 언어는 ${top.t}입니다. ${top.d}`)}</div>
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
      <div class="titlerow"><p class="muted small" style="margin:0">나는 이럴 때 더 사랑받는다고 느낀다</p>${sayBtn(`첫 번째. ${q[1]}. 두 번째. ${q[3]}.`)}</div><div style="height:8px"></div>
      <button class="qopt" data-act="llAns" data-p="${p}" data-i="${idx}" data-a="0">${esc(q[1])}</button>
      <button class="qopt" data-act="llAns" data-p="${p}" data-i="${idx}" data-a="1">${esc(q[3])}</button>
      ${answered ? `<button class="btn ghost" data-act="llBack" data-p="${p}">← 이전 문항</button>` : ''}
    </div>`;
  }

  // ───────────────────────── 도구
  function viewTools() {
    const ts = sub.tools || (sub.tools = { open: null });
    const item = (k, ico, t, d) => `<button class="card row" style="width:100%;text-align:left" data-act="toolOpen" data-k="${k}"><span style="font-size:26px">${ico}</span><span class="grow"><b>${t}</b><br><span class="tiny">${d}</span></span><span>›</span></button>`;
    if (ts.open === 'saju') return `<button class="btn ghost" data-act="toolOpen" data-k="">← 도구</button>` + viewSaju();
    if (ts.open) return toolDetail(ts.open);
    return `<h1>도구</h1>
      ${item('saju', '☯️', '사주팔자', '생년월일시로 사주 · 오행 · 부부 궁합')}
      ${item('rules', '🛑', '우리 3대 규칙', '욕설·협박 0 · 동의 없는 신체접촉 0 · 멈춤=10분 분리')}
      ${item('pledge', '📜', '하지 않기 서약', '욕·부수기·버리기·탓하기… 우리가 하지 않을 것')}
      ${item('money', '💳', '돈 대화', '비싼 물건 규칙 · 눈치 없이 묻는 법 · 구매 공유 카드')}
      ${item('repair', '🩹', '회복 문장', '싸우는 도중 관계를 살리는 한마디')}
      ${item('timer', '⏱️', '말하기 타이머', '발언권 · 3분 끼어들지 않기 연습')}
      ${item('safety', '🆘', '안전 연락처', '위협·폭력이 있을 때 바로 도움받기')}
      ${item('sync', '🔄', '동기화 · 백업', '각자 폰 기록 합치기, 백업/복원')}
      ${item('voice', '🎙️', '음성 안내', '아나운서 목소리 · 속도 · 자동 안내')}
      ${item('settings', '⚙️', '설정', '이름 · 시작일 · 테마 · 초기화')}
      ${st.timeouts.length ? `<p class="tiny">지금까지 개굴 타임 ${st.timeouts.length}회 — 멈춘 횟수만큼 관계를 지킨 거예요.</p>` : ''}`;
  }
  function toolDetail(k) {
    const back = `<button class="btn ghost" data-act="toolOpen" data-k="">← 도구</button>`;
    if (k === 'rules') {
      return `${back}<h1>우리 3대 규칙</h1>
        <p class="muted small">상담에서 합의할 최소한의 선이에요. 둘 다 서명해야 효력이 생겨요. 다른 모든 연습은 이 세 가지 위에서만 의미가 있어요.</p>
        <div class="row" style="margin-bottom:10px">${sayBtn(['우리 3대 규칙입니다.', ...D.RULES3.map((r, i) => `${i + 1}번, ${r.t}. ${r.d}`), '규칙이 깨지면.', ...D.RULES3_BREACH], '규칙 전체 듣기')}</div>
        ${D.RULES3.map((r, i) => `<div class="card"><h3>${i + 1}. ${esc(r.t)}</h3><p class="small" style="margin:0">${esc(r.d)}</p></div>`).join('')}
        <div class="card warm"><h3>규칙이 깨지면</h3><ol class="list small">${D.RULES3_BREACH.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>
        <div class="card soft"><p class="small">위 규칙과, 깨졌을 때의 약속에 동의합니다. 서명은 "앞으로 지키겠다"는 약속이지, 지난 일을 따지는 문서가 아니에요.</p>
          <div class="grid2">${P.map(p => st.rules3[p] ? `<div class="chip ok" style="justify-content:center;padding:10px"><span class="dot ${p}"></span>${esc(name(p))} 동의 ${esc(st.rules3[p].date)}</div>` : `<button class="btn primary" data-act="sign3" data-p="${p}">${esc(name(p))} 동의·서명</button>`).join('')}</div>
          ${st.rules3.h || st.rules3.w ? '<button class="btn ghost block small" data-act="resign3" style="margin-top:8px">서명 갱신 (다시 서명하기)</button>' : ''}</div>
        <p class="tiny">서명 화면을 캡처해 두거나, 상담사에게 보여 주고 상담 기록에 남겨 달라고 요청할 수 있어요.</p>`;
    }
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
    if (k === 'voice') {
      const vs = st.voice, voices = window.Voice ? Voice.voices : [];
      const cur = window.Voice && Voice.current;
      const avail = window.Voice && Voice.available();
      return `${back}<h1>🎙️ 음성 안내</h1>
        <div class="speech card soft">${frog('happy', 56)}<div class="bubble small">과정 단계, 오늘의 약속, 3대 규칙, 개굴 타임 호흡을 차분한 아나운서 목소리로 읽어 줄게.</div></div>
        ${!avail ? '<div class="card warm small">이 기기에서는 음성 기능을 쓸 수 없어요.</div>' : `
        <div class="card">
          <label class="switch"><span><b>음성 안내 켜기</b><br><span class="tiny">끄면 🔊 버튼을 직접 누를 때만 읽어요</span></span><input type="checkbox" data-vs="on" ${vs.on ? 'checked' : ''}></label>
          <label class="switch"><span><b>과정 단계 자동 안내</b><br><span class="tiny">30분 과정에서 단계가 바뀔 때마다 읽어 줘요</span></span><input type="checkbox" data-vs="auto" ${vs.auto ? 'checked' : ''}></label>
          <label class="switch"><span><b>개굴 타임 호흡 안내</b><br><span class="tiny">"들이쉬고, 내쉬고"를 목소리로</span></span><input type="checkbox" data-vs="breath" ${vs.breath ? 'checked' : ''}></label>
        </div>
        <div class="card">
          <label class="field"><span>목소리 ${voices.length ? `(한국어 ${voices.length}개)` : ''}</span>
            <select data-vs="voice">${voices.length ? voices.map(v => `<option value="${esc(v.uri)}" ${cur && cur.uri === v.uri ? 'selected' : ''}>${v.female === true ? '👩 여성 · ' : v.female === false ? '👨 남성 · ' : ''}${esc(v.name)}${v.local ? '' : ' (인터넷 필요)'}</option>`).join('') : '<option>기본 한국어 목소리</option>'}</select></label>
          <label class="field"><span>말하기 속도 <b>${vs.rate.toFixed(2)}</b> (아나운서 톤 추천 0.90~0.95)</span><input type="range" min="0.7" max="1.2" step="0.02" value="${vs.rate}" data-vs="rate" style="width:100%;accent-color:var(--accent)"></label>
          <label class="field"><span>목소리 높이 <b>${vs.pitch.toFixed(2)}</b></span><input type="range" min="0.85" max="1.2" step="0.01" value="${vs.pitch}" data-vs="pitch" style="width:100%;accent-color:var(--accent)"></label>
          <button class="btn primary block" data-act="voiceTest">🔊 목소리 들어보기</button>
        </div>
        <div class="card small"><b>목소리가 안 나오거나 남자 목소리만 있다면</b>
          <ol class="list"><li>폰 설정 → 일반 → 텍스트 음성 변환(TTS)</li><li>기본 엔진을 <b>Google 음성 인식 및 합성</b>으로 선택</li><li>톱니바퀴 → 음성 데이터 설치 → <b>한국어</b> 받기 → 여성 목소리 선택</li><li>앱으로 돌아와 위 목록에서 👩 여성 목소리를 고르기</li></ol>
          ${window.Voice && Voice.isNative ? '<button class="btn block" data-act="voiceInstall">음성 데이터 설치 화면 열기</button>' : ''}</div>`}`;
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
        <p class="tiny">개굴씨 부부연구소 v2.1 · 이 앱은 전문 상담을 대신하지 않아요. 어려움이 계속되면 부부상담 전문가와 함께하세요.</p>`;
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
    to.left = 10 * 60;
    openSheet(`
      <div style="text-align:center">${frog('calm', 96)}<h1 style="margin-top:4px">개굴 타임</h1>
        <p class="muted small">지금은 대화를 멈추고, 서로 다른 공간에서 몸을 진정시키는 시간이에요.<br>최소 10분, 따라가지 않고 각자 다른 공간에서. "멈춤"을 말한 사람이 돌아올 시간을 말해요.</p>
        <div class="breath" id="breath"><span class="breath-label" id="breathLabel">들이쉬고</span></div>
        <div class="timer" id="toTime">10:00</div><button class="btn ghost small" data-act="toMore">+10분 더</button></div>
      <div class="card small"><b>지금 하면 좋은 것</b><ul class="list"><li>방을 옮기기 · 창문 열기 · 찬물 세수</li><li>호흡: 4초 들이쉬고 6초 내쉬기 (위 원을 따라)</li><li>상대 탓 생각이 올라오면 "지금은 몸부터"라고 속으로 말하기</li></ul>
        <b>하지 않기</b><ul class="list"><li>따라가서 말 걸기 · 문 앞에서 설명하기 · 마지막 한마디</li><li>문 쾅 닫기 · 물건 만지기 · 상대 몸 붙잡기</li><li>메시지로 싸움 이어가기</li></ul></div>
      <div class="card soft small"><b>돌아와서 첫마디</b><br>"아까 멈춰 줘서 고마워. 내가 ___한 건 내 몫이야. 다시 천천히 이야기해 볼까?"</div>
      <p class="tiny" style="text-align:center">위협을 느낀다면 <a href="tel:112">112</a> · <a href="tel:1366">1366</a></p>
      <button class="btn primary block" data-act="closeSheet">진정됐어요, 돌아가기</button>`, () => { clearInterval(to.iv); clearInterval(to.biv); if (window.Voice) Voice.stop(); });
    let phase = 0, cues = 0, cueOn = false;
    const b = () => {
      const el = $('#breath'), lb = $('#breathLabel'); if (!el) return; phase = 1 - phase; el.classList.toggle('in', phase === 1); lb.textContent = phase ? '들이쉬고' : '내쉬고';
      if (cueOn && st.voice.breath && cues < 12) { cues++; narrate(phase ? '천천히, 들이쉬고' : '길게, 내쉬고'); }
    };
    narrate(['개굴 타임입니다.', '지금은 대화를 멈추고, 서로 다른 공간으로 가 주세요.', '따라가지 않고, 설명하지 않아도 괜찮아요.', '10분 동안, 원을 따라 천천히 숨을 쉬어요.'], { onend: () => { cueOn = true; } });
    b(); let t = 0;
    to.biv = setInterval(() => { t++; if ((phase === 1 && t >= 4) || (phase === 0 && t >= 6)) { t = 0; b(); } }, 1000);
    to.iv = setInterval(() => {
      to.left--; const el = $('#toTime'); if (el) el.textContent = fmtTime(Math.max(0, to.left));
      if (to.left <= 0) { clearInterval(to.iv); beep(3); if (el) el.textContent = '다시 만날 시간'; narrate('10분이 지났어요. 준비가 되었다면 돌아가서, 아까 멈춰 줘서 고마워, 라고 먼저 말해 주세요.'); }
    }, 1000);
  }

  // 미니 타이머
  const mini = { left: 180, iv: null };
  function startMini(m) {
    clearInterval(mini.iv); mini.left = m * 60; paintMini(); toast(`${m}분 말하기 시작! 듣는 사람은 끼어들기 금지`);
    mini.iv = setInterval(() => { mini.left--; paintMini(); if (mini.left <= 0) { clearInterval(mini.iv); beep(2); toast('끝! 들은 내용을 요약해 주세요'); narrate('시간이 끝났어요. 듣는 사람은, 들은 내용을 한 문장으로 요약해 주세요.'); } }, 1000);
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
      st.rules3[p] = newer(st.rules3[p], r.rules3 && r.rules3[p]);
    });
    if (!st.startDate || (r.startDate && r.startDate < st.startDate)) st.startDate = r.startDate || st.startDate;
    Object.keys(r.days || {}).forEach(n => { st.days[n] = st.days[n] || {}; P.forEach(p => { const v = newer(st.days[n][p], r.days[n][p]); if (v) st.days[n][p] = v; }); });
    Object.keys(r.daily || {}).forEach(d => { st.daily[d] = st.daily[d] || {}; P.forEach(p => { const v = newer(st.daily[d][p], r.daily[d][p]); if (v) st.daily[d][p] = v; }); });
    st.pledge.custom = Array.from(new Set([...(st.pledge.custom || []), ...((r.pledge && r.pledge.custom) || [])]));
    if (r.money) { st.money.rules = newer(st.money.rules, r.money.rules); st.money.log = unionById(st.money.log, r.money.log); }
    st.baby = newer(st.baby, r.baby); st.signs = newer(st.signs, r.signs);
    st.epds = unionById(st.epds, (r.epds || []).filter(x => x.share));
    Object.keys(r.plan || {}).forEach(k => { st.plan[k] = newer(st.plan[k], r.plan[k]); });
    Object.keys(r.goals || {}).forEach(w => { st.goals[w] = st.goals[w] || {}; P.forEach(p => { const v = newer(st.goals[w][p], r.goals[w][p]); if (v) st.goals[w][p] = v; }); });
    st.messages = unionById(st.messages, r.messages);
    st.timeouts = unionById(st.timeouts, r.timeouts);
    save();
  }

  // ───────────────────────── 이벤트
  const acts = {
    closeSheet,
    goMom: (el) => { sub.mom = { k: el.dataset.k || (me() === 'h' ? 'care' : 'check') }; go('mom'); },
    momSeg: (el) => { sub.mom = Object.assign(sub.mom || {}, { k: el.dataset.k }); render(); },
    epdsAns: (el) => {
      const sm = sub.mom; sm.ans[Number(el.dataset.i)] = Number(el.dataset.s);
      if (sm.ans.every(a => a != null)) {
        const score = sm.ans.reduce((a, b) => a + b, 0), urgent = sm.ans[9] > 0;
        sm.result = { score, urgent, answers: sm.ans.slice() };
        const lv = epdsLevel(sm.result); narrate(`점검이 끝났어요. ${score}점, ${lv[1]}입니다. ${lv[2]}`);
      }
      render();
    },
    epdsBack: () => { const sm = sub.mom; const i = sm.ans.findIndex(a => a == null); const j = (i < 0 ? sm.ans.length : i) - 1; if (j >= 0) sm.ans[j] = null; render(); },
    epdsRestart: () => { sub.mom = { k: 'check' }; render(); },
    epdsSave: (el) => { const r = sub.mom.result; st.epds.push({ id: uid(), at: now(), by: me(), score: r.score, urgent: r.urgent, share: el.dataset.share === '1' }); r.saved = true; save(); render(); toast('저장했어요'); },
    say: (el) => say(sayReg[Number(el.dataset.i)], el),
    progMode: (el) => { sub.program = { mode: el.dataset.k }; render(); },
    goWeekly: () => { sub.program = { mode: 'week' }; go('program'); },
    week: (el) => { sub.program.week = Number(el.dataset.w); render(); },
    mission: () => {
      const r = dailyRec(ymd(), me()); r.mission = !r.mission; r.ts = now(); save(); render();
      if (r.mission) { toast('사랑 전달 완료 💗'); narrate('잘했어요. 작은 사랑이 쌓여서 큰 힘이 돼요.'); }
    },
    heart: (el) => { const m = st.messages.find(x => x.id === el.dataset.id); if (m) { m.heart = !m.heart; save(); render(); if (m.heart) toast('마음을 받았어요 💗'); } },
    tpl: (el) => { const i = $('#msgIn'); if (!i) return; i.value = el.dataset.t; i.focus(); const k = i.value.indexOf('___'); if (k >= 0) i.setSelectionRange(k, k + 3); },
    quickLove: (el) => { st.messages.push({ id: uid(), from: me(), text: el.dataset.t, at: now() }); save(); toast(`${name(other(me()))}의 우체통에 넣었어요 💌`); },
    voiceTest: () => say(`안녕하세요. 개굴씨 부부연구소입니다. ${name('h')}님, ${name('w')}님, 오늘도 같은 편이 되어 30분을 함께해 주셔서 고맙습니다.`, null, { force: true }),
    voiceInstall: () => Voice.openInstall(),
    toMore: () => { to.left += 600; const el = $('#toTime'); if (el) el.textContent = fmtTime(to.left); },
    openDay: (el) => { sub.program = { day: Number(el.dataset.n) }; go('program'); },
    backProgram: () => { sub.program = { mode: 'days' }; go('program'); },
    sessToggle: (el) => { const n = Number(el.dataset.n); if (session.day === n && session.running) pauseSession(); else startSession(n); },
    sessNext: (el) => { const n = Number(el.dataset.n); if (session.day !== n) { session.day = n; session.idx = 0; session.left = frame()[0].m * 60; } nextStep(); },
    miniTimer: (el) => startMini(Number(el.dataset.m)),
    miniStop: () => { clearInterval(mini.iv); toast('타이머 정지'); },
    toggleDone: (el) => {
      const n = Number(el.dataset.n), r = dayRec(n, me()); r.done = !r.done; r.ts = now(); save();
      if (r.done) {
        const both = isDone(n, 'h') && isDone(n, 'w');
        openSheet(`<div style="text-align:center">${frog('cheer', 110)}<h1>${both ? `Day ${n} 둘 다 완료!` : `${esc(name(me()))} Day ${n} 완료!`}</h1>
          <p>${both ? '오늘도 둘이 같은 편이 되었어. 서로 "고생했어" 한마디 해주자!' : `${esc(name(other(me())))}도 완료하면 이 날이 초록색이 돼.`}</p>
          <button class="btn primary block" data-act="closeSheet">좋아!</button></div>`);
        narrate(both ? `${n}일차를 둘 다 완료했어요. 오늘도 같은 편이 되었네요. 서로에게, 고생했어, 한마디 해 주세요.` : `${name(me())}님, ${n}일차 완료! 정말 잘했어요.`);
      }
      render();
    },
    sendMsg: () => { const i = $('#msgIn'); const t = i.value.trim(); if (!t) return toast('편지 내용을 적어 주세요'); if (t.includes('___')) return toast('___ 부분을 채워 주세요'); st.messages.push({ id: uid(), from: me(), text: t, at: now() }); save(); render(); toast(`${name(other(me()))}에게 보냈어요 💌`); },
    safety: () => openSheet(safetyHtml()),
    sajuWho: (el) => { sub.saju.who = el.dataset.p; render(); },
    manualFromCalc: (el) => {
      const p = el.dataset.p, b = st.profiles[p].birth;
      if (!b.date) return toast('먼저 생년월일을 입력해 주세요');
      const r = S.calc(b.date, b.unknown ? null : (b.time || null), b.correct);
      st.profiles[p].manual = { year: r.raw.year, month: r.raw.month, day: r.raw.day, hour: r.raw.hour };
      st.profiles[p].ts = now(); save(); render(); toast('복사했어요. 다른 글자가 있으면 고쳐 주세요');
    },
    loveWho: (el) => { sub.love = sub.love || {}; sub.love.who = el.dataset.p; render(); },
    llAns: (el) => {
      const p = el.dataset.p, r = st.ll[p]; r.answers[Number(el.dataset.i)] = Number(el.dataset.a); r.ts = now();
      if (r.answers.every(a => a != null)) r.done = true;
      save(); render();
    },
    llBack: (el) => { const r = st.ll[el.dataset.p]; const i = r.answers.findIndex(a => a == null); const j = (i < 0 ? r.answers.length : i) - 1; if (j >= 0) r.answers[j] = null; r.ts = now(); save(); render(); },
    llReset: (el) => { if (!confirm('사랑의 언어 테스트를 다시 할까요?')) return; st.ll[el.dataset.p] = { answers: Array(D.LOVE_Q.length).fill(null), done: false, memo: (st.ll[el.dataset.p] || {}).memo || '', ts: now() }; save(); render(); },
    toolOpen: (el) => { sub.tools.open = el.dataset.k || null; render(); window.scrollTo(0, 0); },
    toolGo: (el) => { sub.tools = { open: el.dataset.k }; go('tools'); },
    sign3: (el) => { st.rules3[el.dataset.p] = { date: ymd(), ts: now() }; save(); render(); toast(st.rules3.h && st.rules3.w ? '둘 다 합의했어요. 오늘부터 시작이에요.' : '서명했어요'); },
    resign3: () => { if (!confirm('두 사람 서명을 모두 지우고 다시 서명할까요?')) return; P.forEach(p => { st.rules3[p] = null; }); save(); render(); },
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
    exportCode: () => { const o = Object.assign({}, st); delete o.me; delete o.theme; delete o.voice; delete o.short; o.epds = (st.epds || []).filter(x => x.share); $('#codeOut').value = encode(o); toast('코드를 만들었어요'); },
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
      const bb = $('#obBaby').value; if (bb) { st.baby = { birth: bb, ts: now() }; const bd = babyDays(); if (bd && bd <= 100) st.short = true; }
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
    if (el.dataset.short) { st.short = el.checked; save(); if (session.day && !session.running) { session.day = null; } render(); toast(st.short ? '신생아 모드: 하루 10분' : '기본 모드: 하루 30분'); return; }
    if (el.dataset.baby) { st.baby.birth = el.value; st.baby.ts = now(); if (e.type === 'change') { const bd = babyDays(); if (bd && bd <= 100 && !st.short) { st.short = true; toast('출산 100일 전이라 신생아 모드(10분)를 켰어요'); } save(); render(); } else save(); return; }
    if (el.dataset.care) { const r = dailyRec(ymd(), 'h'); r['care_' + el.dataset.care] = el.checked; r.ts = now(); save(); if (e.type === 'change') render(); return; }
    if (el.dataset.sign) { st.signs.checked[el.dataset.sign] = el.checked; st.signs.ts = now(); save(); if (e.type === 'change') render(); return; }
    if (el.dataset.plan) { st.plan[el.dataset.plan] = { done: el.checked, ts: now() }; save(); if (e.type === 'change') render(); return; }
    if (el.dataset.goal) { const [w, gp] = el.dataset.goal.split('.'); st.goals[w] = st.goals[w] || {}; st.goals[w][gp] = { text: el.value, ts: now() }; save(); return; }
    if (el.dataset.vs) {
      const k = el.dataset.vs, v = st.voice;
      v[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
      save(); if (window.Voice) Voice.configure(v);
      if (e.type === 'change') { render(); if (k === 'voice' || k === 'rate' || k === 'pitch') acts.voiceTest(); }
      return;
    }
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
      <label class="field"><span>막내 출생일 (출산 후라면, 선택)</span><input type="date" id="obBaby"></label>
      <p class="small" style="font-weight:700;margin-bottom:4px">이 폰은 누가 주로 쓰나요?</p>
      <div class="grid2"><label class="check"><input type="radio" name="obMe" value="h" checked><span>남편</span></label><label class="check"><input type="radio" name="obMe" value="w"><span>아내</span></label></div>
      <div class="card soft small" style="margin-top:10px">모든 기록은 이 폰 안에만 저장돼요. 각자 폰에 설치했다면 도구 → 동기화로 기록을 합칠 수 있어요.</div>
      <button class="btn primary block" data-act="obDone">시작하기</button>`);
  }

  // 시작
  if (window.Voice) {
    Voice.configure(st.voice);
    Voice.onChange(sp => { if (!sp) $$('.say.on').forEach(b => b.classList.remove('on')); });
    Voice.loadVoices().then(() => { if (tab === 'tools' && sub.tools && sub.tools.open === 'voice') render(); });
  }
  applyTheme();
  render();
  if (!st.me) onboard();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.Capacitor) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
