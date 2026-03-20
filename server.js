const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// --- Image Packs Setup ---
const imagePools = {
    "classic": ["/images/classic/1.jpg", "/images/classic/2.jpg", "/images/classic/3.jpg", "/images/classic/4.jpg", "/images/classic/5.jpg", "/images/classic/6.jpg"],
    "fun": ["/images/fun/1.jpg", "/images/fun/2.jpg", "/images/fun/3.jpg", "/images/fun/4.jpg", "/images/fun/5.jpg", "/images/fun/6.jpg"]
};

let currentPool = [];
let players = [], scores = {}, playerNames = {}, hostId = null;
let targetPoints = 30, roundTimeLimit = 60, currentDrawerId = null;
let gameState = "LOBBY", currentImages = [], currentClue = "", correctImage = "";
let fakeImages = {}, votes = {}, guessesReceived = 0, timer, timeLeft = 60;
let socketToUserId = {}, drawerQueue = [], drawerGraceTimer = null;

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId, scores, gameState, currentDrawerId });
}

function startTimer(duration, onTimeout) {
    clearInterval(timer);
    timeLeft = duration;
    io.emit('timerUpdate', timeLeft);
    timer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { clearInterval(timer); if (onTimeout) onTimeout(); }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const uId = data.userId;
        if (uId === currentDrawerId && drawerGraceTimer) {
            clearTimeout(drawerGraceTimer);
            drawerGraceTimer = null;
        }
        socketToUserId[socket.id] = uId;
        playerNames[uId] = data.name;
        if (scores[uId] === undefined) scores[uId] = 0;
        if (!players.includes(uId)) players.push(uId);
        if (!hostId || !players.includes(hostId)) hostId = uId;
        emitPlayerList();

        if (gameState !== "LOBBY") {
            socket.emit('roundStarted', { images: currentImages, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId], targetPoints });
            if (currentClue) socket.emit('showClue', { clue: currentClue, pImages: [], drawerName: playerNames[currentDrawerId] });
            if (gameState === "VOTING") {
                let opts = [correctImage, ...Object.values(fakeImages)];
                socket.emit('startVoting', { options: [...new Set(opts)], drawerId: currentDrawerId });
            }
        }
    });

    socket.on('sendChat', (msg) => {
        const uId = socketToUserId[socket.id];
        if (msg) io.emit('newChat', { sender: playerNames[uId], text: msg });
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0);
            emitPlayerList();
            targetPoints = parseInt(data.targetPoints);
            roundTimeLimit = parseInt(data.roundTime);
            currentPool = imagePools[data.mode] || imagePools["classic"];
            drawerQueue = [];
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; guessesReceived = 0; fakeImages = {}; votes = {}; currentClue = "";
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
        fakeImages[uId] = img; guessesReceived++;
        if (guessesReceived >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING"; guessesReceived = 0;
        let opts = [correctImage, ...Object.values(fakeImages)];
        io.emit('startVoting', { options: [...new Set(opts)].sort(() => 0.5 - Math.random()), drawerId: currentDrawerId });
        startTimer(roundTimeLimit, () => finalizeRound());
    }

    socket.on('submitVote', (img) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || votes[uId] || gameState !== "VOTING") return;
        votes[uId] = img; guessesReceived++;
        if (guessesReceived >= (players.length - 1)) finalizeRound();
    });

    function calculateScores() {
        let totalVoters = players.length - 1;
        let correctCount = 0;
        for (let vId in votes) if (votes[vId] === correctImage) correctCount++;
        if (correctCount > 0 && correctCount < totalVoters) {
            scores[currentDrawerId] += (correctCount * 2);
        }
        for (let vId in votes) {
            for (let fId in fakeImages) if (votes[vId] === fakeImages[fId] && fId !== vId) scores[fId] += 1;
        }
    }

    function finalizeRound() {
        gameState = "RESULTS"; calculateScores(); emitPlayerList();
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
        }, 8000);
    }

    function finishGame() {
        gameState = "LOBBY";
        const lb = players.map(id => ({ name: playerNames[id], score: scores[id] })).sort((a,b) => b.score - a.score);
        io.emit('gameOver', { leaderboard: lb });
    }

    socket.on('disconnect', () => {
        const uId = socketToUserId[socket.id];
        if (uId) {
            if (uId === currentDrawerId && gameState !== "LOBBY") {
                drawerGraceTimer = setTimeout(() => {
                    if (gameState !== "LOBBY") startNewRound();
                }, 10000);
            }
            delete socketToUserId[socket.id];
        }
    });
});

server.listen(3000, () => console.log('PixDeception: Server Version running on port 3000'));
