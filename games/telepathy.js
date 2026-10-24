'use strict';

const { shuffle, oneOf, pairLabel, setPhase, ranking } = require('./util');
const DATA = require('../data/balance.json');

const ANSWER_MS = 30000;

const info = {
  key: 'telepathy',
  title: '텔레파시',
  tagline: '둘이서 같은 질문에 답하고, 서로의 선택을 맞혀보세요!',
  minPlayers: 2,
  maxPlayers: 2,
  recommended: '2명 전용',
  minutes: '5분',
};

const catalog = { categories: DATA.categories.map(c => c.name) };
const defaultSettings = { count: 7, category: 'all' };

function normalizeSettings(s) {
  return {
    count: oneOf(Number(s.count), [5, 7, 10], 7),
    category: oneOf(s.category, ['all', ...catalog.categories], 'all'),
  };
}

function create(ctx, settings) {
  const s = normalizeSettings(settings);
  const pool = DATA.categories
    .filter(c => s.category === 'all' || c.name === s.category)
    .flatMap(c => c.questions.map(([a, b]) => ({ category: c.name, a, b })));
  const game = {
    settings: s,
    pair: ctx.connected().map(p => p.id).slice(0, 2),
    questions: shuffle(pool).slice(0, s.count),
    index: -1,
    answers: {},
    history: [],
    phase: null,
    deadline: null,
    timer: null,
  };
  nextQuestion(game, ctx);
  return game;
}

function nextQuestion(game, ctx) {
  game.index += 1;
  game.answers = {};
  setPhase(game, ctx, 'answer', ANSWER_MS, () => reveal(game, ctx));
}

function complete(answer) {
  return Boolean(answer && answer.choice && answer.guess);
}

function partnerOf(game, id) {
  return game.pair.find(p => p !== id) || null;
}

function checkAll(game, ctx) {
  const present = game.pair.filter(ctx.isConnected);
  if (present.length && present.every(id => complete(game.answers[id]))) reveal(game, ctx);
}

function reveal(game, ctx) {
  const [x, y] = game.pair;
  const ax = game.answers[x] || {};
  const ay = game.answers[y] || {};
  game.history.push({
    question: game.questions[game.index],
    answers: { [x]: { ...ax }, [y]: { ...ay } },
    hits: {
      [x]: Boolean(ax.guess && ay.choice && ax.guess === ay.choice),
      [y]: Boolean(ay.guess && ax.choice && ay.guess === ax.choice),
    },
    same: Boolean(ax.choice && ax.choice === ay.choice),
  });
  setPhase(game, ctx, 'result');
}

function scoresOf(game) {
  const scores = {};
  for (const r of game.history) {
    for (const [id, hit] of Object.entries(r.hits)) if (hit) scores[id] = (scores[id] || 0) + 1;
  }
  return scores;
}

// 텔레파시 지수: 서로의 선택을 맞힌 비율. 일치율: 같은 쪽을 고른 비율.
function summary(game) {
  const n = game.history.length || 1;
  const hits = game.history.reduce((sum, r) => sum + Object.values(r.hits).filter(Boolean).length, 0);
  const same = game.history.filter(r => r.same).length;
  const telepathy = Math.round((hits / (2 * n)) * 100);
  return { telepathy, match: Math.round((same / n) * 100), label: pairLabel(telepathy) };
}

function action(game, ctx, pid, msg, isHost) {
  const hostDenied = { ok: false, error: '방장만 할 수 있어요.' };
  switch (msg.type) {
    case 'choose':
    case 'guess': {
      if (game.phase !== 'answer') return { ok: false };
      if (!game.pair.includes(pid)) return { ok: false, error: '이번 게임은 구경만 할 수 있어요.' };
      const side = oneOf(msg.side, ['A', 'B'], null);
      if (!side) return { ok: false };
      const answer = game.answers[pid] || (game.answers[pid] = {});
      if (msg.type === 'guess' && !answer.choice) return { ok: false };
      answer[msg.type === 'choose' ? 'choice' : 'guess'] = side;
      return checkAll(game, ctx);
    }

    case 'reveal':
      if (!isHost) return hostDenied;
      if (game.phase !== 'answer') return { ok: false };
      return reveal(game, ctx);

    case 'next':
      if (!isHost) return hostDenied;
      if (game.phase !== 'result') return { ok: false };
      if (game.index + 1 >= game.questions.length) return setPhase(game, ctx, 'final');
      return nextQuestion(game, ctx);

    default:
      return { ok: false };
  }
}

function onPresence(game, ctx) {
  if (game.phase === 'answer') checkAll(game, ctx);
}

function view(game, ctx, pid) {
  const v = {
    phase: game.phase,
    index: game.index,
    total: game.questions.length,
    question: game.questions[game.index],
    pair: game.pair,
    deadline: game.deadline,
    answeredCount: game.pair.filter(id => complete(game.answers[id])).length,
    ranking: ranking(scoresOf(game), ctx.room),
    lastQuestion: game.index + 1 >= game.questions.length,
    summary: summary(game),
  };
  if (pid && game.pair.includes(pid)) {
    const answer = game.answers[pid] || {};
    v.me = { choice: answer.choice || null, guess: answer.guess || null, partnerId: partnerOf(game, pid) };
  }
  if (game.phase === 'result') v.result = game.history[game.history.length - 1];
  if (game.phase === 'final') v.titles = [];
  return v;
}

function dispose(game) {
  clearTimeout(game.timer);
}

module.exports = { info, catalog, defaultSettings, normalizeSettings, create, action, onPresence, view, dispose };
