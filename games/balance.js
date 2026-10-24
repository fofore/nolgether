'use strict';

const { shuffle, oneOf, setPhase, ranking, topOf } = require('./util');
const DATA = require('../data/balance.json');

const ANSWER_MS = 25000;

const info = {
  key: 'balance',
  title: '밸런스 게임',
  tagline: '둘 중 하나를 고르고, 다수가 뭘 골랐을지 맞혀보세요!',
  minPlayers: 2,
  recommended: '3명 이상',
  minutes: '5분',
};

const catalog = { categories: DATA.categories.map(c => c.name) };
const defaultSettings = { count: 7, category: 'all', anonymous: false };

function normalizeSettings(s) {
  return {
    count: oneOf(Number(s.count), [5, 7, 10], 7),
    category: oneOf(s.category, ['all', ...catalog.categories], 'all'),
    anonymous: s.anonymous === true,
  };
}

function create(ctx, settings) {
  const s = normalizeSettings(settings);
  const pool = DATA.categories
    .filter(c => s.category === 'all' || c.name === s.category)
    .flatMap(c => c.questions.map(([a, b]) => ({ category: c.name, a, b })));
  const game = {
    settings: s,
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
  return Boolean(answer && answer.choice && answer.predict);
}

function checkAll(game, ctx) {
  const ids = ctx.connected().map(p => p.id);
  if (ids.length && ids.every(id => complete(game.answers[id]))) reveal(game, ctx);
}

function reveal(game, ctx) {
  const answers = game.answers;
  const a = Object.keys(answers).filter(id => answers[id].choice === 'A');
  const b = Object.keys(answers).filter(id => answers[id].choice === 'B');
  const majority = a.length > b.length ? 'A' : b.length > a.length ? 'B' : 'tie';
  let lonely = null;
  if (a.length === 1 && b.length >= 2) lonely = { id: a[0], side: 'A' };
  if (b.length === 1 && a.length >= 2) lonely = { id: b[0], side: 'B' };
  game.history.push({ question: game.questions[game.index], answers: { ...answers }, a, b, majority, lonely });
  setPhase(game, ctx, 'result');
}

// 예측까지 제출한 사람만 점수를 받는다. 반반이면 예측한 사람 모두 정답.
function questionPoints(record) {
  const points = {};
  for (const [id, ans] of Object.entries(record.answers)) {
    if (!complete(ans)) continue;
    if (record.majority === 'tie' || ans.predict === record.majority) points[id] = 1;
  }
  return points;
}

function scoresOf(game) {
  const scores = {};
  for (const record of game.history) {
    for (const [id, pts] of Object.entries(questionPoints(record))) scores[id] = (scores[id] || 0) + pts;
  }
  return scores;
}

function titlesOf(game) {
  const titles = [{ title: '눈치 백단', desc: '다수의 선택을 가장 많이 맞힘', ids: topOf(scoresOf(game)) }];
  if (!game.settings.anonymous) {
    const minority = {};
    const lonely = {};
    for (const record of game.history) {
      if (record.majority !== 'tie') {
        const side = record.majority === 'A' ? record.b : record.a;
        for (const id of side) minority[id] = (minority[id] || 0) + 1;
      }
      if (record.lonely) lonely[record.lonely.id] = (lonely[record.lonely.id] || 0) + 1;
    }
    titles.push({ title: '마이웨이', desc: '소수 의견을 가장 많이 고름', ids: topOf(minority) });
    titles.push({ title: '나 혼자 다른 길', desc: '혼자만 다른 쪽을 가장 많이 고름', ids: topOf(lonely) });
  }
  return titles.filter(t => t.ids.length);
}

function action(game, ctx, pid, msg, isHost) {
  const hostDenied = { ok: false, error: '방장만 할 수 있어요.' };
  switch (msg.type) {
    case 'choose':
    case 'predict': {
      if (game.phase !== 'answer') return { ok: false };
      const side = oneOf(msg.side, ['A', 'B'], null);
      if (!side) return { ok: false };
      const answer = game.answers[pid] || (game.answers[pid] = {});
      if (msg.type === 'predict' && !answer.choice) return { ok: false };
      answer[msg.type === 'choose' ? 'choice' : 'predict'] = side;
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
  const connectedIds = ctx.connected().map(p => p.id);
  const v = {
    phase: game.phase,
    index: game.index,
    total: game.questions.length,
    question: game.questions[game.index],
    deadline: game.deadline,
    anonymous: game.settings.anonymous,
    answeredCount: connectedIds.filter(id => complete(game.answers[id])).length,
    playerCount: connectedIds.length,
    ranking: ranking(scoresOf(game), ctx.room),
    lastQuestion: game.index + 1 >= game.questions.length,
  };

  if (pid) {
    const answer = game.answers[pid] || {};
    v.me = { choice: answer.choice || null, predict: answer.predict || null };
  }

  if (game.phase === 'result') {
    const record = game.history[game.history.length - 1];
    v.result = {
      aCount: record.a.length,
      bCount: record.b.length,
      majority: record.majority,
      a: game.settings.anonymous ? null : record.a,
      b: game.settings.anonymous ? null : record.b,
      lonely: record.lonely && { side: record.lonely.side, id: game.settings.anonymous ? null : record.lonely.id },
    };
    if (pid) {
      const mine = record.answers[pid];
      v.me.scored = Boolean(questionPoints(record)[pid]);
      v.me.answered = complete(mine);
    }
  }

  if (game.phase === 'final') v.titles = titlesOf(game);
  return v;
}

function dispose(game) {
  clearTimeout(game.timer);
}

module.exports = { info, catalog, defaultSettings, normalizeSettings, create, action, onPresence, view, dispose };
