'use strict';

const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const GAMES = {
  liar: require('./games/liar'),
  balance: require('./games/balance'),
};

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 30;
const MAX_ROOMS = 2000;
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const CREATE_MAX_PER_IP = 20;
const HOST_GRACE_MS = 15000;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const COLORS = [
  '#FF6B3D', '#2F80ED', '#27AE60', '#F2B705', '#9B51E0', '#EB5757',
  '#00A79D', '#F2994A', '#3FA9F5', '#C05BD6', '#6BBF59', '#E86A92',
];
const BANNED_WORDS = ['시발', '씨발', 'ㅅㅂ', '병신', 'ㅂㅅ', '좆', '개새', 'fuck', 'shit'];

// 같은 Wi-Fi의 폰이 접속할 수 있도록 PC의 내부망 주소를 찾는다.
function lanAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) found.push(a.address);
    }
  }
  const rank = ip => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return found.sort((a, b) => rank(a) - rank(b));
}

// 초대 링크와 QR에 쓸 주소. 직접 지정 > 호스팅 서비스가 알려주는 주소 > 내부망 주소 순.
const DEPLOYED_URL = process.env.PUBLIC_URL
  || process.env.RENDER_EXTERNAL_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`)
  || null;
const PUBLIC_URL = (DEPLOYED_URL || `http://${lanAddresses()[0] || 'localhost'}:${PORT}`).replace(/\/$/, '');

const CATALOG = {
  games: Object.values(GAMES).map(g => g.info),
  liar: GAMES.liar.catalog,
  balance: GAMES.balance.catalog,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));
app.use(express.static(PUBLIC_DIR));
app.get(['/r/:code', '/screen/:code'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/qr/:code.svg', async (req, res) => {
  if (!/^\d{4}$/.test(req.params.code)) return res.sendStatus(404);
  const svg = await QRCode.toString(joinUrl(req.params.code), {
    type: 'svg',
    margin: 1,
    color: { dark: '#2B2118', light: '#FFFFFF' },
  });
  res.type('image/svg+xml').send(svg);
});

// ---------------------------------------------------------------- rooms

const rooms = new Map(); // code -> room
const bindings = new Map(); // socket.id -> { code, playerId } | { code, screen: true }
const createLog = new Map(); // ip -> 최근 방 생성 시각들

// 호스팅 서비스의 프록시가 맨 뒤에 실제 접속 IP를 붙인다. 앞쪽 값은 사용자가 꾸며낼 수 있다.
function clientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',').pop().trim();
  return socket.handshake.address;
}

function allowCreate(ip) {
  const now = Date.now();
  const recent = (createLog.get(ip) || []).filter(t => now - t < CREATE_WINDOW_MS);
  const allowed = recent.length < CREATE_MAX_PER_IP;
  if (allowed) recent.push(now);
  createLog.set(ip, recent);
  return allowed;
}

function joinUrl(code) {
  return `${PUBLIC_URL}/r/${code}`;
}

function newCode() {
  let code;
  do code = String(1000 + Math.floor(Math.random() * 9000));
  while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: newCode(),
    players: [],
    hostId: null,
    gameKey: 'liar',
    settings: Object.fromEntries(Object.entries(GAMES).map(([k, g]) => [k, { ...g.defaultSettings }])),
    game: null,
    screens: new Set(),
    hostTimer: null,
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function deleteRoom(room) {
  if (room.game) GAMES[room.game.key].dispose(room.game);
  clearTimeout(room.hostTimer);
  rooms.delete(room.code);
}

function activePlayers(room) {
  return room.players.filter(p => !p.left);
}

function cleanName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 10);
}

function nameError(room, name) {
  if (!name) return '닉네임을 입력해 주세요.';
  const compact = name.toLowerCase().replace(/\s/g, '');
  if (BANNED_WORDS.some(w => compact.includes(w))) return '사용할 수 없는 닉네임이에요.';
  if (activePlayers(room).some(p => p.name === name)) return '이미 같은 닉네임이 있어요.';
  return null;
}

function cleanToken(raw) {
  const token = String(raw || '').slice(0, 64);
  return /^[\w-]{8,64}$/.test(token) ? token : null;
}

function addPlayer(room, name, token, socket) {
  const used = new Set(activePlayers(room).map(p => p.color));
  const player = {
    id: crypto.randomBytes(4).toString('hex'),
    token,
    name,
    color: COLORS.find(c => !used.has(c)) || COLORS[room.players.length % COLORS.length],
    socketId: null,
    connected: false,
    left: false,
  };
  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;
  attach(socket, room, player);
  return player;
}

function attach(socket, room, player) {
  unbind(socket);
  const previous = player.socketId && io.sockets.sockets.get(player.socketId);
  if (previous && previous.id !== socket.id) {
    bindings.delete(previous.id);
    previous.leave(room.code);
    previous.emit('replaced');
  }
  player.socketId = socket.id;
  player.connected = true;
  bindings.set(socket.id, { code: room.code, playerId: player.id });
  socket.join(room.code);
  if (room.hostId === player.id && room.hostTimer) {
    clearTimeout(room.hostTimer);
    room.hostTimer = null;
  }
}

// 소켓이 다른 방으로 옮겨갈 때 이전 방과의 연결을 정리한다.
function unbind(socket) {
  const b = bindings.get(socket.id);
  if (!b) return;
  bindings.delete(socket.id);
  socket.leave(b.code);
  const room = rooms.get(b.code);
  if (!room) return;
  if (b.screen) {
    room.screens.delete(socket.id);
    return;
  }
  const player = room.players.find(p => p.id === b.playerId);
  if (player && player.socketId === socket.id) {
    player.connected = false;
    if (room.hostId === player.id) scheduleHostTransfer(room);
    notifyPresence(room);
    sync(room);
  }
}

function removePlayer(room, player) {
  player.connected = false;
  player.socketId = null;
  if (room.game) player.left = true; // 진행 중인 게임 기록(이름, 점수)은 남겨둔다
  else room.players = room.players.filter(p => p !== player);
  if (room.hostId === player.id) transferHost(room);
  if (activePlayers(room).length === 0 && room.screens.size === 0) return deleteRoom(room);
  notifyPresence(room);
}

function transferHost(room) {
  const next = activePlayers(room).find(p => p.connected) || activePlayers(room)[0];
  room.hostId = next ? next.id : null;
}

function scheduleHostTransfer(room) {
  clearTimeout(room.hostTimer);
  room.hostTimer = setTimeout(() => {
    room.hostTimer = null;
    const host = room.players.find(p => p.id === room.hostId);
    if (!host || !host.connected) {
      transferHost(room);
      sync(room);
    }
  }, HOST_GRACE_MS);
}

function purgeLeft(room) {
  room.players = room.players.filter(p => !p.left);
}

function notifyPresence(room) {
  if (room.game) GAMES[room.game.key].onPresence(room.game, ctxFor(room));
}

function startGame(room) {
  purgeLeft(room);
  const mod = GAMES[room.gameKey];
  room.game = mod.create(ctxFor(room), room.settings[room.gameKey]);
  room.game.key = room.gameKey;
}

function endGame(room) {
  if (!room.game) return;
  GAMES[room.game.key].dispose(room.game);
  room.game = null;
  purgeLeft(room);
}

function ctxFor(room) {
  return {
    room,
    connected: () => activePlayers(room).filter(p => p.connected),
    isConnected: id => activePlayers(room).some(p => p.id === id && p.connected),
    sync: () => sync(room),
  };
}

function viewFor(room, playerId) {
  const me = playerId ? room.players.find(p => p.id === playerId) : null;
  return {
    now: Date.now(),
    code: room.code,
    joinUrl: joinUrl(room.code),
    screenUrl: `${PUBLIC_URL}/screen/${room.code}`,
    me: me ? { id: me.id, name: me.name, isHost: room.hostId === me.id } : null,
    hostId: room.hostId,
    players: activePlayers(room).map(p => ({ id: p.id, name: p.name, color: p.color, connected: p.connected })),
    roster: Object.fromEntries(room.players.map(p => [p.id, { name: p.name, color: p.color }])),
    gameKey: room.gameKey,
    settings: room.settings[room.gameKey],
    catalog: CATALOG,
    game: room.game ? { key: room.game.key, ...GAMES[room.game.key].view(room.game, ctxFor(room), playerId) } : null,
  };
}

function sync(room) {
  if (!rooms.has(room.code)) return;
  room.lastActive = Date.now();
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', viewFor(room, p.id));
  }
  if (room.screens.size) {
    const screenView = viewFor(room, null);
    for (const id of room.screens) io.to(id).emit('state', screenView);
  }
}

// ---------------------------------------------------------------- sockets

io.on('connection', socket => {
  const current = () => {
    const b = bindings.get(socket.id);
    const room = b && rooms.get(b.code);
    if (!room) return {};
    const player = b.playerId ? activePlayers(room).find(p => p.id === b.playerId) : null;
    return { room, player };
  };

  // 모든 요청은 결과 객체를 ack로 돌려준다. 핸들러가 아무것도 반환하지 않으면 성공.
  const on = (event, handler) => {
    socket.on(event, (msg, ack) => {
      let result;
      try {
        result = handler(msg && typeof msg === 'object' ? msg : {});
      } catch (err) {
        console.error(`[${event}]`, err);
        result = { ok: false, error: '문제가 생겼어요. 다시 시도해 주세요.' };
      }
      if (typeof ack === 'function') ack(result || { ok: true });
    });
  };

  const hostOnly = handler => msg => {
    const { room, player } = current();
    if (!player || room.hostId !== player.id) return { ok: false, error: '방장만 할 수 있어요.' };
    const result = handler(room, player, msg);
    sync(room);
    return result;
  };

  on('room:create', msg => {
    const token = cleanToken(msg.token);
    if (!token) return { ok: false, error: '잘못된 요청이에요.' };
    if (rooms.size >= MAX_ROOMS) return { ok: false, error: '지금은 방을 더 만들 수 없어요. 잠시 후 다시 시도해 주세요.' };
    if (!allowCreate(clientIp(socket))) return { ok: false, error: '방을 너무 많이 만들었어요. 잠시 후 다시 시도해 주세요.' };
    const room = createRoom();
    const name = cleanName(msg.name);
    const error = nameError(room, name);
    if (error) {
      deleteRoom(room);
      return { ok: false, error };
    }
    addPlayer(room, name, token, socket);
    sync(room);
    return { ok: true, code: room.code };
  });

  on('room:join', msg => {
    const room = rooms.get(String(msg.code || ''));
    if (!room) return { ok: false, error: '방을 찾을 수 없어요. 코드를 확인해 주세요.' };
    const token = cleanToken(msg.token);
    if (!token) return { ok: false, error: '잘못된 요청이에요.' };
    const existing = activePlayers(room).find(p => p.token === token);
    if (existing) {
      attach(socket, room, existing);
    } else {
      if (activePlayers(room).length >= MAX_PLAYERS) return { ok: false, error: '방이 가득 찼어요.' };
      const name = cleanName(msg.name);
      const error = nameError(room, name);
      if (error) return { ok: false, error };
      addPlayer(room, name, token, socket);
    }
    notifyPresence(room);
    sync(room);
    return { ok: true, code: room.code };
  });

  on('room:resume', msg => {
    const room = rooms.get(String(msg.code || ''));
    const token = cleanToken(msg.token);
    const existing = room && token && activePlayers(room).find(p => p.token === token);
    if (!existing) return { ok: false };
    attach(socket, room, existing);
    notifyPresence(room);
    sync(room);
    return { ok: true, code: room.code };
  });

  on('room:screen', msg => {
    const room = rooms.get(String(msg.code || ''));
    if (!room) return { ok: false, error: '방을 찾을 수 없어요.' };
    unbind(socket);
    room.screens.add(socket.id);
    bindings.set(socket.id, { code: room.code, screen: true });
    socket.join(room.code);
    socket.emit('state', viewFor(room, null));
    return { ok: true };
  });

  on('room:leave', () => {
    const { room, player } = current();
    if (!player) return;
    bindings.delete(socket.id);
    socket.leave(room.code);
    removePlayer(room, player);
    sync(room);
  });

  on('lobby:select', hostOnly((room, host, msg) => {
    if (room.game || !GAMES[msg.gameKey]) return { ok: false };
    room.gameKey = msg.gameKey;
  }));

  on('lobby:settings', hostOnly((room, host, msg) => {
    if (room.game) return { ok: false };
    const mod = GAMES[room.gameKey];
    room.settings[room.gameKey] = mod.normalizeSettings({ ...room.settings[room.gameKey], ...(msg.settings || {}) });
  }));

  on('game:start', hostOnly(room => {
    if (room.game) return { ok: false, error: '이미 게임이 진행 중이에요.' };
    const { info } = GAMES[room.gameKey];
    const count = activePlayers(room).filter(p => p.connected).length;
    if (count < info.minPlayers) return { ok: false, error: `${info.title}은(는) 최소 ${info.minPlayers}명이 필요해요.` };
    startGame(room);
  }));

  on('game:restart', hostOnly(room => {
    if (!room.game) return { ok: false };
    const key = room.game.key;
    endGame(room);
    room.gameKey = key;
    startGame(room);
  }));

  on('game:end', hostOnly(room => endGame(room)));

  on('player:kick', hostOnly((room, host, msg) => {
    const target = activePlayers(room).find(p => p.id === msg.playerId);
    if (!target || target.id === host.id) return { ok: false };
    const targetSocket = target.socketId && io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      bindings.delete(targetSocket.id);
      targetSocket.leave(room.code);
      targetSocket.emit('kicked');
    }
    removePlayer(room, target);
  }));

  on('game:action', msg => {
    const { room, player } = current();
    if (!room || !room.game || !player) return { ok: false };
    const result = GAMES[room.game.key].action(room.game, ctxFor(room), player.id, msg, room.hostId === player.id);
    sync(room);
    return result;
  });

  socket.on('disconnect', () => unbind(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.lastActive > ROOM_TTL_MS) deleteRoom(room);
  }
  for (const [ip, times] of createLog) {
    if (!times.some(t => now - t < CREATE_WINDOW_MS)) createLog.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// 재배포할 때 호스팅 서비스가 SIGTERM을 보낸다. 열린 연결을 정리하고 종료한다.
process.on('SIGTERM', () => {
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`놀게더 서버 실행 중: http://localhost:${PORT}`);
  if (DEPLOYED_URL) {
    console.log(`공개 주소: ${PUBLIC_URL}`);
  } else {
    console.log(`같은 Wi-Fi의 폰에서 접속: ${PUBLIC_URL}`);
    const others = lanAddresses().slice(1);
    if (others.length) console.log(`(다른 네트워크 주소: ${others.map(ip => `http://${ip}:${PORT}`).join(', ')})`);
  }
});
