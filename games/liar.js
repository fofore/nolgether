'use strict';

const { shuffle, pick, oneOf, normalizeAnswer, setPhase, ranking, topOf } = require('./util');
const DATA = require('../data/liar.json');

const VOTE_MS = 45000;
const GUESS_MS = 40000;
const LIAR_WIN_POINTS = 3;
const CATCH_POINTS = 1;

const info = {
  key: 'liar',
  title: '라이어 게임',
  tagline: '한 명만 제시어를 몰라요. 대화로 라이어를 찾아내세요!',
  minPlayers: 3,
  recommended: '4~10명',
  minutes: '10분',
};

const catalog = { categories: DATA.categories.map(c => c.name) };
const defaultSettings = { rounds: 3, category: 'random', fool: false };

function normalizeSettings(s) {
  return {
    rounds: oneOf(Number(s.rounds), [1, 3, 5, 7], 3),
    category: oneOf(s.category, ['random', ...catalog.categories], 'random'),
    fool: s.fool === true,
  };
}

function create(ctx, settings) {
  const game = {
    settings: normalizeSettings(settings),
    round: 0,
    history: [],
    usedWords: [],
    lastLiar: null,
    phase: null,
    deadline: null,
    timer: null,
    r: null,
  };
  startRound(game, ctx);
  return game;
}

function startRound(game, ctx) {
  const ids = ctx.connected().map(p => p.id);
  const category = game.settings.category === 'random'
    ? pick(DATA.categories)
    : DATA.categories.find(c => c.name === game.settings.category);
  let pool = category.words.filter(w => !game.usedWords.includes(w));
  if (pool.length < 2) pool = category.words;
  const word = pick(pool);
  game.usedWords.push(word);

  // 같은 사람이 연달아 라이어가 되지 않게 한다.
  const liarId = pick(ids.length > 1 ? ids.filter(id => id !== game.lastLiar) : ids);
  game.lastLiar = liarId;
  game.round += 1;
  game.r = {
    category: category.name,
    word,
    liarWord: game.settings.fool ? pick(category.words.filter(w => w !== word)) : null,
    liarId,
    participants: ids,
    order: shuffle(ids),
    candidates: ids,
    votes: {},
    revote: false,
    tied: null,
    tally: null,
    accusedId: null,
    guess: null,
    guessCorrect: null,
    winner: null,
  };
  setPhase(game, ctx, 'talk');
}

function voters(game, ctx) {
  return game.r.participants.filter(ctx.isConnected);
}

function openVote(game, ctx) {
  const r = game.r;
  r.candidates = r.revote ? r.tied : r.participants;
  r.votes = {};
  setPhase(game, ctx, 'vote', VOTE_MS, () => tallyVotes(game, ctx));
}

function checkVotes(game, ctx) {
  const list = voters(game, ctx);
  if (list.length && list.every(id => game.r.votes[id])) tallyVotes(game, ctx);
}

function tallyVotes(game, ctx) {
  const r = game.r;
  const counts = {};
  for (const target of Object.values(r.votes)) counts[target] = (counts[target] || 0) + 1;
  r.tally = r.candidates
    .map(id => ({ id, votes: counts[id] || 0 }))
    .sort((a, b) => b.votes - a.votes);

  const top = topOf(counts);
  if (top.length === 0) return finishRound(game, ctx, 'liar');
  if (top.length > 1) {
    if (r.revote) return finishRound(game, ctx, 'liar');
    r.revote = true;
    r.tied = top;
    return setPhase(game, ctx, 'tie');
  }
  r.accusedId = top[0];
  if (r.accusedId !== r.liarId) return finishRound(game, ctx, 'liar');
  setPhase(game, ctx, 'guess', GUESS_MS, () => {
    r.guessCorrect = false;
    finishRound(game, ctx, 'citizens');
  });
}

function finishRound(game, ctx, winner) {
  game.r.winner = winner;
  game.history.push(game.r);
  setPhase(game, ctx, 'result');
}

function roundPoints(r) {
  if (r.winner === 'liar') return { [r.liarId]: LIAR_WIN_POINTS };
  const points = {};
  for (const [voter, target] of Object.entries(r.votes)) {
    if (target === r.liarId) points[voter] = CATCH_POINTS;
  }
  return points;
}

function scoresOf(game) {
  const scores = {};
  for (const r of game.history) {
    for (const [id, pts] of Object.entries(roundPoints(r))) scores[id] = (scores[id] || 0) + pts;
  }
  return scores;
}

function titlesOf(game) {
  const liarWins = {};
  const caught = {};
  const framed = {};
  for (const r of game.history) {
    if (r.winner === 'liar') liarWins[r.liarId] = (liarWins[r.liarId] || 0) + 1;
    for (const [voter, target] of Object.entries(r.votes)) {
      if (target === r.liarId) caught[voter] = (caught[voter] || 0) + 1;
      else framed[target] = (framed[target] || 0) + 1;
    }
  }
  return [
    { title: '거짓말 장인', desc: '라이어로 가장 많이 살아남음', ids: topOf(liarWins) },
    { title: '명탐정', desc: '라이어를 가장 많이 찾아냄', ids: topOf(caught) },
    { title: '억울한 시민', desc: '시민인데 표를 가장 많이 받음', ids: topOf(framed) },
  ].filter(t => t.ids.length);
}

function action(game, ctx, pid, msg, isHost) {
  const r = game.r;
  const hostDenied = { ok: false, error: '방장만 할 수 있어요.' };
  switch (msg.type) {
    case 'startVote':
      if (!isHost) return hostDenied;
      if (game.phase !== 'talk' && game.phase !== 'tie') return { ok: false };
      return openVote(game, ctx);

    case 'vote':
      if (game.phase !== 'vote') return { ok: false };
      if (!r.participants.includes(pid)) return { ok: false, error: '이번 라운드는 구경만 할 수 있어요.' };
      if (msg.target === pid) return { ok: false, error: '자기 자신은 고를 수 없어요.' };
      if (!r.candidates.includes(msg.target)) return { ok: false };
      r.votes[pid] = msg.target;
      return checkVotes(game, ctx);

    case 'closeVote':
      if (!isHost) return hostDenied;
      if (game.phase !== 'vote') return { ok: false };
      return tallyVotes(game, ctx);

    case 'guess': {
      if (game.phase !== 'guess' || pid !== r.liarId) return { ok: false };
      const text = String(msg.text || '').trim().slice(0, 20);
      if (!text) return { ok: false, error: '제시어를 입력해 주세요.' };
      r.guess = text;
      r.guessCorrect = normalizeAnswer(text) === normalizeAnswer(r.word);
      return finishRound(game, ctx, r.guessCorrect ? 'liar' : 'citizens');
    }

    case 'skipGuess':
      if (!isHost) return hostDenied;
      if (game.phase !== 'guess') return { ok: false };
      r.guessCorrect = false;
      return finishRound(game, ctx, 'citizens');

    // 비슷한 말로 맞혔는데 자동 판정이 틀렸다고 할 때 방장이 바로잡는다.
    case 'flipJudge':
      if (!isHost) return hostDenied;
      if (game.phase !== 'result' || r.guess === null) return { ok: false };
      r.guessCorrect = !r.guessCorrect;
      r.winner = r.guessCorrect ? 'liar' : 'citizens';
      return;

    case 'next':
      if (!isHost) return hostDenied;
      if (game.phase !== 'result') return { ok: false };
      if (game.round >= game.settings.rounds) return setPhase(game, ctx, 'final');
      if (ctx.connected().length < info.minPlayers) return { ok: false, error: `최소 ${info.minPlayers}명이 있어야 다음 라운드를 할 수 있어요.` };
      return startRound(game, ctx);

    default:
      return { ok: false };
  }
}

function onPresence(game, ctx) {
  if (game.phase === 'vote') checkVotes(game, ctx);
}

function view(game, ctx, pid) {
  const r = game.r;
  const done = game.phase === 'result' || game.phase === 'final';
  const v = {
    phase: game.phase,
    round: game.round,
    rounds: game.settings.rounds,
    fool: game.settings.fool,
    category: r.category,
    order: r.order,
    participants: r.participants,
    candidates: r.candidates,
    tied: r.tied,
    revote: r.revote,
    deadline: game.deadline,
    votedCount: Object.keys(r.votes).length,
    voterCount: voters(game, ctx).length,
    ranking: ranking(scoresOf(game), ctx.room),
  };

  if (pid) {
    const inRound = r.participants.includes(pid);
    const isLiar = pid === r.liarId;
    let word = null;
    if (inRound) word = game.settings.fool ? (isLiar ? r.liarWord : r.word) : (isLiar ? null : r.word);
    v.me = {
      inRound,
      word,
      isLiar: inRound && isLiar && !game.settings.fool,
      vote: r.votes[pid] || null,
    };
  }

  // 라이어가 지목되면 그때부터는 모두에게 공개된다.
  if (game.phase === 'guess') {
    v.liarId = r.liarId;
    v.accusedId = r.accusedId;
  }

  if (done) {
    Object.assign(v, {
      liarId: r.liarId,
      word: r.word,
      liarWord: r.liarWord,
      accusedId: r.accusedId,
      guess: r.guess,
      guessCorrect: r.guessCorrect,
      winner: r.winner,
      tally: r.tally,
      votes: r.votes,
      points: roundPoints(r),
      lastRound: game.round >= game.settings.rounds,
    });
  }

  if (game.phase === 'final') v.titles = titlesOf(game);
  return v;
}

function dispose(game) {
  clearTimeout(game.timer);
}

module.exports = { info, catalog, defaultSettings, normalizeSettings, create, action, onPresence, view, dispose };
