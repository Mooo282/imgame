const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // لضمان عمل السوكيت على السيرفرات السحابية
});

const PORT = process.env.PORT || 3000;

// إعداد المجلدات الثابتة
app.use(express.static(path.join(__dirname)));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// إصلاح دالة الطلب الرئيسي (إضافة req)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const imagePools = {
    "classic": Array.from({length: 50}, (_, i) => `/images/classic/${i+1}.jpg`),
    "fun": Array.from({length: 50}, (_, i) => `/images/fun/${i+1}.jpg`)
};

let players = [], scores = {}, playerNames = {}, hostId = null;
let playerReady = {}, targetPoints = 30, roundTimeLimit = 60;
let currentDrawerId = null, currentPool = [], gameState = "LOBBY";
let currentImages = [], currentClue = "", correctImage = "";
let fakeImages = {}, votes = {}, socketToUserId = {}, drawerQueue = [];
let gameTimer = null;

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId, scores, gameState, currentDrawerId, playerReady });
}

function startTimer(duration, onTimeout) {
    if (gameTimer) clearInterval(gameTimer);
    let timeLeft = duration;
    io.emit('timerUpdate', timeLeft);
    gameTimer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { clearInterval(gameTimer); if (onTimeout) onTimeout(); }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const uId = data.userId;
        socketToUserId[socket.id] = uId;
        playerNames[uId] = data.name;
        if (scores[uId] === undefined) scores[uId] = 0;
        if (playerReady[uId] === undefined) playerReady[uId] = false;
        if (!players.includes(uId)) players.push(uId);
        if (!hostId || !players.includes(hostId)) hostId = players[0];

        if (gameState !== "LOBBY") {
            if (gameState === "DRAWING") {
                socket.emit('roundStarted', { images: currentImages, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId] });
            } else if (gameState === "FAKING") {
                const pImages = [...currentPool].filter(img => img !== correctImage).sort(() => 0.5 - Math.random()).slice(0, 6);
                socket.emit('showClue', { clue: currentClue, pImages });
            } else if (gameState === "VOTING") {
                sendVotingOptions(socket.id);
            }
        }
        emitPlayerList();
    });

    socket.on('toggleReady', () => {
        const uId = socketToUserId[socket.id];
        if (uId) { playerReady[uId] = !playerReady[uId]; emitPlayerList(); }
    });

    socket.on('forceEndGame', () => {
        if (socketToUserId[socket.id] === hostId) {
            if (gameTimer) clearInterval(gameTimer);
            gameState = "LOBBY";
            players.forEach(id => { scores[id] = 0; playerReady[id] = false; });
            io.emit('gameResetByHost');
            emitPlayerList();
        }
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            targetPoints = parseInt(data.targetPoints);
            roundTimeLimit = parseInt(data.roundTime);
            currentPool = imagePools[data.mode] || imagePools["classic"];
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; fakeImages = {}; votes = {};
        if (drawerQueue.length === 0) drawerQueue = [...players].sort(() => 0.5 - Math.random());
        currentDrawerId = drawerQueue.shift();
        currentImages = [...currentPool].sort(() => 0.5 - Math.random()).slice(0, 6);
        io.emit('roundStarted', { images: currentImages, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId] });
        startTimer(roundTimeLimit, () => { if(gameState === "DRAWING") startNewRound(); });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId) return;
        gameState = "FAKING"; correctImage = data.image; currentClue = data.clue;
        players.forEach(pId => {
            if (pId !== currentDrawerId) {
                const pImages = [...currentPool].filter(img => img !== correctImage).sort(() => 0.5 - Math.random()).slice(0, 6);
                const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
                if (sid) io.to(sid).emit('showClue', { clue: currentClue, pImages });
            }
        });
        startTimer(roundTimeLimit, () => proceedToVoting());
    });

    socket.on('submitFake', (img) => {
        const uId = socketToUserId[socket.id];
        if (uId && uId !== currentDrawerId) fakeImages[uId] = img;
        if (Object.keys(fakeImages).length >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING";
        sendVotingOptions();
        startTimer(roundTimeLimit, () => finalizeRound());
    }

    function sendVotingOptions(targetId = null) {
        let opts = [...new Set([correctImage, ...Object.values(fakeImages)])];
        while(opts.length < Math.min(6, currentPool.length)) {
            let rand = currentPool[Math.floor(Math.random()*currentPool.length)];
            if(!opts.includes(rand)) opts.push(rand);
        }
        const data = { options: opts.sort(() => 0.5 - Math.random()), drawerId: currentDrawerId };
        if(targetId) io.to(targetId).emit('startVoting', data);
        else io.emit('startVoting', data);
    }

    socket.on('submitVote', (img) => {
        const uId = socketToUserId[socket.id];
        if (uId && uId !== currentDrawerId) votes[uId] = img;
        if (Object.keys(votes).length >= (players.length - 1)) finalizeRound();
    });

    function finalizeRound() {
        if (gameTimer) clearInterval(gameTimer);
        gameState = "RESULTS";
        let total = players.length - 1, correct = 0;
        for (let vId in votes) if (votes[vId] === correctImage) correct++;
        
        if (correct > 0 && correct < total) {
            scores[currentDrawerId] += (correct * 2);
            for (let vId in votes) if (votes[vId] === correctImage) scores[vId] += 2;
        } else if (correct === total) {
            for (let vId in votes) scores[vId] += 2;
        }

        for (let vId in votes) {
            for (let fId in fakeImages) if (votes[vId] === fakeImages[fId] && fId !== vId) scores[fId] += 1;
        }

        let voteDetails = {}, fakers = {};
        for (let vId in votes) { 
            if (!voteDetails[votes[vId]]) voteDetails[votes[vId]] = []; 
            voteDetails[votes[vId]].push(playerNames[vId]); 
        }
        for (let fId in fakeImages) fakers[fakeImages[fId]] = playerNames[fId];

        io.emit('roundFinished', { correctImage, scores, voteDetails, fakers });
        emitPlayerList();
        setTimeout(() => {
            if (players.some(id => scores[id] >= targetPoints)) {
                const lb = players.map(id => ({ name: playerNames[id], score: scores[id] })).sort((a,b) => b.score - a.score);
                io.emit('gameOver', { leaderboard: lb });
                gameState = "LOBBY";
            } else if(players.length > 0) startNewRound();
        }, 8000);
    }

    socket.on('sendChat', (msg) => {
        const uId = socketToUserId[socket.id];
        if(uId) io.emit('newChat', { sender: playerNames[uId], text: msg });
    });

    socket.on('disconnect', () => {
        const sid = socket.id;
        const uId = socketToUserId[sid];
        delete socketToUserId[sid];
        if (uId && !Object.values(socketToUserId).includes(uId)) {
            setTimeout(() => {
                if (!Object.values(socketToUserId).includes(uId)) {
                    players = players.filter(id => id !== uId);
                    if (uId === hostId) hostId = players[0] || null;
                    emitPlayerList();
                }
            }, 5000);
        }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
