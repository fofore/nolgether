'use strict';

const { shuffle, oneOf, pairLabel, setPhase, ranking, topOf } = require('./util');
const DATA = require('../data/weknow.json');

const ANSWER_MS = 30000;

const info = {
  key: 'weknow',
  title: '우리 얼마나 알까',
  tagline: '돌아가며 주인공이 되어, 서로를 얼마나 아는지 맞혀보세요!',
  minPlayers: 2,
  recommended: '2~8명',
  minutes: '10분',
};

const catalog = { categories: DATA.categories.map(c => c.name) };
const defaultSettings = { count: 10, category: 'all' };

function normalizeSettings(s) {
  return {
    count: oneOf(Number(s.count), [6, 10, 14], 10),
    category: oneOf(s.category, ['all', ...catalog.categories], 'all'),
  };
}

function create(ctx, settings) {
  const s = normalizeSettings(settings);
  const pool = DATA.categories
    .filter(c => s.category === 'all' || c.name === s.category)
    .flatMap(c => c.questions);
  const game = {
    settings: s,
    players: shuffle(ctx.connected().map(p => p.id)),
    questions: shuffle(pool),
    count: s.count,
    index: -1,
    turn: -1,
    r: null,
    history: [],
    phase: null,
    deadline: null,
    timer: null,
  };
  nextQuestion(game, ctx);
  return game;
}

// 주인공은 참가자를 차례로 돌되, 연결이 끊긴 사람은 건너뛴다.
function nextSubject(game, ctx) {
  for (let i = 0; i < game.players.length; i++) {
    game.turn = (game.turn + 1) % game.players.length;
    const id = game.players[game.turn];
    if (ctx.isConnected(id)) return id;
  }
  return game.players[game.turn];
}

function nextQuestion(game, ctx) {
  game.index += 1;
  game.r = {
    subjectId: nextSubject(game, ctx),
    question: game.questions[game.index % game.questions.length],
    answer: null,
    guesses: {},
  };
  setPhase(game, ctx, 'answer', ANSWER_MS, () => reveal(game, ctx));
}

function guessers(game, ctx) {
  return game.players.filter(id => id !== game.r.subjectId && ctx.isConnected(id));
}

function checkAll(game, ctx) {
  const r = game.r;
  if (r.answer === null) return;
  if (guessers(game, ctx).every(id => r.guesses[id] !== undefined)) reveal(game, ctx);
}

function reveal(game, ctx) {
  game.history.push(game.r);
  setPhase(game, ctx, 'result');
}

function correctIds(r) {
  if (r.answer === null) return [];
  return Object.keys(r.guesses).filter(id => r.guesses[id] === r.answer);
}

function scoresOf(game) {
  const scores = {};
  for (const r of game.history) for (const id of correctIds(r)) scores[id] = (scores[id] || 0) + 1;
  return scores;
}

// 궁합 점수: 주인공의 답을 맞힌 비율 (답이 없던 문제는 제외)
function summary(game) {
  const counted = game.history.filter(r => r.answer !== null);
  const total = counted.reduce((sum, r) => sum + Object.keys(r.guesses).length, 0);
  const hits = counted.reduce((sum, r) => sum + correctIds(r).length, 0);
  const score = total ? Math.round((hits / total) * 100) : 0;
  return { score, label: pairLabel(score), pair: game.players.length === 2 };
}

function titlesOf(game) {
  const known = {};
  const asked = {};
  for (const r of game.history) {
    if (r.answer === null) continue;
    const n = Object.keys(r.guesses).length;
    if (!n) continue;
    asked[r.subjectId] = (asked[r.subjectId] || 0) + n;
    known[r.subjectId] = (known[r.subjectId] || 0) + correctIds(r).length;
  }
  const ratio = Object.fromEntries(Object.keys(asked).map(id => [id, known[id] / asked[id]]));
  const values = Object.values(ratio);
  const titles = [{ title: '찐친 인증', desc: '다른 사람의 답을 가장 많이 맞힘', ids: topOf(scoresOf(game)) }];
  if (values.length >= 2 && Math.min(...values) < Math.max(...values)) {
    const min = Math.min(...values);
    titles.push({ title: '미스터리한 사람', desc: '답을 맞히기 가장 어려웠던 주인공', ids: Object.keys(ratio).filter(id => ratio[id] === min) });
  }
  return titles.filter(t => t.ids.length);
}

function action(game, ctx, pid, msg, isHost) {
  const hostDenied = { ok: false, error: '방장만 할 수 있어요.' };
  const r = game.r;
  switch (msg.type) {
    case 'pick': {
      if (game.phase !== 'answer') return { ok: false };
      if (!game.players.includes(pid)) return { ok: false, error: '이번 게임은 구경만 할 수 있어요.' };
      const choice = Number(msg.option);
      if (!Number.isInteger(choice) || choice < 0 || choice >= r.question.options.length) return { ok: false };
      if (pid === r.subjectId) r.answer = choice;
      else r.guesses[pid] = choice;
      return checkAll(game, ctx);
    }

    case 'reveal':
      if (!isHost) return hostDenied;
      if (game.phase !== 'answer') return { ok: false };
      return reveal(game, ctx);

    case 'next':
      if (!isHost) return hostDenied;
      if (game.phase !== 'result') return { ok: false };
      if (game.index + 1 >= game.count) return setPhase(game, ctx, 'final');
      return nextQuestion(game, ctx);

    default:
      return { ok: false };
  }
}

function onPresence(game, ctx) {
  if (game.phase === 'answer') checkAll(game, ctx);
}

function view(game, ctx, pid) {
  const r = game.r;
  const subject = ctx.room.players.find(p => p.id === r.subjectId);
  const v = {
    phase: game.phase,
    index: game.index,
    total: game.count,
    subjectId: r.subjectId,
    text: r.question.q.replace(/\{name\}/g, subject ? subject.name : '주인공'),
    options: r.question.options,
    deadline: game.deadline,
    subjectAnswered: r.answer !== null,
    guessedCount: Object.keys(r.guesses).length,
    guesserCount: guessers(game, ctx).length,
    ranking: ranking(scoresOf(game), ctx.room),
    lastQuestion: game.index + 1 >= game.count,
    summary: summary(game),
  };
  if (pid && game.players.includes(pid)) {
    v.me = { isSubject: pid === r.subjectId, pick: pid === r.subjectId ? r.answer : (r.guesses[pid] ?? null) };
  }
  if (game.phase !== 'answer') {
    v.answer = r.answer;
    v.guesses = r.guesses;
    v.correct = correctIds(r);
  }
  if (game.phase === 'final') v.titles = titlesOf(game);
  return v;
}

function dispose(game) {
  clearTimeout(game.timer);
}

module.exports = { info, catalog, defaultSettings, normalizeSettings, create, action, onPresence, view, dispose };
