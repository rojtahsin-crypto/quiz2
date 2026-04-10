// server.js - Volledig werkend met jouw HTML en db.json
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Init database
let db = { users: [], roomsHistory: [], totalGamesPlayed: 0, topics: {} };
const dbPath = path.join(__dirname, 'db.json');
if (fs.existsSync(dbPath)) {
    try {
        const data = fs.readFileSync(dbPath, 'utf8');
        const loaded = JSON.parse(data);
        db = { ...db, ...loaded, topics: loaded.topics || {} };
        console.log('✅ db.json geladen');
    } catch(e) { console.error('Fout bij laden db.json:', e); }
}

function saveDB() {
    fs.writeFile(dbPath, JSON.stringify(db, null, 2), err => {
        if (err) console.error('Fout bij opslaan db.json:', err);
        else console.log('💾 db.json opgeslagen');
    });
}

const activeRooms = new Map();

class GameRoom {
    constructor(roomCode, hostName, hostSocketId, lang = 'ku') {
        this.roomCode = roomCode;
        this.host = hostName;
        this.hostSocketId = hostSocketId;
        this.language = lang;
        this.players = new Map();
        this.topic = null;
        this.gameStarted = false;
        this.currentQuestionIndex = 0;
        this.questionsList = [];
        this.hasAnswered = new Set();
        this.chatMessages = [];
        this.questionTimer = null;  // FIX 1: toegevoegd
    }

    addPlayer(socketId, name) {
        if (!this.players.has(socketId)) {
            // FIX 5: dubbele naam voorkomen
            for (let [_, p] of this.players) {
                if (p.name === name) return false;
            }
            this.players.set(socketId, { name, score: 0, totalTime: 0, answers: [] });
            return true;
        }
        return false;
    }

    removePlayer(socketId) {
        this.players.delete(socketId);
        if (this.hostSocketId === socketId || this.players.size === 0) {
            if (this.questionTimer) clearTimeout(this.questionTimer);
            activeRooms.delete(this.roomCode);
            return true;
        }
        return false;
    }

    getPlayerList() { return Array.from(this.players.values()).map(p => p.name); }
    getScores() {
        const scores = {};
        for (let [_, p] of this.players) scores[p.name] = p.score;
        return scores;
    }
    resetAnswers() { this.hasAnswered.clear(); }

    recordAnswer(socketId, answerIndex, timeSpentMs) {
        if (this.hasAnswered.has(socketId)) return false;
        const player = this.players.get(socketId);
        if (!player) return false;
        if (!this.questionsList.length || this.currentQuestionIndex >= this.questionsList.length) return false;
        const currentQ = this.questionsList[this.currentQuestionIndex];
        if (!currentQ) return false;  // FIX 4: check of vraag bestaat

        const isCorrect = (answerIndex === currentQ.correct);
        let pointsEarned = 0;
        if (isCorrect) {
            const maxTime = 15;
            const timeSec = Math.min(timeSpentMs / 1000, maxTime);
            const timeBonus = Math.max(0, Math.floor((maxTime - timeSec) * 2));
            pointsEarned = 10 + timeBonus;
            player.score += pointsEarned;
        }
        player.totalTime += timeSpentMs;
        player.answers.push({
            questionId: currentQ.id,
            selected: answerIndex,
            correct: isCorrect,
            timeSpent: timeSpentMs,
            pointsEarned
        });
        this.hasAnswered.add(socketId);
        return { isCorrect, pointsEarned, newScore: player.score };
    }
}

function generateRoomCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 3; i++) code += letters[Math.floor(Math.random() * letters.length)];
    return `${code}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function loadQuestions(lang, topicKey, db) {
    try {
        return db.topics?.[lang]?.[topicKey]?.questions || null;
    } catch(e) { return null; }
}

// API routes
app.get('/api/rooms', (req, res) => res.json({ activeRooms: Array.from(activeRooms.keys()) }));
app.get('/api/leaderboard', (req, res) => {
    const sorted = [...(db.users || [])].sort((a,b) => b.totalScore - a.totalScore);
    res.json(sorted.slice(0, 10));
});
app.get('/api/db', (req, res) => res.json(db));

io.on('connection', (socket) => {
    console.log(`🟢 Nieuw: ${socket.id}`);

    socket.on('createRoom', ({ playerName, lang }, callback) => {
        if (!playerName?.trim()) return callback({ success: false, error: 'Naam is verplicht' });
        let code = generateRoomCode();
        while (activeRooms.has(code)) code = generateRoomCode();
        const room = new GameRoom(code, playerName, socket.id, lang || 'ku');
        const added = room.addPlayer(socket.id, playerName.trim());
        if (!added) return callback({ success: false, error: 'Naam bestaat al' });
        activeRooms.set(code, room);
        socket.join(code);
        callback({ success: true, roomCode: code, host: playerName });
        io.to(code).emit('roomUpdate', {
            players: room.getPlayerList(),
            host: room.host,
            topic: room.topic,
            gameStarted: room.gameStarted
        });
    });

    socket.on('joinRoom', ({ roomCode, playerName }, callback) => {
        if (!roomCode || !playerName) return callback({ success: false, error: 'Code en naam nodig' });
        const room = activeRooms.get(roomCode);
        if (!room) return callback({ success: false, error: 'Kamer niet gevonden' });
        if (room.gameStarted) return callback({ success: false, error: 'Spel is al begonnen' });
        const added = room.addPlayer(socket.id, playerName.trim());
        if (!added) return callback({ success: false, error: 'Naam bestaat al' });
        socket.join(roomCode);
        callback({ success: true, roomCode, host: room.host, topic: room.topic, lang: room.language });
        io.to(roomCode).emit('roomUpdate', {
            players: room.getPlayerList(),
            host: room.host,
            topic: room.topic,
            gameStarted: room.gameStarted
        });
    });

    socket.on('selectTopic', ({ roomCode, topicKey }) => {
        const room = activeRooms.get(roomCode);
        if (!room || socket.id !== room.hostSocketId) return;
        const questions = loadQuestions(room.language, topicKey, db);
        if (!questions?.length) return socket.emit('error', 'Geen vragen gevonden');
        room.topic = topicKey;
        room.questionsList = questions.slice(0, 10);
        io.to(roomCode).emit('topicSelected', { topic: topicKey });
    });

    socket.on('startGame', ({ roomCode }) => {
        const room = activeRooms.get(roomCode);
        if (!room || socket.id !== room.hostSocketId) return;
        if (!room.topic || !room.questionsList.length) return socket.emit('error', 'Kies eerst een onderwerp');
        if (room.players.size < 2) return socket.emit('error', 'Minstens 2 spelers nodig');
        room.gameStarted = true;
        room.currentQuestionIndex = 0;
        for (let [_, p] of room.players) { p.score = 0; p.totalTime = 0; p.answers = []; }
        io.to(roomCode).emit('gameStarting');
        sendNextQuestion(roomCode);
    });

    async function sendNextQuestion(roomCode) {
        const room = activeRooms.get(roomCode);
        if (!room) return;
        if (room.currentQuestionIndex >= room.questionsList.length) return endGame(roomCode);
        const question = room.questionsList[room.currentQuestionIndex];
        if (!question) return endGame(roomCode);
        room.resetAnswers();
        io.to(roomCode).emit('newQuestion', {
            index: room.currentQuestionIndex,
            total: room.questionsList.length,
            text: question.text,
            options: question.options,
            timeLimit: 15
        });
        if (room.questionTimer) clearTimeout(room.questionTimer);
        room.questionTimer = setTimeout(() => {
            const currentRoom = activeRooms.get(roomCode);
            if (currentRoom?.gameStarted && currentRoom.currentQuestionIndex === room.currentQuestionIndex) {
                currentRoom.currentQuestionIndex++;
                sendNextQuestion(roomCode);
            }
        }, 16000);
    }

    socket.on('submitAnswer', ({ roomCode, answerIndex, timeSpent }, callback) => {
        const room = activeRooms.get(roomCode);
        if (!room || !room.gameStarted) return callback?.({ success: false });
        if (room.hasAnswered.has(socket.id)) return callback?.({ success: false });
        const validTime = (typeof timeSpent === 'number' && !isNaN(timeSpent)) ? Math.min(Math.max(timeSpent, 0), 15000) : 0;
        const result = room.recordAnswer(socket.id, answerIndex, validTime);
        if (!result) return callback?.({ success: false });
        io.to(roomCode).emit('scoreUpdate', {
            scores: room.getScores(),
            playerName: room.players.get(socket.id).name,
            newScore: result.newScore,
            isCorrect: result.isCorrect,
            pointsEarned: result.pointsEarned
        });
        callback?.({ success: true, isCorrect: result.isCorrect, pointsEarned: result.pointsEarned });
    });

    async function endGame(roomCode) {
        const room = activeRooms.get(roomCode);
        if (!room) return;
        if (room.questionTimer) clearTimeout(room.questionTimer);
        room.gameStarted = false;
        const players = Array.from(room.players.entries()).map(([id, p]) => ({ name: p.name, score: p.score, totalTime: p.totalTime }));
        players.sort((a,b) => b.score - a.score || a.totalTime - b.totalTime);
        const podium = players.slice(0,3).map((p, i) => ({ rank: i+1, name: p.name, score: p.score }));
        const gameRecord = {
            roomCode: room.roomCode, host: room.host, topic: room.topic,
            date: new Date().toISOString(), players: room.getPlayerList(),
            finalScores: room.getScores(), podium, totalQuestions: room.questionsList.length
        };
        db.roomsHistory.push(gameRecord);
        db.totalGamesPlayed = (db.totalGamesPlayed || 0) + 1;
        for (let [_, p] of room.players) {
            let user = db.users.find(u => u.username === p.name);
            if (!user) {
                user = { username: p.name, totalScore: 0, gamesPlayed: 0, gamesWon: 0, level: 1, xp: 0 };
                db.users.push(user);
            }
            user.totalScore += p.score;
            user.gamesPlayed += 1;
            if (p.name === podium[0]?.name) user.gamesWon += 1;
            user.xp += p.score;
            user.level = Math.floor(user.xp / 500) + 1;
        }
        saveDB();
        io.to(roomCode).emit('gameEnd', { podium, finalScores: room.getScores() });
    }

    socket.on('chatMessage', ({ roomCode, message }) => {
        const room = activeRooms.get(roomCode);
        if (!room) return;
        const player = room.players.get(socket.id);
        if (!player || !message?.trim()) return;
        const chatMsg = { name: player.name, message: message.slice(0,200), time: Date.now() };
        room.chatMessages.push(chatMsg);
        io.to(roomCode).emit('chatMessage', chatMsg);
    });

    socket.on('getRoomState', ({ roomCode }) => {
        const room = activeRooms.get(roomCode);
        if (!room) return;
        socket.emit('roomState', {
            players: room.getPlayerList(), host: room.host, topic: room.topic,
            gameStarted: room.gameStarted, scores: room.getScores(),
            currentQuestionIndex: room.currentQuestionIndex,
            totalQuestions: room.questionsList.length,
            chatMessages: room.chatMessages.slice(-20)
        });
    });

    socket.on('disconnect', () => {
        for (let [code, room] of activeRooms.entries()) {
            if (room.players.has(socket.id)) {
                const name = room.players.get(socket.id).name;
                const destroyed = room.removePlayer(socket.id);
                io.to(code).emit('roomUpdate', {
                    players: room.getPlayerList(), host: room.host,
                    topic: room.topic, gameStarted: room.gameStarted
                });
                io.to(code).emit('chatMessage', { name: 'سیستەم', message: `${name} یارییەکەی جێهێشت`, time: Date.now() });
                if (destroyed) io.to(code).emit('roomClosed', { reason: 'Kamer gesloten' });
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server op http://localhost:${PORT}`);
    console.log(`📡 WebSocket actief`);
});
