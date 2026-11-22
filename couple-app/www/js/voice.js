/* 음성 안내 (아나운서 낭독)
 * - 앱(APK): 폰의 TTS 엔진(구글/삼성)을 @capacitor-community/text-to-speech 로 사용
 * - 브라우저: Web Speech API
 * 한국어 여성 음성을 자동으로 고르고, 설정에서 바꿀 수 있다.
 */
(function (g) {
  const cap = g.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  let plugin = null;
  if (isNative) {
    try { plugin = cap.registerPlugin ? cap.registerPlugin('TextToSpeech') : cap.Plugins.TextToSpeech; } catch (e) { plugin = cap.Plugins && cap.Plugins.TextToSpeech; }
  }
  const web = !isNative && 'speechSynthesis' in g ? g.speechSynthesis : null;

  // 여성 음성으로 알려진 이름 (구글 TTS, 애플, 마이크로소프트, 삼성)
  const FEMALE = [/ism/i, /kob/i, /female/i, /yuna/i, /sora/i, /heami/i, /sunhi/i, /jimin/i, /seoyeon/i, /yuri/i, /여성/, /\bf\d/i, /wavenet-a/i, /wavenet-b/i, /standard-a/i];
  const MALE = [/koc/i, /kod/i, /male(?!.*female)/i, /injoon/i, /minsang/i, /hyunsu/i, /남성/, /wavenet-c/i, /wavenet-d/i];

  const state = {
    voices: [],          // {idx, name, uri, local, female}
    loaded: false,
    token: 0,
    speaking: false,
    listeners: new Set()
  };
  let settings = { on: true, rate: 0.92, pitch: 1.02, voice: null, auto: true, breath: true };

  function emit() { state.listeners.forEach(f => { try { f(state.speaking); } catch (e) { /* noop */ } }); }

  function classify(v, idx) {
    const name = (v.name || '') + ' ' + (v.voiceURI || '');
    const female = FEMALE.some(r => r.test(name)) ? true : MALE.some(r => r.test(name)) ? false : null;
    return { idx, name: v.name || v.voiceURI || ('음성 ' + (idx + 1)), uri: v.voiceURI || v.name, local: v.localService !== false, female, lang: v.lang || '' };
  }

  async function loadVoices() {
    let list = [];
    try {
      if (plugin) {
        const r = await plugin.getSupportedVoices();
        list = (r && r.voices) || [];
      } else if (web) {
        list = web.getVoices();
        if (!list.length) {
          await new Promise(res => { const t = setTimeout(res, 1200); web.onvoiceschanged = () => { clearTimeout(t); res(); }; });
          list = web.getVoices();
        }
      }
    } catch (e) { list = []; }
    state.voices = list.map(classify).filter(v => /^ko/i.test(v.lang) || /korean|한국/i.test(v.name));
    // 순위: 여성 > 미상 > 남성, 로컬 우선(오프라인에서도 동작)
    state.voices.sort((a, b) => rank(b) - rank(a));
    state.loaded = true;
    return state.voices;
  }
  const rank = (v) => (v.female === true ? 20 : v.female === null ? 10 : 0) + (v.local ? 2 : 0) + (/network|enhanced|premium|neural/i.test(v.name) ? 1 : 0);

  function pickVoice() {
    if (!state.voices.length) return null;
    if (settings.voice) { const v = state.voices.find(x => x.uri === settings.voice); if (v) return v; }
    return state.voices[0];
  }

  // 낭독하기 좋게 다듬기
  function clean(text) {
    return String(text || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/Day\s*(\d+)/g, '$1일차')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/→|->/g, ', ')
      .replace(/[✕✓✋▶·•]/g, ', ')
      .replace(/\[|\]/g, '')
      .replace(/(\d+)\s*~\s*(\d+)/g, '$1에서 $2')
      .replace(/(^|\s)(\d)\)\s*/g, '$1$2번, ')
      .replace(/①/g, '첫째, ').replace(/②/g, '둘째, ').replace(/③/g, '셋째, ').replace(/④/g, '넷째, ').replace(/⑤/g, '다섯째, ')
      .replace(/~/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  // 문장 단위로 나눠 자연스러운 쉼
  function chunks(text) {
    const out = [];
    String(text).split(/\n+/).forEach(line => {
      const c = clean(line); if (!c) return;
      const parts = c.match(/[^.!?。]+[.!?。]?["”']?\s*/g) || [c];
      let buf = '';
      parts.forEach(p => { if ((buf + p).length > 180) { if (buf) out.push(buf.trim()); buf = p; } else buf += p; });
      if (buf.trim()) out.push(buf.trim());
    });
    return out;
  }

  async function sayOne(text, token) {
    if (token !== state.token) return;
    const v = pickVoice();
    if (plugin) {
      const opts = { text, lang: 'ko-KR', rate: settings.rate, pitch: settings.pitch, volume: 1.0, category: 'playback', queueStrategy: 0 };
      if (v) opts.voice = v.idx;
      await plugin.speak(opts);
      return;
    }
    if (web) {
      await new Promise((res) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR'; u.rate = settings.rate; u.pitch = settings.pitch;
        if (v) { const wv = web.getVoices().find(x => (x.voiceURI || x.name) === v.uri); if (wv) u.voice = wv; }
        u.onend = res; u.onerror = res;
        web.speak(u);
      });
    }
  }

  /** 여러 덩어리를 차례로 읽는다. 새 speak가 오면 이전 낭독은 멈춘다. */
  async function speak(text, opts = {}) {
    if (!settings.on && !opts.force) return false;
    if (!available()) return false;
    if (!state.loaded) await loadVoices();
    stop(true);
    const token = ++state.token;
    state.speaking = true; emit();
    const list = Array.isArray(text) ? text.flatMap(chunks) : chunks(text);
    try {
      for (const c of list) {
        if (token !== state.token) break;
        await sayOne(c, token);
      }
    } catch (e) { /* 엔진 오류: 조용히 종료 */ }
    if (token === state.token) { state.speaking = false; emit(); if (opts.onend) opts.onend(); }
    return true;
  }

  function stop(silent) {
    state.token++;
    try { if (plugin) plugin.stop(); else if (web) web.cancel(); } catch (e) { /* noop */ }
    if (state.speaking) { state.speaking = false; if (!silent) emit(); }
  }

  function available() { return !!(plugin || web); }

  async function openInstall() { try { if (plugin && plugin.openInstall) await plugin.openInstall(); } catch (e) { /* noop */ } }

  g.Voice = {
    isNative, available, speak, stop, loadVoices, openInstall,
    get voices() { return state.voices; },
    get speaking() { return state.speaking; },
    get current() { return pickVoice(); },
    onChange(f) { state.listeners.add(f); return () => state.listeners.delete(f); },
    configure(s) { settings = Object.assign(settings, s || {}); },
    get settings() { return settings; }
  };
})(window);
