const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// مصفوفة صورك الخاصة (Direct Links)
const allImages = [
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc",
    "https://i.postimg.cc"
];

let players = [], scores = {}, playerNames = {}, hostId = null;
let currentRound = 0, totalRounds = 0, correctImage = "", currentDrawerId = null;
let fakeImages = {}, votes = {}, guessesReceived = 0, timer, timeLeft = 60;
let gameState = "LOBBY", currentImages = [], currentClue = "";
let socketToUserId = {};
let drawerQueue = [];
let disconnectTimeouts = {}; 

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId, scores, gameState });
}

function startTimer(duration, onTimeout) {
    clearInterval(timer);
    timeLeft = duration;
    io.emit('timerUpdate', timeLeft);
    timer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { 
            clearInterval(timer); 
            if (onTimeout) onTimeout(); 
        }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const uId = data.userId;
        if (disconnectTimeouts[uId]) { clearTimeout(disconnectTimeouts[uId]); delete disconnectTimeouts[uId]; }
        socketToUserId[socket.id] = uId;
        playerNames[uId] = data.name;
        if (scores[uId] === undefined) scores[uId] = 0;
        if (!players.includes(uId)) players.push(uId);
        if (!hostId || !players.includes(hostId)) hostId = uId;
        emitPlayerList();
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0); 
            totalRounds = parseInt(data.rounds) || 5;
            currentRound = 1; drawerQueue = [];
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; guessesReceived = 0; fakeImages = {}; votes = {}; currentClue = "";
        if (drawerQueue.length === 0) drawerQueue = [...players].sort(() => 0.5 - Math.random());
        currentDrawerId = drawerQueue.shift();
        
        if (!players.includes(currentDrawerId)) {
            if (players.length > 0) return startNewRound();
            return finishGame();
        }

        currentImages = allImages.sort(() => 0.5 - Math.random()).slice(0, 12);
        io.emit('roundStarted', { images: currentImages, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId], currentRound, totalRounds });
        startTimer(60, () => { if(gameState === "DRAWING") startNewRound(); });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId || !data.clue || !data.clue.trim()) return;
        gameState = "FAKING"; 
        correctImage = data.image; 
        currentClue = data.clue;
        
        players.forEach(pId => {
            if (pId !== currentDrawerId) {
                const pImages = allImages.sort(() => 0.5 - Math.random()).slice(0, 12);
                const pSocketId = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
                if (pSocketId) io.to(pSocketId).emit('showClue', { clue: currentClue, pImages, drawerName: playerNames[currentDrawerId] });
            }
        });
        startTimer(60, () => proceedToVoting());
    });

    socket.on('submitFake', (image) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || fakeImages[uId] || gameState !== "FAKING") return;
        fakeImages[uId] = image; 
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING"; guessesReceived = 0;
        let allOptions = [correctImage];
        for (let id in fakeImages) allOptions.push(fakeImages[id]);
        let finalOptions = [...new Set(allOptions)].sort(() => 0.5 - Math.random());
        io.emit('startVoting', { options: finalOptions, drawerId: currentDrawerId });
        startTimer(60, () => finalizeRound());
    }

    socket.on('submitVote', (votedImage) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || votes[uId] || gameState !== "VOTING") return;
        votes[uId] = votedImage;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) finalizeRound();
    });

    function finalizeRound() {
        gameState = "RESULTS"; calculateScores(); emitPlayerList();
        let voteDetails = {};
        for (let vId in votes) {
            const img = votes[vId];
            if (!voteDetails[img]) voteDetails[img] = [];
            voteDetails[img].push(playerNames[vId]);
        }
        io.emit('roundFinished', { correctImage, scores, voteDetails });
        setTimeout(() => {
            if (currentRound < totalRounds && players.length > 0) { currentRound++; startNewRound(); } 
            else { finishGame(); }
        }, 10000); 
    }

    function calculateScores() {
        for (let voterId in votes) {
            const vote = votes[voterId];
            if (vote === correctImage) {
                scores[voterId] += 10; scores[currentDrawerId] += 5;
            } else {
                for (let fId in fakeImages) {
                    if (fId !== voterId && vote === fakeImages[fId]) scores[fId] += 7;
                }
            }
        }
    }

    function finishGame() {
        gameState = "LOBBY";
        const leaderboard = players.map(id => ({ name: playerNames[id], score: scores[id] })).sort((a,b) => b.score - a.score);
        io.emit('gameOver', { leaderboard });
    }

    socket.on('disconnect', () => {
        const uId = socketToUserId[socket.id];
        if (uId) {
            disconnectTimeouts[uId] = setTimeout(() => {
                players = players.filter(id => id !== uId);
                if (uId === hostId) hostId = players.length > 0 ? players[0] : null;
                delete playerNames[uId]; delete scores[uId];
                emitPlayerList();
            }, 10000);
            delete socketToUserId[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Image Game Server Running on port ${PORT}`));
