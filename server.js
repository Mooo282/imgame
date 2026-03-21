const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); 
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// إعداد مجلد الصور الثابتة
app.use('/images', express.static(path.join(__dirname, 'public/images')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// مصفوفات الصور
const imagePools = {
    "classic": Array.from({length: 50}, (_, i) => `/images/classic/${i+1}.jpg`),
    "fun": Array.from({length: 50}, (_, i) => `/images/fun/${i+1}.jpg`)
};

// إدارة الغرف ومؤقتات الحذف
let rooms = {}; 
let roomDeleteTimeouts = {}; 

function emitPlayerList(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('updatePlayerList', { 
        players: room.players, 
        playerNames: room.playerNames, 
        hostId: room.hostId, 
        scores: room.scores, 
        gameState: room.gameState, 
        currentDrawerId: room.currentDrawerId, 
        playerReady: room.playerReady 
    });
}

function startTimer(roomCode, duration, onTimeout) {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.gameTimer) clearInterval(room.gameTimer);
    
    let timeLeft = duration;
    io.to(roomCode).emit('timerUpdate', timeLeft);
    room.gameTimer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { 
            clearInterval(room.gameTimer); 
            if (onTimeout) onTimeout(); 
        }
    }, 1000);
}

io.on('connection', (socket) => {
    
    // إنشاء غرفة جديدة
    socket.on('createRoom', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            players: [], scores: {}, playerNames: {}, hostId: data.userId,
            playerReady: {}, targetPoints: 30, roundTimeLimit: 60,
            currentDrawerId: null, currentPool: [], gameState: "LOBBY",
            currentImages: [], currentClue: "", correctImage: "",
            fakeImages: {}, votes: {}, drawerQueue: [], gameTimer: null
        };
        socket.emit('roomCreated', roomCode);
    });

    // الانضمام للعبة (Join Game)
    socket.on('joinGame', (data) => {
        const { userId, name, roomCode } = data;
        if (!roomCode || !rooms[roomCode]) return socket.emit('error', 'Room not found!');

        // إلغاء مؤقت الحذف إذا دخل شخص قبل انتهاء الـ 5 ثواني
        if (roomDeleteTimeouts[roomCode]) {
            clearTimeout(roomDeleteTimeouts[roomCode]);
            delete roomDeleteTimeouts[roomCode];
        }

        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.userId = userId;

        const room = rooms[roomCode];
        room.playerNames[userId] = name;
        if (room.scores[userId] === undefined) room.scores[userId] = 0;
        if (room.playerReady[userId] === undefined) room.playerReady[userId] = false;
        if (!room.players.includes(userId)) room.players.push(userId);
        if (!room.hostId || !room.players.includes(room.hostId)) room.hostId = room.players[0];
        
        emitPlayerList(roomCode);
    });

    socket.on('toggleReady', () => {
        const room = rooms[socket.roomCode];
        if (room) {
            room.playerReady[socket.userId] = !room.playerReady[socket.userId];
            emitPlayerList(socket.roomCode);
        }
    });

    socket.on('requestStart', (data) => {
        const room = rooms[socket.roomCode];
        if (room && socket.userId === room.hostId && room.gameState === "LOBBY") {
            room.players.forEach(id => room.scores[id] = 0);
            room.targetPoints = parseInt(data.targetPoints);
            room.roundTimeLimit = parseInt(data.roundTime);
            room.currentPool = imagePools[data.mode] || imagePools["classic"];
            room.drawerQueue = [];
            startNewRound(socket.roomCode);
        }
    });

    function startNewRound(rCode) {
        const room = rooms[rCode];
        if (!room) return;
        room.gameState = "DRAWING"; room.fakeImages = {}; room.votes = {}; room.currentClue = "";
        if (room.drawerQueue.length === 0) room.drawerQueue = [...room.players].sort(() => 0.5 - Math.random());
        room.currentDrawerId = room.drawerQueue.shift();
        room.currentImages = [...room.currentPool].sort(() => 0.5 - Math.random()).slice(0, 6);
        
        io.to(rCode).emit('roundStarted', { 
            images: room.currentImages, 
            drawerId: room.currentDrawerId, 
            drawerName: room.playerNames[room.currentDrawerId] 
        });
        startTimer(rCode, room.roundTimeLimit, () => { 
            if(room.gameState === "DRAWING") startNewRound(rCode); 
        });
    }

    socket.on('submitClue', (data) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.userId !== room.currentDrawerId || !data.clue) return;
        room.gameState = "FAKING"; room.correctImage = data.image; room.currentClue = data.clue;
        
        room.players.forEach(pId => {
            if (pId !== room.currentDrawerId) {
                const pImages = room.currentPool.filter(img => img !== room.correctImage).sort(() => 0.5 - Math.random()).slice(0, 6);
                const targetSid = [...io.sockets.sockets.values()].find(s => s.userId === pId && s.roomCode === socket.roomCode)?.id;
                if (targetSid) io.to(targetSid).emit('showClue', { clue: room.currentClue, pImages });
            }
        });
        startTimer(socket.roomCode, room.roundTimeLimit, () => proceedToVoting(socket.roomCode));
    });

    socket.on('submitFake', (img) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.userId === room.currentDrawerId || room.fakeImages[socket.userId] || room.gameState !== "FAKING") return;
        room.fakeImages[socket.userId] = img;
        if (Object.keys(room.fakeImages).length >= (room.players.length - 1)) proceedToVoting(socket.roomCode);
    });

    function proceedToVoting(rCode) {
        const room = rooms[rCode];
        if (!room) return;
        if (room.gameTimer) clearInterval(room.gameTimer);
        room.gameState = "VOTING";
        let opts = [...new Set([room.correctImage, ...Object.values(room.fakeImages)])];
        if (opts.length < 6) {
            const extra = room.currentPool.filter(img => !opts.includes(img)).sort(() => 0.5 - Math.random()).slice(0, 6 - opts.length);
            opts = [...opts, ...extra];
        }
        io.to(rCode).emit('startVoting', { options: opts.sort(() => 0.5 - Math.random()), drawerId: room.currentDrawerId });
        startTimer(rCode, room.roundTimeLimit, () => finalizeRound(rCode));
    }

    socket.on('submitVote', (img) => {
        const room = rooms[socket.roomCode];
        if (!room || socket.userId === room.currentDrawerId || room.votes[socket.userId] || room.gameState !== "VOTING") return;
        room.votes[socket.userId] = img;
        if (Object.keys(room.votes).length >= (room.players.length - 1)) finalizeRound(socket.roomCode);
    });

    function finalizeRound(rCode) {
        const room = rooms[rCode];
        if (!room) return;
        if (room.gameTimer) clearInterval(room.gameTimer);
        room.gameState = "RESULTS";
        
        let totalVoters = room.players.length - 1, correctCount = 0;
        for (let vId in room.votes) if (room.votes[vId] === room.correctImage) correctCount++;
        
        if (correctCount > 0 && correctCount < totalVoters) {
            room.scores[room.currentDrawerId] += (correctCount * 2);
            for (let vId in room.votes) if (room.votes[vId] === room.correctImage) room.scores[vId] += 2;
        }
        for (let vId in room.votes) {
            for (let fId in room.fakeImages) if (room.votes[vId] === room.fakeImages[fId] && fId !== vId) room.scores[fId] += 1;
        }

        let voteDetails = {}, fakers = {};
        for (let vId in room.votes) { 
            if (!voteDetails[room.votes[vId]]) voteDetails[room.votes[vId]] = []; 
            voteDetails[room.votes[vId]].push(room.playerNames[vId]); 
        }
        for (let fId in room.fakeImages) fakers[room.fakeImages[fId]] = room.playerNames[fId];

        io.to(rCode).emit('roundFinished', { correctImage: room.correctImage, scores: room.scores, voteDetails, fakers });
        emitPlayerList(rCode);

        setTimeout(() => {
            if (room && room.players.some(id => room.scores[id] >= room.targetPoints)) finishGame(rCode);
            else if (room && room.players.length > 0) startNewRound(rCode);
        }, 10000);
    }

    function finishGame(rCode) {
        const room = rooms[rCode];
        if (!room) return;
        room.gameState = "LOBBY";
        const lb = room.players.map(id => ({ name: room.playerNames[id], score: room.scores[id] })).sort((a,b) => b.score - a.score);
        io.to(rCode).emit('gameOver', { leaderboard: lb });
        emitPlayerList(rCode);
    }

    socket.on('sendChat', (msg) => {
        const room = rooms[socket.roomCode];
        if (msg && room) {
            io.to(socket.roomCode).emit('newChat', { sender: room.playerNames[socket.userId], text: msg });
        }
    });

    socket.on('disconnect', () => {
        const rCode = socket.roomCode;
        const uId = socket.userId;
        if (rCode && rooms[rCode]) {
            const room = rooms[rCode];
            room.players = room.players.filter(id => id !== uId);
            
            if (room.players.length === 0) {
                // حذف الغرفة بعد 5 ثوانٍ من خروج آخر لاعب
                roomDeleteTimeouts[rCode] = setTimeout(() => {
                    if (rooms[rCode] && rooms[rCode].players.length === 0) {
                        if (rooms[rCode].gameTimer) clearInterval(rooms[rCode].gameTimer);
                        delete rooms[rCode];
                    }
                }, 5000);
            } else {
                if (uId === room.hostId) room.hostId = room.players[0];
                if (uId === room.currentDrawerId && room.gameState !== "LOBBY") startNewRound(rCode);
                emitPlayerList(rCode);
            }
        }
    });
});

server.listen(PORT, () => console.log(`Server Active on port ${PORT}`));
