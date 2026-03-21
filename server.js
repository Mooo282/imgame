const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); 
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// إعداد المجلدات والملفات الثابتة
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// دالة لجلب الصور الموجودة فعلياً في المجلدات
function getImagesFromFolder(folderName) {
    const dir = path.join(__dirname, 'public/images', folderName);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
             .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
             .map(f => `/images/${folderName}/${f}`);
}

const imagePools = {
    get classic() { return getImagesFromFolder('classic'); },
    get fun() { return getImagesFromFolder('fun'); }
};

// كائنات إدارة الغرف ومؤقتات الحذف
let rooms = {}; 
let roomDeleteTimeouts = {}; 

// دالة إرسال تحديثات قائمة اللاعبين
function emitPlayerList(rCode) {
    const r = rooms[rCode];
    if (r) io.to(rCode).emit('updatePlayerList', { 
        players: r.players, playerNames: r.playerNames, hostId: r.hostId, 
        scores: r.scores, gameState: r.gameState, currentDrawerId: r.currentDrawerId, playerReady: r.playerReady 
    });
}

// دالة التحكم في عداد الوقت الخاص بكل غرفة
function startTimer(rCode, dur, onTimeout) {
    const r = rooms[rCode];
    if (!r) return;
    if (r.gameTimer) clearInterval(r.gameTimer);
    let left = dur;
    io.to(rCode).emit('timerUpdate', left);
    r.gameTimer = setInterval(() => {
        left--;
        io.to(rCode).emit('timerUpdate', left);
        if (left <= 0) { 
            clearInterval(r.gameTimer); 
            if (onTimeout) onTimeout(); 
        }
    }, 1000);
}

io.on('connection', (socket) => {
    
    // حدث إنشاء غرفة جديدة
    socket.on('createRoom', (data) => {
        const code = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[code] = { 
            players: [], scores: {}, playerNames: {}, hostId: data.userId, 
            playerReady: {}, targetPoints: 30, roundTimeLimit: 60, 
            currentDrawerId: null, currentPool: [], gameState: "LOBBY", 
            currentImages: [], currentClue: "", correctImage: "", 
            fakeImages: {}, votes: {}, drawerQueue: [], gameTimer: null 
        };
        socket.emit('roomCreated', code);
    });

    // حدث الانضمام للغرفة
    socket.on('joinGame', (data) => {
        const { userId, name, roomCode } = data;
        if (!roomCode || !rooms[roomCode]) return socket.emit('error', 'Room not found');
        
        // إلغاء حذف الغرفة إذا عاد أحد اللاعبين
        if (roomDeleteTimeouts[roomCode]) { 
            clearTimeout(roomDeleteTimeouts[roomCode]); 
            delete roomDeleteTimeouts[roomCode]; 
        }
        
        socket.join(roomCode); 
        socket.roomCode = roomCode; 
        socket.userId = userId;
        
        const r = rooms[roomCode];
        r.playerNames[userId] = name;
        if (r.scores[userId] === undefined) r.scores[userId] = 0;
        if (r.playerReady[userId] === undefined) r.playerReady[userId] = false;
        if (!r.players.includes(userId)) r.players.push(userId);
        if (!r.hostId || !r.players.includes(r.hostId)) r.hostId = r.players[0];
        
        emitPlayerList(roomCode);
    });

    socket.on('toggleReady', () => {
        const r = rooms[socket.roomCode];
        if (r) { 
            r.playerReady[socket.userId] = !r.playerReady[socket.userId]; 
            emitPlayerList(socket.roomCode); 
        }
    });

    socket.on('requestStart', (data) => {
        const r = rooms[socket.roomCode];
        if (r && socket.userId === r.hostId && r.gameState === "LOBBY") {
            r.players.forEach(id => r.scores[id] = 0);
            r.targetPoints = parseInt(data.targetPoints); 
            r.roundTimeLimit = parseInt(data.roundTime);
            r.currentPool = imagePools[data.mode] || imagePools["classic"];
            r.drawerQueue = []; 
            startNewRound(socket.roomCode);
        }
    });

    function startNewRound(rCode) {
        const r = rooms[rCode]; 
        if (!r) return;
        r.gameState = "DRAWING"; 
        r.fakeImages = {}; 
        r.votes = {}; 
        r.currentClue = "";
        
        if (r.drawerQueue.length === 0) r.drawerQueue = [...r.players].sort(() => 0.5 - Math.random());
        r.currentDrawerId = r.drawerQueue.shift();
        r.currentImages = [...r.currentPool].sort(() => 0.5 - Math.random()).slice(0, 6);
        
        io.to(rCode).emit('roundStarted', { 
            images: r.currentImages, 
            drawerId: r.currentDrawerId, 
            drawerName: r.playerNames[r.currentDrawerId] 
        });
        
        startTimer(rCode, r.roundTimeLimit, () => { 
            if(r.gameState === "DRAWING") startNewRound(rCode); 
        });
    }

    socket.on('submitClue', (data) => {
        const r = rooms[socket.roomCode];
        if (!r || socket.userId !== r.currentDrawerId || !data.clue) return;
        
        r.gameState = "FAKING"; 
        r.correctImage = data.image; 
        r.currentClue = data.clue;
        
        r.players.forEach(pId => {
            if (pId !== r.currentDrawerId) {
                const pImgs = r.currentPool.filter(i => i !== r.correctImage).sort(() => 0.5 - Math.random()).slice(0, 6);
                const targetSocket = [...io.sockets.sockets.values()].find(s => s.userId === pId && s.roomCode === socket.roomCode);
                if (targetSocket) io.to(targetSocket.id).emit('showClue', { clue: r.currentClue, pImages: pImgs });
            }
        });
        startTimer(socket.roomCode, r.roundTimeLimit, () => proceedToVoting(socket.roomCode));
    });

    socket.on('submitFake', (img) => {
        const r = rooms[socket.roomCode];
        if (r && socket.userId !== r.currentDrawerId && !r.fakeImages[socket.userId] && r.gameState === "FAKING") {
            r.fakeImages[socket.userId] = img;
            if (Object.keys(r.fakeImages).length >= (r.players.length - 1)) proceedToVoting(socket.roomCode);
        }
    });

    function proceedToVoting(rCode) {
        const r = rooms[rCode]; if (!r) return;
        if (r.gameTimer) clearInterval(r.gameTimer);
        r.gameState = "VOTING";
        
        let opts = [...new Set([r.correctImage, ...Object.values(r.fakeImages)])];
        if (opts.length < 6) {
            const extra = r.currentPool.filter(i => !opts.includes(i)).sort(() => 0.5 - Math.random()).slice(0, 6 - opts.length);
            opts = [...opts, ...extra];
        }
        
        io.to(rCode).emit('startVoting', { options: opts.sort(() => 0.5 - Math.random()), drawerId: r.currentDrawerId });
        startTimer(rCode, r.roundTimeLimit, () => finalizeRound(rCode));
    }

    socket.on('submitVote', (img) => {
        const r = rooms[socket.roomCode];
        if (r && socket.userId !== r.currentDrawerId && !r.votes[socket.userId] && r.gameState === "VOTING") {
            r.votes[socket.userId] = img;
            if (Object.keys(r.votes).length >= (r.players.length - 1)) finalizeRound(socket.roomCode);
        }
    });

    function finalizeRound(rCode) {
        const r = rooms[rCode]; if (!r) return;
        if (r.gameTimer) clearInterval(r.gameTimer);
        r.gameState = "RESULTS";
        
        let total = r.players.length - 1;
        let correct = 0;
        for (let vId in r.votes) if (r.votes[vId] === r.correctImage) correct++;
        
        if (correct > 0 && correct < total) {
            r.scores[r.currentDrawerId] += (correct * 2);
            for (let vId in r.votes) if (r.votes[vId] === r.correctImage) r.scores[vId] += 2;
        }
        
        for (let vId in r.votes) {
            for (let fId in r.fakeImages) {
                if (r.votes[vId] === r.fakeImages[fId] && fId !== vId) r.scores[fId] += 1;
            }
        }

        let details = {}, fakers = {};
        for (let vId in r.votes) { 
            if (!details[r.votes[vId]]) details[r.votes[vId]] = []; 
            details[r.votes[vId]].push(r.playerNames[vId]); 
        }
        for (let fId in r.fakeImages) fakers[r.fakeImages[fId]] = r.playerNames[fId];

        io.to(rCode).emit('roundFinished', { correctImage: r.correctImage, scores: r.scores, voteDetails: details, fakers: fakers });
        emitPlayerList(rCode);

        setTimeout(() => { 
            if (rooms[rCode] && rooms[rCode].players.some(id => rooms[rCode].scores[id] >= rooms[rCode].targetPoints)) {
                finishGame(rCode);
            } else if (rooms[rCode] && rooms[rCode].players.length > 0) {
                startNewRound(rCode);
            }
        }, 10000);
    }

    function finishGame(rCode) {
        const r = rooms[rCode]; if (!r) return;
        r.gameState = "LOBBY";
        const lb = r.players.map(id => ({ name: r.playerNames[id], score: r.scores[id] })).sort((a,b) => b.score - a.score);
        io.to(rCode).emit('gameOver', { leaderboard: lb });
        emitPlayerList(rCode);
    }

    socket.on('sendChat', (msg) => {
        const r = rooms[socket.roomCode];
        if (msg && r) io.to(socket.roomCode).emit('newChat', { sender: r.playerNames[socket.userId], text: msg });
    });

    socket.on('disconnect', () => {
        const rCode = socket.roomCode;
        const uId = socket.userId;
        if (rCode && rooms[rCode]) {
            const r = rooms[rCode];
            r.players = r.players.filter(id => id !== uId);
            
            if (r.players.length === 0) {
                roomDeleteTimeouts[rCode] = setTimeout(() => {
                    if (rooms[rCode] && rooms[rCode].players.length === 0) {
                        if (rooms[rCode].gameTimer) clearInterval(rooms[rCode].gameTimer);
                        delete rooms[rCode];
                    }
                }, 5000);
            } else {
                if (uId === r.hostId) r.hostId = r.players[0];
                if (uId === r.currentDrawerId && r.gameState !== "LOBBY") startNewRound(rCode);
                emitPlayerList(rCode);
            }
        }
    });
});

server.listen(PORT, () => console.log(`Server Active on port ${PORT}`));
