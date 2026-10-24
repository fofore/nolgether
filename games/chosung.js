'use strict';

const { shuffle, oneOf, normalizeAnswer, setPhase, ranking, topOf } = require('./util');
const DATA = require('../data/chosung.json');

const HINT_AT = 0.5; // 제한시간의 절반이 지나면 첫 글자 공개
const SUBMIT_GAP_MS = 400;
const MAX_ATTEMPTS = 40;
const RANK_POINTS = [3, 2, 1];
const LATE_POINTS = 1;
const ACCEPTED_POINTS = 1;

const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

function chosungOf(text) {
  return [...text].map(ch => {
    const code = ch.charCodeAt(0);
    return code >= 0xac00 && code <= 0xd7a3 ? CHOSUNG[Math.floor((code - 0xac00) / 588)] : ch;
  }).join('');
}

const CATEGORIES = DATA.categories.map(c => ({
  name: c.name,
  words: c.words.map(entry => {
    const [main, ...aliases] = entry.split('|');
    return { main, answers: [main, ...aliases], chosung: chosungOf(main) };
  }),
}));

// 정답 목록에 있으면 correct, 초성은 맞는데 목록에 없으면 near(방장이 인정 가능), 아니면 mismatch
function judge(word, text) {
  const guess = normalizeAnswer(text);
  if (!guess) return 'empty';
  if (word.answers.some(a => normalizeAnswer(a) === guess)) return 'correct';
  return chosungOf(guess) === chosungOf(normalizeAnswer(word.main)) ? 'near' : 'mismatch';
}

const info = {
  key: 'chosung',
  title: '초성 배틀',
  tagline: '초성을 보고 가장 먼저 정답을 맞혀보세요!',
  minPlayers: 2,
  recommended: '2명 이상',
  minutes: '5분',
};

const catalog = { categories: CATEGORIES.map(c => c.name) };
const defaultSettings = { count: 10, category: 'random', seconds: 30 };

function normalizeSettings(s) {
  return {
    count: oneOf(Number(s.count), [5, 10, 15], 10),
    category: oneOf(s.category, ['random', ...catalog.categories], 'random'),
    seconds: oneOf(Number(s.seconds), [20, 30, 45], 30),
  };
}

function create(ctx, settings) {
  const s = normalizeSettings(settings);
  const pool = CATEGORIES
    .filter(c => s.category === 'random' || c.name === s.category)
    .flatMap(c => c.words.map(w => ({ ...w, category: c.name })));
  const game = {
    settings: s,
    questions: shuffle(pool).slice(0, s.count),
    index: -1,
    q: null,
    history: [],
    phase: null,
    deadline: null,
    timer: null,
    hintTimer: null,
  };
  nextQuestion(game, ctx);
  return game;
}

function nextQuestion(game, ctx) {
  game.index += 1;
  game.q = {
    word: game.questions[game.index],
    solvers: [],
    attempts: {},
    lastAt: {},
    near: [],
    wrong: [],
    accepted: [],
    hint: false,
  };
  const ms = game.settings.seconds * 1000;
  setPhase(game, ctx, 'question', ms, () => reveal(game));
  clearTimeout(game.hintTimer);
  game.hintTimer = setTimeout(() => {
    if (game.phase !== 'question') return;
    game.q.hint = true;
    ctx.sync();
  }, ms * HINT_AT);
}

function reveal(game) {
  clearTimeout(game.hintTimer);
  clearTimeout(game.timer);
  game.timer = null;
  game.deadline = null;
  game.history.push(game.q);
  game.phase = 'reveal';
}

function checkAll(game, ctx) {
  const ids = ctx.connected().map(p => p.id);
  if (ids.length && ids.every(id => game.q.solvers.includes(id))) reveal(game);
}

function questionPoints(q) {
  const points = {};
  q.solvers.forEach((id, i) => { points[id] = RANK_POINTS[i] ?? LATE_POINTS; });
  for (const id of q.accepted) if (!points[id]) points[id] = ACCEPTED_POINTS;
  return points;
}

function scoresOf(game) {
  const scores = {};
  for (const q of game.history) {
    for (const [id, pts] of Object.entries(questionPoints(q))) scores[id] = (scores[id] || 0) + pts;
  }
  return scores;
}

function titlesOf(game) {
  const firsts = {};
  const near = {};
  const wrong = {};
  for (const q of game.history) {
    if (q.solvers[0]) firsts[q.solvers[0]] = (firsts[q.solvers[0]] || 0) + 1;
    for (const e of q.near) near[e.id] = (near[e.id] || 0) + 1;
    for (const e of q.wrong) wrong[e.id] = (wrong[e.id] || 0) + 1;
  }
  return [
    { title: '초성 천재', desc: '1등으로 가장 많이 맞힘', ids: topOf(firsts) },
    { title: '아깝다 장인', desc: '초성은 맞았는데 아쉬운 답을 가장 많이 냄', ids: topOf(near) },
    { title: '오답 제조기', desc: '가장 다양한 오답을 만들어냄', ids: topOf(wrong) },
  ].filter(t => t.ids.length);
}

function action(game, ctx, pid, msg, isHost) {
  const hostDenied = { ok: false, error: '방장만 할 수 있어요.' };
  const q = game.q;
  switch (msg.type) {
    case 'guess': {
      if (game.phase !== 'question') return { ok: false };
      if (q.solvers.includes(pid)) return { ok: true, verdict: 'done' };
      const now = Date.now();
      if (now - (q.lastAt[pid] || 0) < SUBMIT_GAP_MS) return { ok: true, verdict: 'slow' };
      q.lastAt[pid] = now;
      q.attempts[pid] = (q.attempts[pid] || 0) + 1;
      if (q.attempts[pid] > MAX_ATTEMPTS) return { ok: true, verdict: 'limit' };

      const text = String(msg.text || '').normalize('NFC').trim().slice(0, 30);
      const verdict = judge(q.word, text);
      if (verdict === 'empty') return { ok: false, error: '정답을 입력해 주세요.' };
      if (verdict === 'correct') {
        q.solvers.push(pid);
        checkAll(game, ctx);
        return { ok: true, verdict, rank: q.solvers.indexOf(pid) + 1 };
      }
      const list = verdict === 'near' ? q.near : q.wrong;
      const duplicate = list.some(e => e.id === pid && normalizeAnswer(e.text) === normalizeAnswer(text));
      if (!duplicate && list.length < 60) list.push({ id: pid, text });
      return { ok: true, verdict };
    }

    case 'reveal':
      if (!isHost) return hostDenied;
      if (game.phase !== 'question') return { ok: false };
      return reveal(game);

    // 초성은 맞는데 정답 목록에 없던 답을 방장이 인정하거나 취소한다.
    case 'accept': {
      if (!isHost) return hostDenied;
      if (game.phase !== 'reveal') return { ok: false };
      const entry = q.near[Number(msg.index)];
      if (!entry || q.solvers.includes(entry.id)) return { ok: false };
      const at = q.accepted.indexOf(entry.id);
      if (at >= 0) q.accepted.splice(at, 1);
      else q.accepted.push(entry.id);
      return;
    }

    case 'next':
      if (!isHost) return hostDenied;
      if (game.phase !== 'reveal') return { ok: false };
      if (game.index + 1 >= game.questions.length) return setPhase(game, ctx, 'final');
      return nextQuestion(game, ctx);

    default:
      return { ok: false };
  }
}

function onPresence(game, ctx) {
  if (game.phase === 'question') checkAll(game, ctx);
}

function view(game, ctx, pid) {
  const q = game.q;
  const v = {
    phase: game.phase,
    index: game.index,
    total: game.questions.length,
    category: q.word.category,
    chosung: q.word.chosung,
    hint: q.hint ? q.word.main[0] : null,
    deadline: game.deadline,
    solvers: q.solvers,
    playerCount: ctx.connected().length,
    ranking: ranking(scoresOf(game), ctx.room),
    lastQuestion: game.index + 1 >= game.questions.length,
  };
  if (pid) {
    const rank = q.solvers.indexOf(pid) + 1;
    v.me = { solved: rank > 0, rank: rank || null };
  }
  if (game.phase !== 'question') {
    Object.assign(v, {
      answer: q.word.main,
      aliases: q.word.answers.slice(1),
      near: q.near.map((e, index) => ({
        index,
        id: e.id,
        text: e.text,
        accepted: q.accepted.includes(e.id),
        solved: q.solvers.includes(e.id),
      })),
      wrong: q.wrong.slice(-6),
      points: questionPoints(q),
    });
  }
  if (game.phase === 'final') v.titles = titlesOf(game);
  return v;
}

function dispose(game) {
  clearTimeout(game.timer);
  clearTimeout(game.hintTimer);
}

module.exports = {
  info, catalog, defaultSettings, normalizeSettings, create, action, onPresence, view, dispose,
  _test: { chosungOf, judge, CATEGORIES },
};
