'use strict';

// 서버를 띄우고 가상 참가자 4명으로 라이어 게임과 밸런스 게임을 끝까지 진행해 본다.
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), PUBLIC_URL: URL },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.on('data', d => { if (String(d).includes('서버 실행 중')) resolve(child); });
    child.on('exit', code => reject(new Error(`server exited ${code}`)));
  });
}

function client(name) {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const c = { name, socket, token: `test-token-${Buffer.from(name).toString('hex')}`, state: null, waiters: [] };
  socket.on('state', s => {
    c.state = s;
    c.waiters = c.waiters.filter(w => !w(s));
  });
  c.call = (event, payload = {}) => new Promise(res => socket.emit(event, payload, res));
  c.until = (pred, label) => new Promise((resolve, reject) => {
    if (c.state && pred(c.state)) return resolve(c.state);
    const t = setTimeout(() => reject(new Error(`${name}: timeout waiting for ${label}`)), 4000);
    c.waiters.push(s => {
      if (!pred(s)) return false;
      clearTimeout(t);
      resolve(s);
      return true;
    });
  });
  c.ready = new Promise(r => socket.on('connect', r));
  return c;
}

const phase = p => s => s.game && s.game.phase === p;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const { CATEGORIES } = require('../games/chosung')._test;

// 초성 배틀 정답은 화면에 안 보이므로, 같은 주제·초성의 단어를 차례로 넣어 맞힌다.
async function solveChosung(player, s) {
  const words = CATEGORIES.find(c => c.name === s.game.category).words.filter(w => w.chosung === s.game.chosung);
  for (const w of words) {
    const res = await player.call('game:action', { type: 'guess', text: w.main });
    if (res.verdict === 'correct') return res;
    await sleep(450);
  }
  throw new Error('could not solve chosung question');
}

async function main() {
  const server = await startServer();
  const players = ['방장', '철수', '영희', '민수'].map(client);
  const [host, ...guests] = players;
  try {
    await Promise.all(players.map(p => p.ready));

    // 방 만들기 + 입장
    const created = await host.call('room:create', { name: host.name, token: host.token });
    assert.ok(created.ok, 'room create');
    const code = created.code;
    assert.match(code, /^\d{4}$/);

    const dup = await guests[0].call('room:join', { code, name: '방장', token: 'test-token-dup-00000' });
    assert.ok(!dup.ok && dup.error.includes('닉네임'), 'duplicate name rejected');
    const bad = await guests[0].call('room:join', { code: '0000', name: 'x', token: guests[0].token });
    assert.ok(!bad.ok, 'unknown room rejected');

    for (const g of guests) assert.ok((await g.call('room:join', { code, name: g.name, token: g.token })).ok);
    await host.until(s => s.players.length === 4, '4 players');
    assert.equal(host.state.me.isHost, true);

    const notHost = await guests[0].call('game:start');
    assert.ok(!notHost.ok, 'guest cannot start');

    // ---------------- 라이어 게임
    assert.equal(host.state.gameKey, 'chosung', 'default game is 초성 배틀');
    assert.ok((await host.call('lobby:select', { gameKey: 'telepathy' })).ok);
    const tooMany = await host.call('game:start');
    assert.ok(!tooMany.ok && tooMany.error.includes('2명만'), 'telepathy rejects 4 players');
    assert.ok((await host.call('lobby:select', { gameKey: 'liar' })).ok);
    assert.ok((await host.call('lobby:settings', { settings: { rounds: 1 } })).ok);
    assert.ok((await host.call('game:start')).ok, 'liar start');
    await Promise.all(players.map(p => p.until(phase('talk'), 'talk')));

    const liar = players.find(p => p.state.game.me.isLiar);
    const citizens = players.filter(p => p !== liar);
    assert.ok(liar, 'one liar');
    assert.equal(players.filter(p => p.state.game.me.isLiar).length, 1);
    const word = citizens[0].state.game.me.word;
    assert.ok(word && citizens.every(c => c.state.game.me.word === word), 'citizens share word');
    assert.equal(liar.state.game.me.word, null, 'liar has no word');
    assert.equal(host.state.game.word, undefined, 'word hidden during talk');

    assert.ok((await host.call('game:action', { type: 'startVote' })).ok);
    await Promise.all(players.map(p => p.until(phase('vote'), 'vote')));

    const self = await liar.call('game:action', { type: 'vote', target: liar.state.me.id });
    assert.ok(!self.ok, 'cannot vote self');

    const liarId = liar.state.me.id;
    for (const c of citizens) await c.call('game:action', { type: 'vote', target: liarId });
    await liar.call('game:action', { type: 'vote', target: citizens[0].state.me.id });
    await host.until(phase('guess'), 'guess');
    assert.equal(host.state.game.liarId, liarId);

    const wrongGuess = word === '강아지' ? '고양이' : '강아지';
    assert.ok((await liar.call('game:action', { type: 'guess', text: wrongGuess })).ok);
    const result = await host.until(phase('result'), 'liar result');
    assert.equal(result.game.winner, 'citizens');
    for (const c of citizens) assert.equal(result.game.points[c.state.me.id], 1, 'catcher +1');

    // 방장이 판정을 뒤집으면 라이어 승리로 점수가 바뀐다
    await host.call('game:action', { type: 'flipJudge' });
    const flipped = await host.until(s => s.game.winner === 'liar', 'flip');
    assert.equal(flipped.game.points[liarId], 3, 'liar +3 after flip');
    await host.call('game:action', { type: 'flipJudge' });
    await host.until(s => s.game.winner === 'citizens', 'flip back');

    await host.call('game:action', { type: 'next' });
    const liarFinal = await host.until(phase('final'), 'liar final');
    assert.ok(liarFinal.game.titles.some(t => t.title === '명탐정'));
    console.log('✓ 라이어 게임: 역할 배정, 투표, 정답 맞히기, 판정 바꾸기, 최종 결과');

    // 정답을 맞히는 경우와 동표 재투표도 확인
    await host.call('game:restart');
    await Promise.all(players.map(p => p.until(s => phase('talk')(s) && s.game.round === 1, 'talk again')));
    const liar2 = players.find(p => p.state.game.me.isLiar);
    const others = players.filter(p => p !== liar2);
    const word2 = others[0].state.game.me.word;
    await host.call('game:action', { type: 'startVote' });
    await host.until(phase('vote'), 'vote 2');
    // 2:2 동표 만들기
    const [x, y] = others;
    await x.call('game:action', { type: 'vote', target: liar2.state.me.id });
    await y.call('game:action', { type: 'vote', target: liar2.state.me.id });
    await others[2].call('game:action', { type: 'vote', target: x.state.me.id });
    await liar2.call('game:action', { type: 'vote', target: x.state.me.id });
    const tie = await host.until(phase('tie'), 'tie');
    assert.equal(tie.game.tied.length, 2);
    await host.call('game:action', { type: 'startVote' });
    await host.until(s => phase('vote')(s) && s.game.revote, 'revote');
    for (const p of players) {
      const target = p === liar2 ? x.state.me.id : liar2.state.me.id;
      await p.call('game:action', { type: 'vote', target });
    }
    await host.until(phase('guess'), 'guess 2');
    await liar2.call('game:action', { type: 'guess', text: ` ${word2} ` });
    const r2 = await host.until(phase('result'), 'result 2');
    assert.equal(r2.game.winner, 'liar', 'liar guessed correctly');
    assert.equal(r2.game.guessCorrect, true);
    console.log('✓ 라이어 게임: 동표 → 재투표, 라이어 정답 시 라이어 승리');

    // ---------------- 밸런스 게임
    await host.call('game:end');
    await host.until(s => !s.game, 'back to lobby');
    await host.call('lobby:select', { gameKey: 'balance' });
    await host.call('lobby:settings', { settings: { count: 5 } });
    assert.ok((await host.call('game:start')).ok, 'balance start');
    await Promise.all(players.map(p => p.until(phase('answer'), 'answer')));
    assert.equal(host.state.game.total, 5);

    const early = await guests[0].call('game:action', { type: 'predict', side: 'A' });
    assert.ok(!early.ok, 'cannot predict before choosing');

    // 3명 A, 1명 B. 모두 A가 다수라고 예측
    for (const [i, p] of players.entries()) {
      await p.call('game:action', { type: 'choose', side: i === 3 ? 'B' : 'A' });
      await p.call('game:action', { type: 'predict', side: 'A' });
    }
    const br = await host.until(phase('result'), 'balance result');
    assert.equal(br.game.result.majority, 'A');
    assert.equal(br.game.result.aCount, 3);
    assert.equal(br.game.result.lonely.id, players[3].state.me.id);
    assert.ok(br.game.ranking.every(r => r.score === 1), 'everyone predicted right');

    // 나머지 4문제는 방장이 바로 공개하며 넘긴다
    for (let i = 1; i < 5; i++) {
      await host.call('game:action', { type: 'next' });
      await host.until(s => phase('answer')(s) && s.game.index === i, `q${i}`);
      await host.call('game:action', { type: 'reveal' });
      await host.until(phase('result'), `r${i}`);
    }
    await host.call('game:action', { type: 'next' });
    const bf = await host.until(phase('final'), 'balance final');
    assert.ok(bf.game.titles.some(t => t.title === '나 혼자 다른 길'));
    console.log('✓ 밸런스 게임: 선택, 다수 예측, 혼자만 다른 선택, 최종 결과');

    // ---------------- 재접속과 방장 위임
    guests[0].socket.disconnect();
    await host.until(s => s.players.find(p => p.name === '철수').connected === false, 'disconnect shown');
    const again = client('철수');
    again.token = guests[0].token;
    await again.ready;
    assert.ok((await again.call('room:resume', { code, token: again.token })).ok, 'resume');
    await host.until(s => s.players.find(p => p.name === '철수').connected, 'reconnected');

    await host.call('room:leave');
    const newHost = await again.until(s => s.hostId !== host.state.me.id, 'host transferred');
    assert.ok(newHost.players.every(p => p.name !== '방장'), 'host removed');
    console.log('✓ 재접속, 방장이 나가면 다음 사람에게 방장 위임');

    // 게임 도중에 참가자가 나가도 남은 사람끼리 계속 진행된다
    assert.equal(newHost.me.isHost, true);
    await again.call('game:end');
    await again.call('lobby:select', { gameKey: 'balance' });
    assert.ok((await again.call('game:start')).ok);
    await again.until(phase('answer'), 'answer after host change');
    const leaver = guests[1];
    assert.ok((await leaver.call('room:leave')).ok);
    await again.until(s => s.game.playerCount === 2, 'leaver gone');
    for (const p of [again, guests[2]]) {
      await p.call('game:action', { type: 'choose', side: 'A' });
      await p.call('game:action', { type: 'predict', side: 'A' });
    }
    await again.until(phase('result'), 'result without leaver');
    assert.ok(again.state.players.every(p => p.name !== leaver.name), 'leaver removed from players');
    console.log('✓ 게임 중 나가기: 남은 사람끼리 계속 진행');

    // 여기부터는 2명(again = 방장, mate)이 남은 방에서 진행한다.
    const mate = guests[2];
    const pair = [again, mate];
    const id = p => p.state.me.id;

    // ---------------- 텔레파시
    await again.call('game:end');
    await again.call('lobby:select', { gameKey: 'telepathy' });
    await again.call('lobby:settings', { settings: { count: 5 } });
    assert.ok((await again.call('game:start')).ok, 'telepathy start');
    await Promise.all(pair.map(p => p.until(phase('answer'), 'tp answer')));
    for (const p of pair) {
      await p.call('game:action', { type: 'choose', side: 'A' });
      await p.call('game:action', { type: 'guess', side: 'A' });
    }
    const tp1 = await again.until(phase('result'), 'tp result 1');
    assert.equal(tp1.game.result.same, true);
    assert.ok(Object.values(tp1.game.result.hits).every(Boolean), 'both read each other');

    await again.call('game:action', { type: 'next' });
    await again.until(s => phase('answer')(s) && s.game.index === 1, 'tp q2');
    await again.call('game:action', { type: 'choose', side: 'A' });
    await again.call('game:action', { type: 'guess', side: 'B' });
    await mate.call('game:action', { type: 'choose', side: 'B' });
    await mate.call('game:action', { type: 'guess', side: 'B' });
    const tp2 = await again.until(phase('result'), 'tp result 2');
    assert.equal(tp2.game.result.same, false);
    assert.equal(tp2.game.result.hits[id(again)], true);
    assert.equal(tp2.game.result.hits[id(mate)], false);

    for (let i = 2; i < 5; i++) {
      await again.call('game:action', { type: 'next' });
      await again.until(s => phase('answer')(s) && s.game.index === i, `tp q${i + 1}`);
      await again.call('game:action', { type: 'reveal' });
      await again.until(phase('result'), `tp r${i + 1}`);
    }
    await again.call('game:action', { type: 'next' });
    const tpf = await again.until(phase('final'), 'tp final');
    assert.equal(tpf.game.summary.telepathy, 30, '3 hits out of 10');
    console.log('✓ 텔레파시: 2명 제한, 서로 맞히기, 텔레파시 지수');

    // ---------------- 초성 배틀
    await again.call('game:end');
    await again.call('lobby:select', { gameKey: 'chosung' });
    await again.call('lobby:settings', { settings: { count: 5 } });
    assert.ok((await again.call('game:start')).ok, 'chosung start');
    const cq = await mate.until(phase('question'), 'cs question');
    assert.equal(cq.game.answer, undefined, 'answer hidden during question');

    const mismatch = await mate.call('game:action', { type: 'guess', text: '가나다라마바사아' });
    assert.equal(mismatch.verdict, 'mismatch');
    await sleep(450);
    // 초성만 같은 가짜 단어(예: ㄱㅊㅉㄱ → 가차짜가)
    const fake = [...cq.game.chosung.replace(/\s/g, '')].map(ch => String.fromCharCode(0xac00 + CHOSUNG.indexOf(ch) * 588)).join('');
    const near = await mate.call('game:action', { type: 'guess', text: fake });
    assert.equal(near.verdict, 'near');
    const slow = await mate.call('game:action', { type: 'guess', text: fake });
    assert.equal(slow.verdict, 'slow', 'rapid resubmit throttled');

    const solved = await solveChosung(again, cq);
    assert.equal(solved.rank, 1);
    await again.call('game:action', { type: 'reveal' });
    const cr = await again.until(phase('reveal'), 'cs reveal');
    assert.ok(cr.game.answer, 'answer shown after question');
    const nearEntry = cr.game.near.find(e => e.id === id(mate));
    assert.ok(nearEntry && nearEntry.text === fake);
    const notHostAccept = await mate.call('game:action', { type: 'accept', index: nearEntry.index });
    assert.ok(!notHostAccept.ok, 'only host can accept');
    await again.call('game:action', { type: 'accept', index: nearEntry.index });
    const accepted = await again.until(s => s.game.points[id(mate)] === 1, 'near answer accepted');
    assert.equal(accepted.game.points[id(again)], 3);

    // 둘 다 맞히면 제한시간 전에 자동으로 정답 공개
    await again.call('game:action', { type: 'next' });
    const cq2 = await again.until(s => phase('question')(s) && s.game.index === 1, 'cs q2');
    await solveChosung(mate, cq2);
    await solveChosung(again, cq2);
    const cr2 = await again.until(phase('reveal'), 'cs auto reveal');
    assert.equal(cr2.game.solvers[0], id(mate));
    assert.equal(cr2.game.points[id(mate)], 3);
    assert.equal(cr2.game.points[id(again)], 2);

    for (let i = 2; i < 5; i++) {
      await again.call('game:action', { type: 'next' });
      await again.until(s => phase('question')(s) && s.game.index === i, `cs q${i + 1}`);
      await again.call('game:action', { type: 'reveal' });
      await again.until(phase('reveal'), `cs r${i + 1}`);
    }
    await again.call('game:action', { type: 'next' });
    const cf = await again.until(phase('final'), 'cs final');
    assert.ok(cf.game.titles.some(t => t.title === '초성 천재'));
    assert.equal(cf.game.ranking.find(r => r.id === id(again)).score, 5);
    assert.equal(cf.game.ranking.find(r => r.id === id(mate)).score, 4);
    console.log('✓ 초성 배틀: 정답·초성 불일치·아쉬운 답 판정, 연타 방지, 방장 인정, 자동 공개, 순위 점수');

    // ---------------- 우리 얼마나 알까
    await again.call('game:end');
    await again.call('lobby:select', { gameKey: 'weknow' });
    await again.call('lobby:settings', { settings: { count: 6 } });
    assert.ok((await again.call('game:start')).ok, 'weknow start');
    const wq = await again.until(phase('answer'), 'wk answer');
    assert.ok(!wq.game.text.includes('{name}'), 'subject name filled in');
    const subjectOf = s => (s.game.subjectId === id(again) ? again : mate);
    const guesserOf = s => (s.game.subjectId === id(again) ? mate : again);
    await guesserOf(wq).call('game:action', { type: 'pick', option: 1 });
    await sleep(100);
    assert.equal(again.state.game.phase, 'answer', 'waits for the subject');
    await subjectOf(wq).call('game:action', { type: 'pick', option: 1 });
    const wr = await again.until(phase('result'), 'wk result');
    assert.deepEqual(wr.game.correct, [id(guesserOf(wq))]);

    await again.call('game:action', { type: 'next' });
    const wq2 = await again.until(s => phase('answer')(s) && s.game.index === 1, 'wk q2');
    assert.notEqual(wq2.game.subjectId, wq.game.subjectId, 'subject rotates');
    await subjectOf(wq2).call('game:action', { type: 'pick', option: 0 });
    await guesserOf(wq2).call('game:action', { type: 'pick', option: 2 });
    const wr2 = await again.until(phase('result'), 'wk result 2');
    assert.deepEqual(wr2.game.correct, []);

    for (let i = 2; i < 6; i++) {
      await again.call('game:action', { type: 'next' });
      await again.until(s => phase('answer')(s) && s.game.index === i, `wk q${i + 1}`);
      await again.call('game:action', { type: 'reveal' });
      await again.until(phase('result'), `wk r${i + 1}`);
    }
    await again.call('game:action', { type: 'next' });
    const wf = await again.until(phase('final'), 'wk final');
    assert.equal(wf.game.summary.pair, true);
    assert.equal(wf.game.summary.score, 50, 'unanswered questions are not counted');
    console.log('✓ 우리 얼마나 알까: 주인공 차례 돌기, 주인공 답 대기, 궁합 점수');

    again.socket.close();

    console.log('\n모든 테스트 통과');
  } finally {
    players.forEach(p => p.socket.close());
    server.kill();
  }
}

main().catch(err => {
  console.error('✗ 테스트 실패:', err.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
});
