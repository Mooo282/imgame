const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

const imagePools = {
    "classic": Array.from({length: 50}, (_, i) => `/images/classic/${i+1}.jpg`),
    "fun": Array.from({length: 50}, (_, i) => `/images/fun/${i+1}.jpg`)
};

const rooms = {};

function shuffle(array) {
    let a = [...array];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const { roomId, userId, name, isJoining } = data;
        if (isJoining && !rooms[roomId]) return socket.emit('errorMsg', "Room not found!");

        socket.join(roomId);
        socket.roomId = roomId;
        socket.userId = userId;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], scores: {}, playerNames: {}, hostId: userId,
                playerReady: {}, gameState: "LOBBY", currentDrawerId: null,
                currentPool: [], drawerQueue: [], fakeImages: {}, votes: {},
                currentClue: "", correctImage: "", gameTimer: null, targetPoints: 30, roundTimeLimit: 60
            };
        }

        const room = rooms[roomId];
        room.playerNames[userId] = name;
        if (!room.players.includes(userId)) room.players.push(userId);
        if (room.scores[userId] === undefined) room.scores[userId] = 0;
        
        emitPlayerList(roomId);
    });

    function emitPlayerList(rId) {
        const room = rooms[rId];
        if (room) io.to(rId).emit('updatePlayerList', { players: room.players, playerNames: room.playerNames, hostId: room.hostId, scores: room.scores, gameState: room.gameState, playerReady: room.playerReady, roomId: rId });
    }

    socket.on('toggleReady', () => {
        const room = rooms[socket.roomId];
        if (room) { room.playerReady[socket.userId] = !room.playerReady[socket.userId]; emitPlayerList(socket.roomId); }
    });

    socket.on('requestStart', (data) => {
        const room = rooms[socket.roomId];
        if (room && socket.userId === room.hostId) {
            room.targetPoints = parseInt(data.targetPoints);
            room.roundTimeLimit = parseInt(data.roundTime);
            room.currentPool = imagePools[data.mode] || imagePools.classic;
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(rId) {
        const room = rooms[rId];
        if (!room) return;
        room.gameState = "DRAWING"; room.fakeImages = {}; room.votes = {};
        if (room.drawerQueue.length === 0) room.drawerQueue = shuffle(room.players);
        room.currentDrawerId = room.drawerQueue.shift();
        
        const roundImages = shuffle(room.currentPool).slice(0, 6);
        io.to(rId).emit('roundStarted', { images: roundImages, drawerId: room.currentDrawerId, drawerName: room.playerNames[room.currentDrawerId] });
        startTimer(rId, room.roundTimeLimit, () => { if(room.gameState === "DRAWING") startNewRound(rId); });
    }

    socket.on('submitClue', (data) => {
        const room = rooms[socket.roomId];
        room.gameState = "FAKING"; room.correctImage = data.image; room.currentClue = data.clue;
        io.to(socket.roomId).emit('showClue', { 
            clue: room.currentClue, 
            pImages: shuffle(room.currentPool).filter(img => img !== room.correctImage).slice(0, 6),
            drawerId: room.currentDrawerId 
        });
        startTimer(socket.roomId, room.roundTimeLimit, () => proceedToVoting(socket.roomId));
    });

    socket.on('submitFake', (img) => {
        const room = rooms[socket.roomId];
        room.fakeImages[socket.userId] = img;
        if (Object.keys(room.fakeImages).length >= (room.players.length - 1)) proceedToVoting(socket.roomId);
    });

    function proceedToVoting(rId) {
        const room = rooms[rId];
        if (room.gameState !== "FAKING") return;
        room.gameState = "VOTING";
        const options = shuffle([...new Set([room.correctImage, ...Object.values(room.fakeImages)])]);
        io.to(rId).emit('startVoting', { options, drawerId: room.currentDrawerId });
        startTimer(rId, room.roundTimeLimit, () => finalizeRound(rId));
    }

    socket.on('submitVote', (img) => {
        const room = rooms[socket.roomId];
        room.votes[socket.userId] = img;
        if (Object.keys(room.votes).length >= (room.players.length - 1)) finalizeRound(socket.roomId);
    });

    function finalizeRound(rId) {
        const room = rooms[rId];
        if (!room || room.gameState !== "VOTING") return;
        clearInterval(room.gameTimer);
        room.gameState = "RESULTS";

        // Logic حساب النقاط
        let correct = 0, total = room.players.length - 1;
        for (let vId in room.votes) if (room.votes[vId] === room.correctImage) correct++;
        
        if (correct > 0 && correct < total) {
            room.scores[room.currentDrawerId] += (correct * 2);
            for (let vId in room.votes) if (room.votes[vId] === room.correctImage) room.scores[vId] += 3;
        }

        let voteDetails = {}, fakers = {};
        for (let vId in room.votes) {
            const img = room.votes[vId];
            if (!voteDetails[img]) voteDetails[img] = [];
            voteDetails[img].push(room.playerNames[vId]);
        }
        for (let fId in room.fakeImages) fakers[room.fakeImages[fId]] = room.playerNames[fId];

        io.to(rId).emit('roundFinished', { correctImage: room.correctImage, scores: room.scores, voteDetails, fakers });
        
        setTimeout(() => {
            if (room.players.some(id => room.scores[id] >= room.targetPoints)) {
                const lb = room.players.map(id => ({ name: room.playerNames[id], score: room.scores[id] })).sort((a,b) => b.score - a.score);
                io.to(rId).emit('gameOver', { leaderboard: lb });
                delete rooms[rId];
            } else { startNewRound(rId); }
        }, 8000);
    }

    function startTimer(rId, dur, cb) {
        const room = rooms[rId];
        if (room.gameTimer) clearInterval(room.gameTimer);
        let t = dur;
        room.gameTimer = setInterval(() => {
            t--; io.to(rId).emit('timerUpdate', t);
            if (t <= 0) { clearInterval(room.gameTimer); cb(); }
        }, 1000);
    }

    socket.on('sendChat', m => io.to(socket.roomId).emit('newChat', { sender: rooms[socket.roomId].playerNames[socket.userId], text: m }));

    socket.on('disconnect', () => {
        const rId = socket.roomId;
        if (rooms[rId]) {
            rooms[rId].players = rooms[rId].players.filter(id => id !== socket.userId);
            if (rooms[rId].players.length === 0) delete rooms[rId];
            else emitPlayerList(rId);
        }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
