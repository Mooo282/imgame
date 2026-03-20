const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const imagePools = {
    "classic": ["/images/classic/1.jpg", "/images/classic/2.jpg", "/images/classic/3.jpg", "/images/classic/4.jpg", "/images/classic/5.jpg", "/images/classic/6.jpg", "/images/classic/7.jpg", "/images/classic/8.jpg"],
    "fun": ["/images/fun/1.jpg", "/images/fun/2.jpg", "/images/fun/3.jpg", "/images/fun/4.jpg", "/images/fun/5.jpg", "/images/fun/6.jpg", "/images/fun/7.jpg", "/images/fun/8.jpg"]
};

let players = [], scores = {}, playerNames = {}, hostId = null;
let playerReady = {}, targetPoints = 30, roundTimeLimit = 60;
let currentDrawerId = null, currentPool = [], gameState = "LOBBY";
let currentImages = [], currentClue = "", correctImage = "";
let fakeImages = {}, votes = {}, socketToUserId = {}, drawerQueue = [];
let disconnectTimeouts = {}, gameTimer = null;

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

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
        if (disconnectTimeouts[uId]) { clearTimeout(disconnectTimeouts[uId]); delete disconnectTimeouts[uId]; }
        socketToUserId[socket.id] = uId;
        playerNames[uId] = data.name;
        if (scores[uId] === undefined) scores[uId] = 0;
        if (playerReady[uId] === undefined) playerReady[uId] = false;
        if (!players.includes(uId)) players.push(uId);
        if (!hostId || !players.includes(hostId)) hostId = players[0];
        emitPlayerList();
    });

    socket.on('toggleReady', () => {
        const uId = socketToUserId[socket.id];
        if (uId) { playerReady[uId] = !playerReady[uId]; emitPlayerList(); }
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0);
            targetPoints = parseInt(data.targetPoints) || 30;
            roundTimeLimit = parseInt(data.roundTime) || 60;
            currentPool = imagePools[data.mode] || imagePools["classic"];
            drawerQueue = [];
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; fakeImages = {}; votes = {}; currentClue = "";
        if (drawerQueue.length === 0) drawerQueue = [...players].sort(() => 0.5 - Math.random());
        currentDrawerId = drawerQueue.shift();
        currentImages = [...currentPool].sort(() => 0.5 - Math.random()).slice(0, 6);
        io.emit('roundStarted', { images: currentImages, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId] });
        startTimer(roundTimeLimit, () => { if(gameState === "DRAWING") startNewRound(); });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId || !data.clue) return;
        gameState = "FAKING"; correctImage = data.image; currentClue = data.clue;
        players.forEach(pId => {
            if (pId !== currentDrawerId) {
                // إصلاح مشكلة صور التضليل: اختيار 6 صور بالضبط لا تشمل الصحيحة
                const pImages = currentPool.filter(img => img !== correctImage).sort(() => 0.5 - Math.random()).slice(0, 6);
                const pSid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
                if (pSid) io.to(pSid).emit('showClue', { clue: currentClue, pImages });
            }
        });
        startTimer(roundTimeLimit, () => proceedToVoting());
    });

    socket.on('submitFake', (img) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || fakeImages[uId] || gameState !== "FAKING") return;
        fakeImages[uId] = img;
        if (Object.keys(fakeImages).length >= (players.length - 1)) {
            if (gameTimer) clearInterval(gameTimer);
            proceedToVoting();
        }
    });

    function proceedToVoting() {
        gameState = "VOTING";
        let opts = [correctImage, ...Object.values(fakeImages)];
        opts = [...new Set(opts)];
        if (opts.length < 6) {
            const extra = currentPool.filter(img => !opts.includes(img)).sort(() => 0.5 - Math.random()).slice(0, 6 - opts.length);
            opts = [...opts, ...extra];
        }
        io.emit('startVoting', { options: opts.sort(() => 0.5 - Math.random()), drawerId: currentDrawerId });
        startTimer(roundTimeLimit, () => finalizeRound());
    }

    function finalizeRound() {
        gameState = "RESULTS";
        let totalVoters = players.length - 1;
        let correctCount = 0;
        for (let vId in votes) if (votes[vId] === correctImage) correctCount++;
        
        if (correctCount > 0 && correctCount < totalVoters) {
            scores[currentDrawerId] += (correctCount * 2);
            for (let vId in votes) if (votes[vId] === correctImage) scores[vId] += 3;
        }
        for (let vId in votes) {
            for (let fId in fakeImages) if (votes[vId] === fakeImages[fId] && fId !== vId) scores[fId] += 1;
        }

        // تحديث النقاط فوراً للجميع
        emitPlayerList();

        let voteDetails = {}, fakers = {};
        for (let vId in votes) {
            if (!voteDetails[votes[vId]]) voteDetails[votes[vId]] = [];
            voteDetails[votes[vId]].push(playerNames[vId]);
        }
        for (let fId in fakeImages) fakers[fakeImages[fId]] = playerNames[fId];

        io.emit('roundFinished', { correctImage, scores, voteDetails, fakers, drawerName: playerNames[currentDrawerId] });

        setTimeout(() => {
            if (players.some(id => scores[id] >= targetPoints)) finishGame();
            else if (players.length > 0) startNewRound();
        }, 10000);
    }

    function finishGame() {
        gameState = "LOBBY";
        const lb = players.map(id => ({ name: playerNames[id], score: scores[id] })).sort((a,b) => b.score - a.score);
        io.emit('gameOver', { leaderboard: lb });
        emitPlayerList();
    }

    socket.on('sendChat', (msg) => {
        const uId = socketToUserId[socket.id];
        if (msg && playerNames[uId]) io.emit('newChat', { sender: playerNames[uId], text: msg });
    });

    socket.on('disconnect', () => {
        const uId = socketToUserId[socket.id];
        if (uId) {
            disconnectTimeouts[uId] = setTimeout(() => {
                players = players.filter(id => id !== uId);
                delete playerReady[uId];
                if (uId === hostId) hostId = players.length > 0 ? players[0] : null;
                if (uId === currentDrawerId && gameState !== "LOBBY") startNewRound();
                emitPlayerList();
            }, 5000);
            delete socketToUserId[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
