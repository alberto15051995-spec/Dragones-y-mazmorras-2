const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── ROOMS ──────────────────────────────────────
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      players: new Map(),
      messages: [],
      combat: { active: false, combatants: [] },
      createdAt: Date.now()
    });
  }
  return rooms.get(code);
}

function roomPublic(room) {
  return {
    code: room.code,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, character: p.character, color: p.color, online: p.online
    })),
    messages: room.messages.slice(-50),
    combat: room.combat
  };
}

function generateCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// ── SOCKET.IO ──────────────────────────────────
io.on('connection', (socket) => {
  console.log('Conexión:', socket.id);
  let currentRoom = null;
  let currentPlayer = null;

  // JOIN ROOM
  socket.on('join_room', ({ code, playerName, character }) => {
    const roomCode = code ? code.toUpperCase() : generateCode();
    const room = getRoom(roomCode);

    const player = {
      id: socket.id,
      name: playerName || 'Aventurero',
      character: character || null,
      color: getPlayerColor(room.players.size),
      online: true,
      joinedAt: Date.now()
    };

    room.players.set(socket.id, player);
    socket.join(roomCode);
    currentRoom = roomCode;
    currentPlayer = player;

    // Send room state to new player
    socket.emit('room_joined', { roomCode, room: roomPublic(room), playerId: socket.id });

    // Notify others
    socket.to(roomCode).emit('player_joined', { player, room: roomPublic(room) });

    // System message
    const sysMsg = { type: 'system', text: `⚔️ ${player.name} se ha unido a la aventura.`, ts: Date.now() };
    room.messages.push(sysMsg);
    io.to(roomCode).emit('new_message', sysMsg);

    console.log(`${player.name} se unió a sala ${roomCode}`);
  });

  // UPDATE CHARACTER
  socket.on('update_character', ({ character }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    const player = room.players.get(socket.id);
    if (player) {
      player.character = character;
      io.to(currentRoom).emit('player_updated', { playerId: socket.id, character, room: roomPublic(room) });
    }
  });

  // SEND MESSAGE (player action)
  socket.on('send_message', ({ text, type }) => {
    if (!currentRoom || !currentPlayer) return;
    const room = getRoom(currentRoom);
    const msg = {
      type: type || 'player',
      playerId: socket.id,
      playerName: currentPlayer.name,
      playerColor: currentPlayer.color,
      character: currentPlayer.character,
      text,
      ts: Date.now()
    };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages = room.messages.slice(-200);
    io.to(currentRoom).emit('new_message', msg);
  });

  // DM MESSAGE (from AI)
  socket.on('dm_message', ({ text, options }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    const msg = { type: 'dm', text, options: options || [], ts: Date.now() };
    room.messages.push(msg);
    io.to(currentRoom).emit('new_message', msg);
    if (options && options.length) io.to(currentRoom).emit('show_options', options);
  });

  // DICE ROLL
  socket.on('roll_dice', ({ sides, qty, label }) => {
    if (!currentRoom || !currentPlayer) return;
    const results = Array(qty || 1).fill(0).map(() => Math.floor(Math.random() * sides) + 1);
    const total = results.reduce((a, b) => a + b, 0);
    const roll = {
      type: 'roll',
      playerId: socket.id,
      playerName: currentPlayer.name,
      playerColor: currentPlayer.color,
      sides, qty: qty || 1, results, total, label,
      isCrit: qty === 1 && results[0] === sides && sides === 20,
      isFail: qty === 1 && results[0] === 1 && sides === 20,
      ts: Date.now()
    };
    const room = getRoom(currentRoom);
    room.messages.push(roll);
    io.to(currentRoom).emit('dice_rolled', roll);
  });

  // COMBAT
  socket.on('start_combat', ({ enemies }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.combat = {
      active: true,
      turn: 0,
      combatants: [
        ...Array.from(room.players.values()).map(p => ({
          id: p.id, name: p.character?.name || p.name,
          hp: p.character?.hp || 100, maxHp: p.character?.hpMax || 100,
          init: Math.floor(Math.random() * 20) + 1, isPlayer: true
        })),
        ...(enemies || []).map(e => ({ ...e, isPlayer: false, init: Math.floor(Math.random() * 20) + 1 }))
      ].sort((a, b) => b.init - a.init)
    };
    io.to(currentRoom).emit('combat_updated', room.combat);
    const msg = { type: 'system', text: '⚔️ ¡COMBATE INICIADO! Las iniciativas han sido lanzadas.', ts: Date.now() };
    room.messages.push(msg);
    io.to(currentRoom).emit('new_message', msg);
  });

  socket.on('end_combat', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.combat = { active: false, combatants: [] };
    io.to(currentRoom).emit('combat_updated', room.combat);
    const msg = { type: 'system', text: '🕊️ El combate ha concluido.', ts: Date.now() };
    room.messages.push(msg);
    io.to(currentRoom).emit('new_message', msg);
  });

  socket.on('next_turn', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (room.combat.active) {
      room.combat.turn = (room.combat.turn + 1) % room.combat.combatants.length;
      io.to(currentRoom).emit('combat_updated', room.combat);
    }
  });

  socket.on('update_hp', ({ targetId, hp }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    const c = room.combat.combatants.find(x => x.id === targetId);
    if (c) { c.hp = Math.max(0, hp); io.to(currentRoom).emit('combat_updated', room.combat); }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    if (!currentRoom || !currentPlayer) return;
    const room = rooms.get(currentRoom);
    if (room) {
      const player = room.players.get(socket.id);
      if (player) {
        player.online = false;
        const msg = { type: 'system', text: `💨 ${player.name} se ha desconectado.`, ts: Date.now() };
        room.messages.push(msg);
        io.to(currentRoom).emit('new_message', msg);
        io.to(currentRoom).emit('player_updated', { playerId: socket.id, online: false, room: roomPublic(room) });
      }
    }
    console.log('Desconectado:', socket.id);
  });
});

// ── HELPERS ────────────────────────────────────
const COLORS = ['#c9a84c','#4caf50','#5090e0','#e05050','#9c27b0','#ff9800'];
function getPlayerColor(idx) { return COLORS[idx % COLORS.length]; }

// ── START ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐉 D&D Server corriendo en puerto ${PORT}`));
