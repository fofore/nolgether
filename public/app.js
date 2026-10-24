(() => {
  'use strict';

  const socket = io();
  const root = document.getElementById('app');
  const dock = document.getElementById('dock');
  const toastEl = document.getElementById('toast');

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* 저장 불가 환경 */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* 저장 불가 환경 */ } },
  };

  // ?p=2 처럼 붙이면 같은 브라우저에서 다른 참가자로 테스트할 수 있다.
  const params = new URLSearchParams(location.search);
  const suffix = params.get('p') ? `.${params.get('p')}` : '';
  const KEY = { token: `nolgether.token${suffix}`, room: `nolgether.room${suffix}`, name: `nolgether.name${suffix}` };

  // 예전 이름(놀이상)으로 저장된 접속 정보를 옮겨서, 이미 방에 있던 사람이 끊기지 않게 한다.
  for (const field of ['token', 'room', 'name']) {
    const legacy = `nolisang.${field}${suffix}`;
    const old = store.get(legacy);
    if (old !== null && store.get(KEY[field]) === null) store.set(KEY[field], old);
    store.del(legacy);
  }

  function makeToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  let token = store.get(KEY.token);
  if (!token) {
    token = makeToken();
    store.set(KEY.token, token);
  }

  const route = parseRoute();
  if (route.view === 'screen') document.body.classList.add('screen');

  let state = null;
  let clockOffset = 0;
  let offline = false;
  let connecting = true;
  const ui = {
    values: { name: store.get(KEY.name) || '', code: '' },
    holding: false,
    error: '',
    confirm: null, // { message, okLabel, onOk }
  };

  // 카카오톡 인앱 브라우저 등에서는 window.confirm이 막혀 있어서 화면 안에 직접 띄운다.
  function askConfirm(message, okLabel, onOk) {
    ui.confirm = { message, okLabel, onOk };
    render();
  }

  function parseRoute() {
    const m = location.pathname.match(/^\/(r|screen)\/(\d{4})\/?$/);
    if (!m) return { view: 'home', code: null };
    return { view: m[1] === 'r' ? 'join' : 'screen', code: m[2] };
  }

  // ------------------------------------------------------------ helpers

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const isHost = () => Boolean(state && state.me && state.me.isHost);
  const meId = () => (state && state.me ? state.me.id : null);
  const person = id => (state.roster && state.roster[id]) || { name: '(나간 사람)', color: '#ccc' };
  const pchip = (id, extra = '') => {
    const p = person(id);
    return `<span class="pchip ${extra}"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</span>`;
  };
  const names = ids => ids.map(id => esc(person(id).name)).join(', ');
  const timer = deadline => (deadline ? `<div class="timer" data-deadline="${deadline}"></div>` : '');
  const hostBtn = (label, attrs, cls = 'primary big') => (isHost() ? `<button class="btn ${cls}" ${attrs}>${label}</button>` : '');
  const gameAct = (type, extra = '') => `data-act="game" data-type="${type}" ${extra}`;
  const waitingHost = text => (isHost() || !state.me ? '' : `<div class="waiting">${text || '방장이 진행하길 기다리는 중...'}</div>`);

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  function emit(event, payload = {}) {
    return new Promise(resolve => {
      socket.timeout(8000).emit(event, payload, (err, res) => {
        if (err) resolve({ ok: false, error: '서버 응답이 없어요. 연결을 확인해 주세요.' });
        else resolve(res || { ok: true });
      });
    });
  }

  async function request(event, payload) {
    const res = await emit(event, payload);
    if (!res.ok && res.error) toast(res.error);
    return res;
  }

  function enterRoom(code) {
    store.set(KEY.room, code);
    const path = `/r/${code}${location.search}`;
    if (location.pathname + location.search !== path) history.replaceState(null, '', path);
    route.view = 'join';
    route.code = code;
  }

  function leaveRoom() {
    store.del(KEY.room);
    state = null;
    history.replaceState(null, '', `/${location.search}`);
    route.view = 'home';
    route.code = null;
    render();
  }

  async function share() {
    const url = state.joinUrl;
    const text = '놀게더 하자, 들어와!';
    if (navigator.share) {
      try {
        await navigator.share({ title: '놀게더', text, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    copyText(url);
  }

  function copyText(text) {
    const done = () => toast('링크를 복사했어요. 단톡방에 붙여넣으세요!');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text) && done());
    } else if (legacyCopy(text)) {
      done();
    } else {
      toast(text);
    }
  }

  function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  function parseValue(raw) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw;
  }

  // ------------------------------------------------------------ actions

  async function handle(act, data) {
    switch (act) {
      case 'create': {
        const name = (ui.values.name || '').trim();
        if (!name) return toast('닉네임을 입력해 주세요.');
        store.set(KEY.name, name);
        const res = await request('room:create', { name, token });
        if (res.ok) enterRoom(res.code);
        return;
      }
      case 'join': {
        const code = route.code || (ui.values.code || '').trim();
        const name = (ui.values.name || '').trim();
        if (!/^\d{4}$/.test(code)) return toast('4자리 방 코드를 입력해 주세요.');
        if (!name) return toast('닉네임을 입력해 주세요.');
        store.set(KEY.name, name);
        const res = await request('room:join', { code, name, token });
        if (res.ok) enterRoom(res.code);
        return;
      }
      case 'confirm-ok': {
        const pending = ui.confirm;
        ui.confirm = null;
        render();
        return pending && pending.onOk();
      }
      case 'confirm-cancel':
        ui.confirm = null;
        return render();
      case 'leave':
        return askConfirm(
          state.game ? '게임 중에 나가면 지금까지의 점수가 사라져요. 나갈까요?' : '방에서 나갈까요?',
          '나가기',
          async () => {
            await emit('room:leave');
            leaveRoom();
          },
        );
      case 'share':
        return share();
      case 'copy':
        return copyText(state.joinUrl);
      case 'select-game':
        return request('lobby:select', { gameKey: data.game });
      case 'setting':
        return request('lobby:settings', { settings: { [data.key]: parseValue(data.value) } });
      case 'start':
        return request('game:start');
      case 'restart':
        return request('game:restart');
      case 'end':
        return askConfirm('게임을 끝내고 모두 대기실로 돌아갈까요?', '게임 끝내기', () => request('game:end'));
      case 'to-lobby':
        return request('game:end');
      case 'kick': {
        const id = data.id;
        return askConfirm(`${person(id).name}님을 내보낼까요?`, '내보내기', () => request('player:kick', { playerId: id }));
      }
      case 'game': {
        const payload = { type: data.type };
        if (data.target) payload.target = data.target;
        if (data.side) payload.side = data.side;
        if (data.option !== undefined) payload.option = Number(data.option);
        if (data.index !== undefined) payload.index = Number(data.index);
        return request('game:action', payload);
      }
      case 'guess': {
        const text = (ui.values.guess || '').trim();
        if (!text) return toast('제시어를 입력해 주세요.');
        const res = await request('game:action', { type: 'guess', text });
        if (res.ok) ui.values.guess = '';
        return;
      }
      case 'whoami-guess': {
        const text = (ui.values['wa-guess'] || '').trim();
        if (!text) return toast('내 단어를 입력해 주세요.');
        const res = await request('game:action', { type: 'guess', text });
        if (!res.ok) return;
        ui.values['wa-guess'] = '';
        render();
        return toast(res.verdict === 'correct' ? `정답! ${res.rank}등으로 탈출!` : `땡! "${text}" 말고 다른 거예요`);
      }
      default:
    }
  }

  root.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled || el.tagName === 'FORM') return;
    e.preventDefault();
    handle(el.dataset.act, el.dataset);
  });

  root.addEventListener('submit', e => {
    e.preventDefault();
    handle(e.target.dataset.act, e.target.dataset);
  });

  root.addEventListener('input', e => {
    if (e.target.id) ui.values[e.target.id] = e.target.value;
  });

  // 라이어 제시어: 꾹 누르고 있는 동안만 보인다.
  const setHolding = on => {
    ui.holding = on;
    const card = root.querySelector('[data-hold]');
    if (card) card.classList.toggle('revealed', on);
  };
  root.addEventListener('pointerdown', e => { if (e.target.closest('[data-hold]')) setHolding(true); });
  window.addEventListener('pointerup', () => ui.holding && setHolding(false));
  window.addEventListener('pointercancel', () => ui.holding && setHolding(false));
  root.addEventListener('contextmenu', e => { if (e.target.closest('[data-hold]')) e.preventDefault(); });

  // ------------------------------------------------------------ socket

  socket.on('connect', async () => {
    offline = false;
    if (route.view === 'screen') {
      const res = await emit('room:screen', { code: route.code });
      ui.error = res.ok ? '' : res.error || '방을 찾을 수 없어요.';
    } else {
      const code = route.code || store.get(KEY.room);
      if (code) {
        const res = await emit('room:resume', { code, token });
        if (res.ok) {
          enterRoom(code);
        } else {
          store.del(KEY.room);
          state = null;
          if (route.view === 'home') history.replaceState(null, '', `/${location.search}`);
        }
      }
    }
    connecting = false;
    render();
  });

  socket.on('disconnect', () => {
    offline = true;
    render();
  });

  socket.on('state', next => {
    state = next;
    clockOffset = next.now - Date.now();
    render();
  });

  socket.on('kicked', () => {
    toast('방장이 방에서 내보냈어요.');
    leaveRoom();
  });

  socket.on('replaced', () => {
    state = null;
    ui.error = '다른 창에서 같은 참가자로 접속했어요.';
    render();
  });

  // ------------------------------------------------------------ render

  function render() {
    const active = document.activeElement;
    const focusId = active && root.contains(active) ? active.id : null;
    const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;

    root.innerHTML = (offline ? '<div class="offline">연결이 끊겼어요. 다시 연결하는 중...</div>' : '') + page() + confirmDialog();

    for (const input of root.querySelectorAll('input[id]')) {
      if (ui.values[input.id] !== undefined) input.value = ui.values[input.id];
    }
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus();
        if (caret && el.setSelectionRange) {
          try { el.setSelectionRange(caret[0], caret[1]); } catch { /* 일부 입력 타입은 지원 안 함 */ }
        }
      }
    }
    tick();
    renderDock();
  }

  // 초성 배틀 입력창은 화면 아래에 고정하고, 다시 그리지 않는다.
  // 다시 그리면 휴대폰 키보드가 닫혀서 빠르게 입력할 수 없기 때문이다.
  function renderDock() {
    const g = state && state.game;
    const show = route.view !== 'screen' && g && g.key === 'chosung' && g.phase === 'question' && g.me && !g.me.solved;
    document.body.classList.toggle('has-dock', Boolean(show));
    if (!show) {
      if (!dock.hidden) {
        dock.hidden = true;
        dock.innerHTML = '';
        delete dock.dataset.q;
      }
      return;
    }
    if (dock.hidden || dock.dataset.q !== String(g.index)) {
      dock.dataset.q = String(g.index);
      dock.innerHTML = `
        <form class="dock-form" id="cs-form">
          <input id="cs-guess" maxlength="30" placeholder="정답 입력" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send">
          <button class="btn primary" type="submit">제출</button>
        </form>
        <div class="dock-msg" id="cs-msg" aria-live="polite"></div>`;
      dock.hidden = false;
    }
  }

  const DOCK_MESSAGES = {
    mismatch: '초성이 달라요',
    near: '초성은 맞는데 아쉬워요! 방장이 인정해 줄 수도 있어요',
    limit: '이번 문제는 더 입력할 수 없어요',
  };

  // 제출 버튼을 눌러도 입력창 포커스(키보드)가 유지되게 한다.
  dock.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) e.preventDefault();
  });

  dock.addEventListener('submit', async e => {
    e.preventDefault();
    const input = dock.querySelector('#cs-guess');
    const msg = dock.querySelector('#cs-msg');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.focus();
    const res = await request('game:action', { type: 'guess', text });
    if (!res.ok || !msg) return;
    if (res.verdict === 'correct') return toast(`정답! ${res.rank}등`);
    const message = DOCK_MESSAGES[res.verdict];
    if (!message) return;
    msg.textContent = `"${text}" · ${message}`;
    msg.classList.remove('shake');
    void msg.offsetWidth; // 같은 애니메이션을 다시 재생하기 위해 스타일을 다시 계산시킨다
    msg.classList.add('shake');
  });

  function tick() {
    const now = Date.now() + clockOffset;
    for (const el of root.querySelectorAll('[data-deadline]')) {
      const left = Math.max(0, Math.ceil((Number(el.dataset.deadline) - now) / 1000));
      el.textContent = `${left}초`;
      el.classList.toggle('urgent', left <= 5);
    }
  }
  setInterval(tick, 250);

  function confirmDialog() {
    if (!ui.confirm) return '';
    return `
      <div class="modal-backdrop" data-act="confirm-cancel">
        <div class="modal" role="dialog" aria-modal="true" data-act="none">
          <p class="modal-text">${esc(ui.confirm.message)}</p>
          <div class="modal-actions">
            <button class="btn" data-act="confirm-cancel">취소</button>
            <button class="btn primary" data-act="confirm-ok">${esc(ui.confirm.okLabel)}</button>
          </div>
        </div>
      </div>`;
  }

  function page() {
    if (route.view === 'screen') {
      if (!state) return `<main class="page"><div class="card center"><p class="big-text">큰 화면 연결 중...</p>${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}</div></main>`;
      return state.game ? gamePage() : screenLobby();
    }
    if (connecting) return '<main class="page"><div class="waiting">연결 중...</div></main>';
    if (!state || !state.me) return route.view === 'join' ? joinPage() : homePage();
    return state.game ? gamePage() : lobbyPage();
  }

  function homePage() {
    return `
      <main class="page">
        <header class="brand">
          <div class="logo">놀게더<small>링크 하나로 다 같이, 설치 없이 바로 시작하는 파티게임</small></div>
        </header>
        <form class="card" data-act="create">
          <label class="label" for="name">닉네임</label>
          <input id="name" maxlength="10" placeholder="예) 김대리" autocomplete="off">
          <button class="btn primary big" type="submit">방 만들기</button>
        </form>
        <form class="card" data-act="join">
          <label class="label" for="code">초대받았나요? 방 코드로 입장</label>
          <div class="row">
            <input id="code" inputmode="numeric" maxlength="4" placeholder="4자리 숫자" autocomplete="off">
            <button class="btn" type="submit">입장</button>
          </div>
          <p class="hint">입장할 때도 위의 닉네임을 사용해요.</p>
        </form>
        ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
      </main>`;
  }

  function joinPage() {
    return `
      <main class="page">
        <header class="brand">
          <div class="logo">놀게더<small>방 <b>${esc(route.code)}</b>에 초대받았어요</small></div>
        </header>
        <form class="card" data-act="join">
          <label class="label" for="name">닉네임</label>
          <input id="name" maxlength="10" placeholder="다른 사람에게 보일 이름" autocomplete="off">
          <button class="btn primary big" type="submit">나두 낄래!</button>
        </form>
        <a class="btn ghost" href="/" style="text-align:center;text-decoration:none">처음 화면으로</a>
        ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
      </main>`;
  }

  function playersBlock(allowKick) {
    return `<div class="players">${state.players.map(p => `
      <span class="pchip ${p.connected ? '' : 'off'}">
        <span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}
        ${p.id === state.hostId ? '<span class="crown" title="방장">👑</span>' : ''}
        ${allowKick && p.id !== meId() ? `<button class="kick" data-act="kick" data-id="${p.id}" aria-label="${esc(p.name)} 내보내기">×</button>` : ''}
      </span>`).join('')}</div>`;
  }

  function lobbyPage() {
    const host = isHost();
    const selected = state.catalog.games.find(g => g.key === state.gameKey);
    const connected = state.players.filter(p => p.connected).length;
    const tooFew = connected < selected.minPlayers;
    const tooMany = Boolean(selected.maxPlayers) && connected > selected.maxPlayers;
    const enough = !tooFew && !tooMany;
    let notice = '';
    if (tooFew) notice = `${esc(selected.title)}은(는) 최소 ${selected.minPlayers}명이 필요해요. 친구를 초대해 주세요!`;
    else if (tooMany) notice = `${esc(selected.title)}은(는) ${selected.maxPlayers}명만 할 수 있어요. 다른 게임을 골라주세요.`;
    else if (state.gameKey === 'balance' && connected === 2) notice = '2명이면 텔레파시가 더 재밌어요!';
    return `
      <main class="page">
        <div class="topbar">
          <div><div class="title">대기실</div><div class="sub">${esc(state.me.name)}님으로 참여 중</div></div>
          <button class="btn ghost small" data-act="leave">나가기</button>
        </div>

        <section class="card center">
          <div class="label">방 코드</div>
          <div class="room-code">${esc(state.code)}</div>
          ${host ? `<img class="qr" src="/qr/${esc(state.code)}.svg" alt="입장 QR 코드">` : ''}
          <div class="link-text">${esc(state.joinUrl)}</div>
          <div class="row" style="width:100%">
            <button class="btn primary" style="flex:1" data-act="share">초대 링크 보내기</button>
            <button class="btn" data-act="copy">복사</button>
          </div>
          ${host ? `<a class="hint" href="${esc(state.screenUrl)}" target="_blank" rel="noopener">📺 TV·노트북에 큰 화면 띄우기</a>` : ''}
        </section>

        <section class="card">
          <div class="label">참가자 ${state.players.length}명</div>
          ${playersBlock(host)}
        </section>

        <section class="card">
          <div class="label">${host ? '게임 고르기' : '방장이 고른 게임'}</div>
          <div class="games">${state.catalog.games.map(g => `
            <button class="game-card ${g.key === state.gameKey ? 'on' : ''}" data-act="select-game" data-game="${g.key}" ${host ? '' : 'disabled'}>
              <span class="name">${esc(g.title)}</span>
              <span class="desc">${esc(g.tagline)}</span>
              <span class="meta">${esc(g.recommended)} · 약 ${esc(g.minutes)}</span>
            </button>`).join('')}</div>
          ${settingsBlock(state.gameKey, state.settings, host)}
        </section>

        ${host
          ? `<button class="btn primary big" data-act="start" ${enough ? '' : 'disabled'}>게임 시작</button>
             ${notice ? `<p class="hint" style="text-align:center">${notice}</p>` : ''}`
          : '<div class="waiting">방장이 게임을 시작하길 기다리는 중...</div>'}
      </main>`;
  }

  function chips(key, label, options, current, enabled, hint) {
    return `
      <div class="setting">
        <div class="setting-label">${label}</div>
        <div class="chips">${options.map(([value, text]) => `
          <button class="chip ${String(value) === String(current) ? 'on' : ''}" data-act="setting" data-key="${key}" data-value="${esc(value)}" ${enabled ? '' : 'disabled'}>${esc(text)}</button>`).join('')}
        </div>
        ${hint ? `<p class="hint">${hint}</p>` : ''}
      </div>`;
  }

  function settingsBlock(key, s, enabled) {
    if (key === 'whoami') {
      return [
        chips('category', '주제', [['random', '랜덤 (사람마다 다른 주제)'], ...state.catalog.whoami.categories.map(c => [c, c])], s.category, enabled, '랜덤이면 내 단어의 주제만 힌트로 보여줘요.'),
        chips('turnSeconds', '한 차례 시간', [[0, '무제한'], [30, '30초'], [60, '60초']], s.turnSeconds, enabled),
        chips('penalty', '틀리면', [['none', '그냥 다음 사람'], ['skip', '한 번 쉬기']], s.penalty, enabled),
      ].join('');
    }
    if (key === 'chosung') {
      return [
        chips('count', '문제 수', [[5, '5문제'], [10, '10문제'], [15, '15문제']], s.count, enabled),
        chips('category', '주제', [['random', '랜덤'], ...state.catalog.chosung.categories.map(c => [c, c])], s.category, enabled),
        chips('seconds', '제한 시간', [[20, '20초'], [30, '30초'], [45, '45초']], s.seconds, enabled, '시간이 절반 지나면 첫 글자를 힌트로 보여줘요.'),
      ].join('');
    }
    if (key === 'telepathy') {
      return [
        chips('count', '문제 수', [[5, '5문제'], [7, '7문제'], [10, '10문제']], s.count, enabled),
        chips('category', '주제', [['all', '전체'], ...state.catalog.telepathy.categories.map(c => [c, c])], s.category, enabled),
      ].join('');
    }
    if (key === 'weknow') {
      return [
        chips('count', '문제 수', [[6, '6문제'], [10, '10문제'], [14, '14문제']], s.count, enabled, '참가자가 돌아가며 주인공이 돼요.'),
        chips('category', '주제', [['all', '전체'], ...state.catalog.weknow.categories.map(c => [c, c])], s.category, enabled),
      ].join('');
    }
    if (key === 'liar') {
      return [
        chips('rounds', '라운드', [[1, '1판'], [3, '3판'], [5, '5판'], [7, '7판']], s.rounds, enabled),
        chips('category', '카테고리', [['random', '랜덤'], ...state.catalog.liar.categories.map(c => [c, c])], s.category, enabled),
        chips('fool', '바보 모드', [[false, '끄기'], [true, '켜기']], s.fool, enabled, '켜면 라이어도 비슷한 다른 단어를 받아서, 자기가 라이어인지 모르고 시작해요.'),
      ].join('');
    }
    if (key === 'balance') {
      return [
        chips('count', '문제 수', [[5, '5문제'], [7, '7문제'], [10, '10문제']], s.count, enabled),
        chips('category', '주제', [['all', '전체'], ...state.catalog.balance.categories.map(c => [c, c])], s.category, enabled),
        chips('anonymous', '공개 방식', [[false, '누가 골랐는지 공개'], [true, '익명']], s.anonymous, enabled),
      ].join('');
    }
    return '';
  }

  function screenLobby() {
    const selected = state.catalog.games.find(g => g.key === state.gameKey);
    return `
      <main class="page">
        <section class="card">
          <div class="screen-lobby">
            <img class="qr" src="/qr/${esc(state.code)}.svg" alt="입장 QR 코드">
            <div>
              <div class="logo" style="font-size:40px">놀게더</div>
              <p class="join-hint">폰 카메라로 QR을 찍거나, 아래 코드로 들어오세요</p>
              <div class="room-code">${esc(state.code)}</div>
              <p class="link-text" style="font-size:18px">${esc(state.joinUrl)}</p>
            </div>
          </div>
        </section>
        <section class="card">
          <div class="label" style="font-size:20px">참가자 ${state.players.length}명 · 다음 게임: ${esc(selected.title)}</div>
          ${state.players.length ? playersBlock(false) : '<p class="hint" style="font-size:20px">아직 아무도 없어요.</p>'}
        </section>
      </main>`;
  }

  function gamePage() {
    const g = state.game;
    const info = state.catalog.games.find(x => x.key === g.key);
    const pages = { liar: liarPage, balance: balancePage, chosung: chosungPage, telepathy: telepathyPage, weknow: weknowPage, whoami: whoamiPage };
    const body = pages[g.key](g);
    const screen = route.view === 'screen';
    return `
      <main class="page">
        <div class="topbar">
          <div><div class="title">${esc(info.title)}</div><div class="sub">${screen ? `방 코드 ${esc(state.code)}` : `${esc(state.me.name)}님`}</div></div>
          ${isHost() ? '<button class="btn ghost small" data-act="end">게임 끝내기</button>' : ''}
          ${state.me && !isHost() ? '<button class="btn ghost small" data-act="leave">나가기</button>' : ''}
        </div>
        ${body}
      </main>`;
  }

  function rankingBlock(rows, points = {}) {
    const medal = rank => ({ 1: '🥇', 2: '🥈', 3: '🥉' })[rank] || rank;
    return `<ol class="rank-list">${rows.map(row => {
      const p = person(row.id);
      const plus = points[row.id] ? `<span class="plus">+${points[row.id]}</span>` : '';
      return `<li><span class="pos">${medal(row.rank)}</span><span class="who"><span class="dot" style="background:${esc(p.color)}"></span><span>${esc(p.name)}</span></span><span class="pts">${row.score}점${plus}</span></li>`;
    }).join('')}</ol>`;
  }

  function finalBlock(g, againLabel, extra = '') {
    const titles = g.titles || [];
    return `
      <div class="banner">최종 결과</div>
      ${extra}
      ${g.ranking ? `<section class="card">${rankingBlock(g.ranking)}</section>` : ''}
      ${titles.length ? `<section class="card"><div class="label">오늘의 칭호</div><div class="titles">${g.titles.map(t => `
        <div class="title-card"><div class="t">${esc(t.title)}</div><div>${names(t.ids)}</div><div class="d">${esc(t.desc)}</div></div>`).join('')}</div></section>` : ''}
      ${isHost() ? `<div class="actions">
        <button class="btn primary big" data-act="restart">${againLabel}</button>
        <button class="btn big" data-act="to-lobby">다른 게임 고르기</button>
      </div>` : waitingHost('방장이 다음 게임을 고르는 중...')}`;
  }

  // ------------------------------------------------------------ liar

  function liarPage(g) {
    const head = `<div class="phase-head"><div class="step">라운드 ${g.round}/${g.rounds} · 카테고리 ${esc(g.category)}</div>`;
    const me = g.me;

    if (g.phase === 'talk') {
      return `
        ${head}<h2>제시어를 확인하세요</h2></div>
        ${me ? wordCard(g) : '<section class="card center"><p class="big-text">폰에서 꾹 눌러 제시어를 확인하세요</p></section>'}
        <section class="card">
          <div class="label">설명 순서</div>
          <ol class="order">${g.order.map(id => `<li>${pchip(id)}</li>`).join('')}</ol>
          <p class="hint">순서대로 제시어를 한 문장씩 설명하세요. 라이어는 들키지 않게! 다 돌면 투표해요.</p>
        </section>
        ${hostBtn('투표 시작', gameAct('startVote'))}
        ${waitingHost('설명이 끝나면 방장이 투표를 시작해요.')}`;
    }

    if (g.phase === 'vote') {
      const canVote = me && me.inRound;
      return `
        ${head}<h2>${g.revote ? '재투표! 동표자 중에서 골라주세요' : '라이어는 누구일까?'}</h2></div>
        ${timer(g.deadline)}
        ${canVote
          ? `<div class="vote-grid">${g.candidates.filter(id => id !== meId()).map(id => {
              const p = person(id);
              return `<button class="vote-btn ${me.vote === id ? 'on' : ''}" ${gameAct('vote', `data-target="${id}"`)}><span class="dot" style="background:${esc(p.color)}"></span><span class="n">${esc(p.name)}</span></button>`;
            }).join('')}</div>
            <p class="hint" style="text-align:center">${me.vote ? '마감 전까지는 다시 고를 수 있어요.' : '라이어라고 생각하는 사람을 눌러주세요.'}</p>`
          : `<section class="card center"><div class="players" style="justify-content:center">${g.candidates.map(id => pchip(id)).join('')}</div>${me ? '<p class="hint">이번 라운드는 구경해요.</p>' : ''}</section>`}
        <div class="progress">${g.votedCount}/${g.voterCount}명 투표 완료</div>
        ${hostBtn('투표 마감', gameAct('closeVote'), 'big')}`;
    }

    if (g.phase === 'tie') {
      return `
        ${head}<h2>동표가 나왔어요!</h2></div>
        <section class="card center">
          <div class="players" style="justify-content:center">${g.tied.map(id => pchip(id)).join('')}</div>
          <p class="hint">동표인 사람끼리 한 번 더 설명한 뒤 재투표해요. 또 동표면 라이어 승리!</p>
        </section>
        ${hostBtn('재투표 시작', gameAct('startVote'))}
        ${waitingHost()}`;
    }

    if (g.phase === 'guess') {
      const iAmLiar = meId() === g.liarId;
      return `
        <div class="banner">라이어 발견!<small>${esc(person(g.liarId).name)}님이 라이어였어요</small></div>
        ${timer(g.deadline)}
        ${iAmLiar
          ? `<form class="card" data-act="guess">
              <div class="label">${g.fool ? `사실 당신이 라이어였어요! 당신이 받은 단어는 "${esc(me.word)}"였어요.` : '마지막 기회!'}</div>
              <p class="big-text">시민들의 제시어는?</p>
              <input id="guess" maxlength="20" placeholder="카테고리: ${esc(g.category)}" autocomplete="off">
              <button class="btn primary big" type="submit">정답 제출</button>
            </form>`
          : `<section class="card center"><p class="big-text">라이어가 제시어를 맞히는 중...</p><p class="hint">맞히면 라이어 승리, 틀리면 시민 승리!</p></section>`}
        ${hostBtn('건너뛰기 (오답 처리)', gameAct('skipGuess'), 'ghost')}`;
    }

    if (g.phase === 'result') return liarResult(g);
    return finalBlock(g, '라이어 게임 한 번 더');
  }

  function wordCard(g) {
    const me = g.me;
    if (!me.inRound) {
      return '<section class="card center"><p class="big-text">이번 라운드는 구경해요</p><p class="hint">다음 라운드부터 함께할 수 있어요.</p></section>';
    }
    const inner = me.isLiar
      ? `<div class="liar">당신은 라이어!</div><div class="sub">카테고리는 "${esc(g.category)}"<br>다른 사람 설명을 듣고 들키지 않게 설명하세요</div>`
      : `<div class="sub">제시어</div><div class="word">${esc(me.word)}</div><div class="sub">라이어에게 들키지 않게 돌려서 설명하세요</div>`;
    return `
      <div class="word-card ${ui.holding ? 'revealed' : ''}" data-hold>
        <div class="cover">👆 꾹 누르고 있으면<br>제시어가 보여요</div>
        <div class="inner">${inner}</div>
      </div>`;
  }

  function liarResult(g) {
    const liarWon = g.winner === 'liar';
    let reason;
    if (!g.accusedId) reason = '라이어를 찾지 못했어요';
    else if (g.accusedId !== g.liarId) reason = `${esc(person(g.accusedId).name)}님은 시민이었어요!`;
    else if (g.guessCorrect) reason = `라이어가 제시어 "${esc(g.guess)}"를 맞혔어요!`;
    else if (g.guess) reason = `라이어의 답 "${esc(g.guess)}"는 틀렸어요`;
    else reason = '라이어가 제시어를 맞히지 못했어요';

    const votersFor = id => Object.keys(g.votes).filter(v => g.votes[v] === id);
    const max = Math.max(1, ...g.tally.map(t => t.votes));

    return `
      <div class="banner ${liarWon ? '' : 'blue'}">${liarWon ? '라이어 승리!' : '시민 승리!'}<small>${reason}</small></div>
      <section class="card">
        <dl class="kv">
          <dt>라이어</dt><dd>${pchip(g.liarId)}</dd>
          <dt>제시어</dt><dd>${esc(g.word)}</dd>
          ${g.fool ? `<dt>라이어의 단어</dt><dd>${esc(g.liarWord)}</dd>` : ''}
        </dl>
      </section>
      ${g.tally ? `<section class="card">
        <div class="label">${g.revote ? '재투표 결과' : '투표 결과'}</div>
        <div class="tally">${g.tally.map(t => {
          const p = person(t.id);
          const who = votersFor(t.id);
          return `<div class="tally-row" title="${who.length ? names(who) : ''}">
            <span class="who"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</span>
            <span class="bar"><i style="width:${(t.votes / max) * 100}%"></i></span>
            <span class="n">${t.votes}</span>
          </div>`;
        }).join('')}</div>
      </section>` : ''}
      <section class="card"><div class="label">점수</div>${rankingBlock(g.ranking, g.points)}</section>
      ${isHost() ? `<div class="actions">
        <button class="btn primary big" ${gameAct('next')}>${g.lastRound ? '최종 결과 보기' : '다음 라운드'}</button>
        ${g.guess ? `<button class="btn ghost" ${gameAct('flipJudge')}>판정 바꾸기 (${g.guessCorrect ? '오답으로' : '정답으로'})</button>` : ''}
      </div>` : waitingHost()}`;
  }

  // ------------------------------------------------------------ balance

  function balancePage(g) {
    if (g.phase === 'final') return finalBlock(g, '밸런스 게임 한 번 더');
    const q = g.question;
    const head = `<div class="phase-head"><div class="step">${g.index + 1}/${g.total}번째 질문 · ${esc(q.category)}</div>`;

    if (g.phase === 'answer') {
      const me = g.me;
      const side = s => {
        const on = me && me.choice === s;
        const dim = me && me.choice && !on;
        return `<button class="side ${s.toLowerCase()} ${on ? 'on' : ''} ${dim ? 'dim' : ''}" ${me ? gameAct('choose', `data-side="${s}"`) : 'disabled'}>${esc(s === 'A' ? q.a : q.b)}</button>`;
      };
      let step = '';
      if (me && !me.choice) step = '<p class="hint" style="text-align:center">둘 중 하나를 골라주세요</p>';
      if (me && me.choice && !me.predict) {
        step = `<section class="card center">
          <p class="big-text">다수는 어느 쪽을 골랐을까?</p>
          <div class="predict-row" style="width:100%">
            <button class="btn a big" ${gameAct('predict', 'data-side="A"')}>${esc(q.a)}</button>
            <button class="btn b big" ${gameAct('predict', 'data-side="B"')}>${esc(q.b)}</button>
          </div>
          <p class="hint">맞히면 1점! 반반이면 모두 1점이에요.</p>
        </section>`;
      }
      if (me && me.predict) step = `<div class="waiting">✅ 제출 완료! 다수 예측: "${esc(me.predict === 'A' ? q.a : q.b)}" · 다른 사람을 기다리는 중</div>`;

      return `
        ${head}<h2>당신의 선택은?</h2></div>
        ${timer(g.deadline)}
        <div class="vs">${side('A')}${side('B')}<div class="vs-badge">VS</div></div>
        ${step}
        <div class="progress">${g.answeredCount}/${g.playerCount}명 제출</div>
        ${hostBtn('바로 공개', gameAct('reveal'), 'big')}`;
    }

    // result
    const r = g.result;
    const total = r.aCount + r.bCount || 1;
    const bar = (s, count, text, ids) => `
      <div class="bar-row">
        <div class="bar-label"><span class="q">${esc(text)}${r.majority === s ? '<span class="tag">다수</span>' : ''}</span><span>${count}명 · ${Math.round((count / total) * 100)}%</span></div>
        <div class="bar ${s.toLowerCase()}"><i style="width:${(count / total) * 100}%"></i></div>
        ${ids && ids.length ? `<div class="players">${ids.map(id => pchip(id)).join('')}</div>` : ''}
      </div>`;
    let lonely = '';
    if (r.lonely) {
      const sideText = r.lonely.side === 'A' ? q.a : q.b;
      lonely = r.lonely.id
        ? `<section class="card center"><p class="big-text">🙋 ${esc(person(r.lonely.id).name)}님 혼자만<br>"${esc(sideText)}"</p></section>`
        : `<section class="card center"><p class="big-text">🙋 혼자만 "${esc(sideText)}"를 고른 사람이 있어요!</p></section>`;
    }
    let mine = '';
    if (g.me) {
      if (!g.me.answered) mine = '<div class="waiting">이번 질문은 제출하지 않았어요</div>';
      else mine = `<div class="waiting">${g.me.scored ? '🎯 예측 성공! +1점' : '😅 예측 실패'}</div>`;
    }
    return `
      ${head}<h2>${r.majority === 'tie' ? '정확히 반반!' : '결과 공개'}</h2></div>
      <section class="card"><div class="bars">${bar('A', r.aCount, q.a, r.a)}${bar('B', r.bCount, q.b, r.b)}</div></section>
      ${lonely}
      ${mine}
      <section class="card"><div class="label">점수</div>${rankingBlock(g.ranking)}</section>
      ${hostBtn(g.lastQuestion ? '최종 결과 보기' : '다음 질문', gameAct('next'))}
      ${waitingHost()}`;
  }

  // ------------------------------------------------------------ chosung

  function rankChip(id, label) {
    const p = person(id);
    return `<span class="pchip"><b class="rank-no">${label}</b><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</span>`;
  }

  function chosungCard(g) {
    const letters = [...g.chosung].map(ch => (ch === ' ' ? '<span class="gap"></span>' : `<span class="cho">${esc(ch)}</span>`)).join('');
    return `
      <section class="chosung-card">
        <div class="cho-row">${letters}</div>
        ${g.hint ? `<div class="hint-chip">힌트: "${esc(g.hint)}"(으)로 시작해요</div>` : ''}
      </section>`;
  }

  function chosungPage(g) {
    if (g.phase === 'final') return finalBlock(g, '초성 배틀 한 번 더');
    const head = `<div class="phase-head"><div class="step">${g.index + 1}/${g.total}번째 문제</div><h2>주제: ${esc(g.category)}</h2></div>`;

    if (g.phase === 'question') {
      const solvers = g.solvers.map((id, i) => rankChip(id, `${i + 1}등`)).join('');
      const mine = g.me && g.me.solved
        ? `<div class="banner blue">정답! ${g.me.rank}등<small>다른 사람이 맞히길 기다리는 중</small></div>`
        : '';
      return `
        ${head}
        ${chosungCard(g)}
        ${timer(g.deadline)}
        ${mine}
        <section class="card center">
          <div class="label">정답자 ${g.solvers.length}/${g.playerCount}명</div>
          ${solvers ? `<div class="players" style="justify-content:center">${solvers}</div>` : '<p class="hint">아직 아무도 못 맞혔어요</p>'}
        </section>
        ${hostBtn('정답 공개', gameAct('reveal'), 'ghost')}`;
    }

    // reveal
    const aliases = g.aliases.length ? `<small>${g.aliases.map(esc).join(', ')}도 정답</small>` : '';
    const solvers = g.solvers.length
      ? g.solvers.map((id, i) => `<div class="line">${rankChip(id, `${i + 1}등`)}<span class="plus">+${g.points[id]}</span></div>`).join('')
      : '<p class="hint">아무도 못 맞혔어요</p>';
    const near = g.near.filter(e => !e.solved);
    const nearBlock = near.length ? `
      <section class="card">
        <div class="label">아쉬운 답 (초성은 맞았어요)</div>
        ${near.map(e => `
          <div class="line">
            ${pchip(e.id)}<span class="quote">"${esc(e.text)}"</span>
            ${e.accepted ? '<span class="plus">인정 +1</span>' : ''}
            ${isHost() ? `<button class="btn small ${e.accepted ? 'ghost' : ''}" ${gameAct('accept', `data-index="${e.index}"`)}>${e.accepted ? '인정 취소' : '인정'}</button>` : ''}
          </div>`).join('')}
        ${isHost() ? '<p class="hint">주제에 맞는 답이면 [인정]을 눌러 1점을 주세요.</p>' : ''}
      </section>` : '';
    const wrongBlock = g.wrong.length ? `
      <section class="card">
        <div class="label">오답 모음</div>
        ${g.wrong.map(e => `<div class="line"><span class="quote">"${esc(e.text)}"</span><span class="muted">${esc(person(e.id).name)}</span></div>`).join('')}
      </section>` : '';
    return `
      ${head}
      <div class="banner">정답: ${esc(g.answer)}${aliases}</div>
      <section class="card"><div class="label">정답자</div>${solvers}</section>
      ${nearBlock}
      ${wrongBlock}
      <section class="card"><div class="label">점수</div>${rankingBlock(g.ranking, g.points)}</section>
      ${hostBtn(g.lastQuestion ? '최종 결과 보기' : '다음 문제', gameAct('next'))}
      ${waitingHost()}`;
  }

  // ------------------------------------------------------------ telepathy

  function scoreCard(label, score, title, sub) {
    return `
      <section class="card center">
        <div class="label">${label}</div>
        <div class="big-score">${score}<small>점</small></div>
        <p class="big-text">${esc(title)}</p>
        ${sub ? `<p class="hint">${sub}</p>` : ''}
      </section>`;
  }

  function telepathyPage(g) {
    const s = g.summary;
    if (g.phase === 'final') {
      const recap = `
        <section class="card">
          <div class="label">질문별 결과</div>
          ${g.history.map(r => `<div class="recap-row"><span>${r.same ? '💞' : '↔️'}</span><span>${esc(r.a)} vs ${esc(r.b)}</span><span class="${r.same ? 'plus' : 'muted'}">${r.same ? '통함' : '엇갈림'}</span></div>`).join('')}
        </section>`;
      return finalBlock(g, '텔레파시 한 번 더', scoreCard('텔레파시 지수', s.percent, s.label, `${s.total}문제 중 ${s.matches}번 통했어요`) + recap);
    }
    const q = g.question;
    const textOf = side => (side === 'A' ? q.a : side === 'B' ? q.b : '(고르지 않음)');
    const head = `<div class="phase-head"><div class="step">${g.index + 1}/${g.total}번째 질문 · ${esc(q.category)}</div>`;

    if (g.phase === 'answer') {
      const me = g.me;
      const side = sd => {
        const on = me && me.choice === sd;
        const dim = me && me.choice && !on;
        return `<button class="side ${sd.toLowerCase()} ${on ? 'on' : ''} ${dim ? 'dim' : ''}" ${me ? gameAct('choose', `data-side="${sd}"`) : 'disabled'}>${esc(textOf(sd))}</button>`;
      };
      let step;
      if (!me) step = `<section class="card center"><div class="players" style="justify-content:center">${g.pair.map(id => pchip(id)).join('')}</div><p class="hint">두 사람이 고르는 중이에요</p></section>`;
      else if (!me.choice) step = '<p class="hint" style="text-align:center">둘이 같은 쪽을 고르면 통한 거예요!</p>';
      else step = `<div class="waiting">✅ 골랐어요! ${esc(person(me.partnerId).name)}님을 기다리는 중 · 바꾸려면 다시 누르세요</div>`;
      return `
        ${head}<h2>${me ? '당신의 선택은?' : '둘의 선택은?'}</h2></div>
        ${timer(g.deadline)}
        <div class="vs">${side('A')}${side('B')}<div class="vs-badge">VS</div></div>
        ${step}
        <div class="progress">${g.answeredCount}/2명 선택</div>
        ${hostBtn('바로 공개', gameAct('reveal'), 'big')}`;
    }

    // result
    const r = g.result;
    const rows = g.pair.map(id => `<div class="line">${pchip(id)}<span class="quote">"${esc(textOf(r.choices[id]))}"</span></div>`).join('');
    return `
      ${head}<h2>${esc(q.a)} vs ${esc(q.b)}</h2></div>
      <div class="banner ${r.same ? '' : 'blue'}">${r.same ? '통했다! 💞' : '엇갈렸다!'}<small>${r.same ? '둘이 같은 쪽을 골랐어요' : '서로 다른 쪽을 골랐어요'}</small></div>
      <section class="card">${rows}</section>
      <div class="progress">지금까지 ${s.total}문제 중 ${s.matches}번 통했어요</div>
      ${hostBtn(g.lastQuestion ? '최종 결과 보기' : '다음 질문', gameAct('next'))}
      ${waitingHost()}`;
  }

  // ------------------------------------------------------------ weknow

  function weknowPage(g) {
    const s = g.summary;
    if (g.phase === 'final') {
      const extra = s.pair
        ? scoreCard('우리 궁합', s.score, s.label, '서로의 답을 맞힌 비율이에요')
        : scoreCard('우리의 이해도', s.score, s.label, '모두가 주인공의 답을 맞힌 비율이에요');
      return finalBlock(g, '우리 얼마나 알까 한 번 더', extra);
    }
    const subject = person(g.subjectId).name;
    const head = `
      <div class="phase-head">
        <div class="step">${g.index + 1}/${g.total}번째 질문 · 주인공 ${esc(subject)}</div>
        <h2>${esc(g.text)}</h2>
      </div>`;

    if (g.phase === 'answer') {
      const me = g.me;
      let label = `${esc(subject)}님이 고르는 중이에요`;
      if (me && me.isSubject) label = '나에 대한 질문이에요. 솔직하게 골라주세요!';
      else if (me) label = `${esc(subject)}님은 뭐라고 답했을까요?`;
      const options = g.options.map((text, i) => `
        <button class="option-btn ${me && me.pick === i ? 'on' : ''}" ${me ? gameAct('pick', `data-option="${i}"`) : 'disabled'}>${esc(text)}</button>`).join('');
      return `
        ${head}
        ${timer(g.deadline)}
        <p class="hint" style="text-align:center">${label}</p>
        <div class="option-list">${options}</div>
        <div class="progress">${g.subjectAnswered ? '주인공 답변 완료 ✓' : '주인공이 고르는 중...'} · ${g.guessedCount}/${g.guesserCount}명 예측 완료</div>
        ${hostBtn('바로 공개', gameAct('reveal'), 'big')}`;
    }

    // result
    if (g.answer === null) {
      return `
        ${head}
        <section class="card center"><p class="big-text">${esc(subject)}님이 답하지 않았어요</p><p class="hint">이번 문제는 점수 없이 넘어가요.</p></section>
        ${hostBtn(g.lastQuestion ? '최종 결과 보기' : '다음 질문', gameAct('next'))}
        ${waitingHost()}`;
    }
    const pickedBy = i => Object.keys(g.guesses).filter(id => g.guesses[id] === i);
    const options = g.options.map((text, i) => {
      const who = pickedBy(i);
      return `
        <div class="option-btn result ${i === g.answer ? 'correct' : 'dim'}">
          <span>${i === g.answer ? '✅ ' : ''}${esc(text)}</span>
          ${who.length ? `<span class="players">${who.map(id => pchip(id)).join('')}</span>` : ''}
        </div>`;
    }).join('');
    let mine = '';
    if (g.me && !g.me.isSubject) mine = `<div class="waiting">${g.correct.includes(state.me.id) ? '🎯 맞혔어요! +1점' : '😅 아쉬워요'}</div>`;
    return `
      ${head}
      <div class="option-list">${options}</div>
      <div class="progress">${g.correct.length}명이 맞혔어요</div>
      ${mine}
      <section class="card"><div class="label">점수</div>${rankingBlock(g.ranking)}</section>
      ${hostBtn(g.lastQuestion ? '최종 결과 보기' : '다음 질문', gameAct('next'))}
      ${waitingHost()}`;
  }

  // ------------------------------------------------------------ whoami

  function whoamiCard(c, isMe) {
    const p = person(c.id);
    const word = c.word
      ? `<div class="wa-word">${esc(c.word)}</div>`
      : `<div class="wa-word hidden">${isMe ? '❓❓❓' : '???'}</div>`;
    return `
      <div class="wa-card ${isMe ? 'me' : ''} ${c.rank ? 'solved' : ''}">
        <div class="wa-name"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${isMe ? ' (나)' : ''}</div>
        ${word}
        ${c.category ? `<div class="wa-cat">${esc(c.category)}</div>` : ''}
        ${c.rank ? `<div class="wa-rank">${c.rank}등 탈출</div>` : ''}
      </div>`;
  }

  function wrongList(g) {
    if (!g.wrongs.length) return '';
    return `
      <section class="card">
        <div class="label">헛다리 모음</div>
        ${g.wrongs.map(w => `<div class="line"><span class="quote">"${esc(w.text)}"</span><span class="muted">${esc(person(w.id).name)}</span></div>`).join('')}
      </section>`;
  }

  function whoamiPage(g) {
    const myId = meId();
    const mine = g.cards.find(c => c.id === myId);
    const others = g.cards.filter(c => c.id !== myId);
    const grid = `<div class="wa-grid">${others.map(c => whoamiCard(c, false)).join('')}</div>`;

    if (g.phase === 'final') {
      const loser = g.loser ? `<div class="banner">벌칙 당첨!<small>${esc(person(g.loser).name)}님이 끝까지 못 맞혔어요</small></div>` : '';
      const all = `<section class="card"><div class="label">모두의 단어</div><div class="wa-grid">${g.cards.map(c => whoamiCard(c, c.id === myId)).join('')}</div></section>`;
      return finalBlock(g, '나는 누구게? 한 번 더', loser + all + wrongList(g));
    }

    const turnName = g.current ? person(g.current).name : '';
    const me = g.me;
    let title = `${esc(turnName)}님 차례`;
    if (me && me.isTurn) title = '내 차례! 질문하고 맞혀보세요';
    else if (!g.current) title = '차례를 기다리는 중';
    const step = `남은 사람 ${g.remaining.length}명 · 탈출 ${g.solved.length}명${g.category ? ` · 주제 ${esc(g.category)}` : ''}`;

    let action = '';
    if (me && me.isTurn) {
      action = `
        <form class="card" data-act="whoami-guess">
          <div class="label">"나 먹는 거야?"처럼 예/아니오로 물어보고, 알 것 같으면 맞혀보세요</div>
          <div class="row">
            <input id="wa-guess" maxlength="30" placeholder="내 단어는?" autocomplete="off">
            <button class="btn primary" type="submit">맞히기</button>
          </div>
          <button class="btn ghost" type="button" ${gameAct('pass')}>질문만 하고 넘기기</button>
          ${g.penalty === 'skip' ? '<p class="hint">틀리면 다음 차례를 한 번 쉬어요.</p>' : ''}
        </form>`;
    } else if (me && me.rank) {
      action = '<div class="waiting">탈출 성공! 다른 사람들의 질문에 대답해 주세요</div>';
    } else if (me) {
      action = `<div class="waiting">${esc(turnName)}님의 질문에 대답해 주세요${me.skipping ? ' · 다음 차례는 쉬어요' : ''}</div>`;
    }

    return `
      <div class="phase-head"><div class="step">${step}</div><h2>${title}</h2></div>
      ${timer(g.deadline)}
      ${mine ? `<div class="wa-mine">${whoamiCard(mine, true)}</div>` : ''}
      ${action}
      <section class="card"><div class="label">${state.me ? '다른 사람들의 단어 (본인은 몰라요!)' : '참가자'}</div>${grid}</section>
      ${wrongList(g)}
      ${isHost() && !(me && me.isTurn) ? `<div class="actions"><button class="btn" ${gameAct('pass')}>${esc(turnName)}님 차례 넘기기</button><button class="btn ghost" ${gameAct('end')}>여기서 끝내기</button></div>` : ''}`;
  }

  render();
})();
