'use strict';

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// 띄어쓰기, 대소문자, 문장부호 차이는 같은 답으로 본다.
// 일부 키보드는 한글을 자모로 나눠 보내므로 NFC로 합친다.
function normalizeAnswer(text) {
  return String(text || '').normalize('NFC').toLowerCase().replace(/[\s.,!?~'"·\-_()]/g, '');
}

// 2명 게임의 결과 점수(0~100)에 붙일 이름
function pairLabel(score) {
  if (score >= 90) return '영혼의 단짝';
  if (score >= 70) return '찰떡 콤비';
  if (score >= 50) return '통하는 사이';
  return '알아가는 중';
}

// 게임 단계 전환. 제한시간이 있으면 끝났을 때 onTimeout 후 모두에게 상태를 다시 보낸다.
function setPhase(game, ctx, phase, ms = 0, onTimeout = null) {
  clearTimeout(game.timer);
  game.timer = null;
  game.phase = phase;
  game.deadline = ms ? Date.now() + ms : null;
  if (ms && onTimeout) {
    game.timer = setTimeout(() => {
      game.timer = null;
      onTimeout();
      ctx.sync();
    }, ms);
  }
}

// 점수표를 순위 목록으로 만든다. 동점은 같은 등수.
function ranking(scores, room) {
  const rows = room.players
    .filter(p => !p.left || scores[p.id])
    .map(p => ({ id: p.id, score: scores[p.id] || 0 }))
    .sort((a, b) => b.score - a.score);
  rows.forEach((row, i) => {
    row.rank = i > 0 && rows[i - 1].score === row.score ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

// counts에서 가장 큰 값을 가진 사람에게 칭호를 준다. 0이면 주지 않는다.
function topOf(counts) {
  const max = Math.max(0, ...Object.values(counts));
  if (max === 0) return [];
  return Object.keys(counts).filter(id => counts[id] === max);
}

module.exports = { shuffle, pick, oneOf, normalizeAnswer, pairLabel, setPhase, ranking, topOf };
