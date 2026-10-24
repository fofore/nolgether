'use strict';

const { shuffle, oneOf, normalizeAnswer, setPhase, topOf } = require('./util');
const DATA = require('../data/chosung.json');

// 초성 배틀 단어를 쓴다. "단어|허용답" 형식이라 다르게 써도 정답 처리할 수 있다.
const CATEGORIES = DATA.categories.map(c => ({
  name: c.name,
  words: c.words.map(entry => {
    const [main, ...aliases] = entry.split('|');
    return { main, answers: [main, ...aliases], category: c.name };
  }),
}));

const info = {
  key: 'whoami',
  title: '나는 누구게?',
  tagline: '내 단어만 몰라요! 질문으로 힌트를 얻어 내 단어를 맞혀보세요.',
  minPlayers: 2,
  recommended: '3~8명',
  minutes: '10분',
};

const catalog = { categories: CATEGORIES.map(c => c.name) };
const defaultSettings = { category: 'random', turnSeconds: 60, penalty: 'none' };

function normalizeSettings(s) {
  return {
    category: oneOf(s.category, ['random', ...catalog.categories], 'random'),
    turnSeconds: oneOf(Number(s.turnSeconds), [0, 30, 60], 60),
    penalty: oneOf(s.penalty, ['none', 'skip'], 'none'),
  };
}

function create(ctx, settings) {
  const s = normalizeSettings(settings);
  const order = shuffle(ctx.connected().map(p => p.id));
  const pool = shuffle(CATEGORIES
    .filter(c => s.category === 'random' || c.name === s.category)
    .flatMap(c => c.words));
  const words = {};
  order.forEach((id, i) => { words[id] = pool[i % pool.length]; });
  const game = {
    settings: s,
    order,
    words,
    turn: -1,
    solved: [],
    wrongs: [],
    skipNext: {},
    phase: null,
    deadline: null,
    timer: null,
  };
  nextTurn(game, ctx);
  return game;
}

function remaining(game) {
  return game.order.filter(id => !game.solved.includes(id));
}

function current(game) {
  return game.turn >= 0 ? game.order[game.turn] : null;
}

// 다음 차례를 찾는다. 맞힌 사람, 연결이 끊긴 사람, "한 번 쉬기"인 사람은 건너뛴다.
function nextTurn(game, ctx) {
  if (remaining(game).length <= 1) return finish(game, ctx);
  for (let step = 0; step < game.order.length * 2; step++) {
    game.turn = (game.turn + 1) % game.order.length;
    const id = game.order[game.turn];
    if (game.solved.includes(id) || !ctx.isConnected(id)) continue;
    if (game.skipNext[id]) {
      delete game.skipNext[id];
      continue;
    }
    const ms = game.settings.turnSeconds * 1000;
    return setPhase(game, ctx, 'play', ms, () => nextTurn(game, ctx));
  }
  // 남은 사람이 모두 연결이 끊겼으면 기다린다.
  setPhase(game, ctx, 'play');
}

function finish(game, ctx) {
  game.turn = -1;
  setPhase(game, ctx, 'final');
}

function titlesOf(game) {
  const wrong = {};
  for (const w of game.wrongs) wrong[w.id] = (wrong[w.id] || 0) + 1;
  return [
    { title: '추리왕', desc: '가장 먼저 자기 단어를 맞힘', ids: game.solved.slice(0, 1) },
    { title: '헛다리 장인', desc: '가장 많이 틀린 답을 외침', ids: topOf(wrong) },
  ].filter(t => t.ids.length);
}

function action(game, ctx, pid, msg, isHost) {
  const hostDenied = { ok: false, error: '방장만 할 수 있어요.' };
  const isTurn = game.phase === 'play' && current(game) === pid;
  switch (msg.type) {
    case 'guess': {
      if (!isTurn) return { ok: false, error: '내 차례에만 맞힐 수 있어요.' };
      const text = String(msg.text || '').normalize('NFC').trim().slice(0, 30);
      if (!text) return { ok: false, error: '단어를 입력해 주세요.' };
      const word = game.words[pid];
      const correct = word.answers.some(a => normalizeAnswer(a) === normalizeAnswer(text));
      if (correct) {
        game.solved.push(pid);
      } else {
        game.wrongs.push({ id: pid, text });
        if (game.settings.penalty === 'skip') game.skipNext[pid] = true;
      }
      nextTurn(game, ctx);
      return { ok: true, verdict: correct ? 'correct' : 'wrong', rank: correct ? game.solved.length : null };
    }

    // 질문만 하고 다음 사람에게 넘긴다.
    case 'pass':
      if (!isTurn && !isHost) return { ok: false };
      if (game.phase !== 'play') return { ok: false };
      return nextTurn(game, ctx);

    case 'end':
      if (!isHost) return hostDenied;
      if (game.phase !== 'play') return { ok: false };
      return finish(game, ctx);

    default:
      return { ok: false };
  }
}

function onPresence(game, ctx) {
  if (game.phase !== 'play') return;
  const now = current(game);
  if (now === null || !ctx.isConnected(now)) nextTurn(game, ctx);
}

function view(game, ctx, pid) {
  const done = game.phase === 'final';
  const mixed = game.settings.category === 'random';
  const cards = game.order.map(id => {
    const word = game.words[id];
    const rank = game.solved.indexOf(id) + 1;
    // 내 단어는 맞히기 전까지 안 보인다. 큰 화면(pid 없음)에는 맞힌 사람 단어만 보인다.
    const visible = done || rank > 0 || (pid && id !== pid);
    return {
      id,
      word: visible ? word.main : null,
      category: visible || (mixed && id === pid) ? word.category : null,
      rank: rank || null,
    };
  });
  const v = {
    phase: game.phase,
    current: current(game),
    deadline: game.deadline,
    cards,
    solved: game.solved,
    remaining: remaining(game),
    wrongs: game.wrongs.slice(-8),
    mixed,
    category: mixed ? null : game.settings.category,
    penalty: game.settings.penalty,
  };
  if (pid && game.order.includes(pid)) {
    const rank = game.solved.indexOf(pid) + 1;
    v.me = { isTurn: game.phase === 'play' && current(game) === pid, rank: rank || null, skipping: Boolean(game.skipNext[pid]) };
  }
  if (done) {
    const left = remaining(game);
    v.loser = left.length === 1 ? left[0] : null;
    v.titles = titlesOf(game);
  }
  return v;
}

function dispose(game) {
  clearTimeout(game.timer);
}

module.exports = { info, catalog, defaultSettings, normalizeSettings, create, action, onPresence, view, dispose };
