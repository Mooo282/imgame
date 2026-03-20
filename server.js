const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const imagePools = {
    "classic": ["/images/classic/1.jpg", "/images/classic/2.jpg", "/images/classic/3.jpg", "/images/classic/4.jpg", "/images/classic/5.jpg", "/images/classic/6.jpg"],
    "fun": ["/images/fun/1.jpg", "/images/fun/2.jpg", "/images/fun/3.jpg", "/images/fun/4.jpg", "/images/fun/5.jpg", "/images/fun/6.jpg"]
};

let players = [], scores = {}, playerNames = {}, hostId = null;
let targetPoints = 30, roundTimeLimit = 60, currentDrawerId = null;
let gameState = "LOBBY", currentImages = [], currentClue = "", correctImage = "";
let fakeImages = {}, votes = {}, socketToUserId = {}, drawerQueue = [], drawerGraceTimer = null;
let disconnectTimeouts = {};

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId, scores, gameState, currentDrawerId });
}

function startTimer(duration, onTimeout) {
    if (global.gameTimer) clearInterval(global.gameTimer);
    let timeLeft = duration;
    io.emit('timerUpdate', timeLeft);
    global.gameTimer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { clearInterval(global.gameTimer); if (onTimeout) onTimeout(); }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const uId = data.userId;
        if (disconnectTimeouts[uId]) { clearTimeout(disconnectTimeouts[uId]); delete disconnectTimeouts[uId]; }
        if (uId === currentDrawerId && drawerGraceTimer) { clearTimeout(drawerGraceTimer); drawerGraceTimer = null; }
        socketToUserId[socket.id] = uId;
        playerNames[uId] = data.name;
        if (scores[uId] === undefined) scores[uId] = 0;
        if (!players.includes(uId)) players.push(uId);
        if (!hostId || !players.includes(hostId)) hostId = players[0];
        emitPlayerList();
        if (gameState !== "LOBBY") {
            socket.emit('roundStarted', { images: currentImages, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId], targetPoints });
        }
    });

    socket.on('sendChat', (msg) => {
        const uId = socketToUserId[socket.id];
        if (msg && playerNames[uId]) io.emit('newChat', { sender: playerNames[uId], text: msg });
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0);
            emitPlayerList();
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
        io.emit('roundStarted', { images: currentImages, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId], targetPoints });
        startTimer(roundTimeLimit, () => { if(gameState === "DRAWING") startNewRound(); });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId || !data.clue) return;
        gameState = "FAKING"; correctImage = data.image; currentClue = data.clue;
        players.forEach(pId => {
            if (pId !== currentDrawerId) {
                const pImages = currentPool.filter(img => img !== correctImage).sort(() => 0.5 - Math.random()).slice(0, 6);
                const pSid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
                if (pSid) io.to(pSid).emit('showClue', { clue: currentClue, pImages, drawerName: playerNames[currentDrawerId] });
            }
        });
        startTimer(roundTimeLimit, () => proceedToVoting());
    });

    socket.on('submitFake', (img) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || fakeImages[uId] || gameState !== "FAKING") return;
        fakeImages[uId] = img;
        if (Object.keys(fakeImages).length >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING";
        let opts = [correctImage, ...Object.values(fakeImages)];
        io.emit('startVoting', { options: [...new Set(opts)].sort(() => 0.5 - Math.random()), drawerId: currentDrawerId });
        startTimer(roundTimeLimit, () => finalizeRound());
    }

    socket.on('submitVote', (img) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || votes[uId] || gameState !== "VOTING") return;
        votes[uId] = img;
        if (Object.keys(votes).length >= (players.length - 1)) finalizeRound();
    });

    function calculateScores() {
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
    }

    function finalizeRound() {
        gameState = "RESULTS"; calculateScores();
        let voteDetails = {}, fakers = {};
        for (let vId in votes) {
            if (!voteDetails[votes[vId]]) voteDetails[votes[vId]] = [];
            voteDetails[votes[vId]].push(playerNames[vId]);
        }
        for (let fId in fakeImages) fakers[fakeImages[fId]] = playerNames[fId];
        io.emit('roundFinished', { correctImage, scores, voteDetails, fakers, drawerName: playerNames[currentDrawerId] });
        emitPlayerList();
        setTimeout(() => {
            if (players.some(id => scores[id] >= targetPoints)) finishGame();
            else if (players.length > 0) startNewRound();
        }, 10000);
    }

    socket.on('disconnect', () => {
        const uId = socketToUserId[socket.id];
        if (uId) {
            disconnectTimeouts[uId] = setTimeout(() => {
                players = players.filter(id => id !== uId);
                if (uId === hostId) hostId = players.length > 0 ? players[0] : null;
                if (uId === currentDrawerId && gameState !== "LOBBY") startNewRound();
                emitPlayerList();
            }, 5000);
            delete socketToUserId[socket.id];
        }
    });
});

server.listen(3000, () => console.log('PixDeception Running on 3000'));
