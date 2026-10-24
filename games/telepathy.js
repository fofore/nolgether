'use strict';

const { shuffle, oneOf, pairLabel, setPhase } = require('./util');
const DATA = require('../data/balance.json');

const ANSWER_MS = 25000;

const info = {
  key: 'telepathy',
  title: '텔레파시',
  tagline: '둘이서 같은 질문에 답하고, 얼마나 통하는지 확인해 보세요!',
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
    choices: {},
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
  game.choices = {};
  setPhase(game, ctx, 'answer', ANSWER_MS, () => reveal(game, ctx));
}

function checkAll(game, ctx) {
  const present = game.pair.filter(ctx.isConnected);
  if (present.length && present.every(id => game.choices[id])) reveal(game, ctx);
}

// 둘 다 같은 쪽을 고르면 통한 것으로 본다.
function reveal(game, ctx) {
  const [x, y] = game.pair;
  const choices = { [x]: game.choices[x] || null, [y]: game.choices[y] || null };
  game.history.push({
    question: game.questions[game.index],
    choices,
    same: Boolean(choices[x] && choices[x] === choices[y]),
  });
  setPhase(game, ctx, 'result');
}

function summary(game) {
  const total = game.history.length;
  const matches = game.history.filter(r => r.same).length;
  const percent = total ? Math.round((matches / total) * 100) : 0;
  return { matches, total, percent, label: pairLabel(percent) };
}

function action(game, ctx, pid, msg, isHost) {
  const hostDenied = { ok: false, error: '방장만 할 수 있어요.' };
  switch (msg.type) {
    case 'choose': {
      if (game.phase !== 'answer') return { ok: false };
      if (!game.pair.includes(pid)) return { ok: false, error: '이번 게임은 구경만 할 수 있어요.' };
      const side = oneOf(msg.side, ['A', 'B'], null);
      if (!side) return { ok: false };
      game.choices[pid] = side;
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
    answeredCount: game.pair.filter(id => game.choices[id]).length,
    lastQuestion: game.index + 1 >= game.questions.length,
    summary: summary(game),
  };
  if (pid && game.pair.includes(pid)) {
    v.me = { choice: game.choices[pid] || null, partnerId: game.pair.find(id => id !== pid) || null };
  }
  if (game.phase === 'result') v.result = game.history[game.history.length - 1];
  if (game.phase === 'final') {
    v.history = game.history.map(r => ({ a: r.question.a, b: r.question.b, choices: r.choices, same: r.same }));
  }
  return v;
}

function dispose(game) {
  clearTimeout(game.timer);
}

module.exports = { info, catalog, defaultSettings, normalizeSettings, create, action, onPresence, view, dispose };
