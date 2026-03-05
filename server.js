const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});


const allImages = [
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com",
    "https://images.unsplash.com"
];

let players = [], scores = {}, playerNames = {}, hostId = null;
let currentRound = 0, totalRounds = 0, correctImage = "", currentDrawerId = null;
let fakeImages = {}, votes = {}, guessesReceived = 0, timer, timeLeft = 60;
let gameState = "LOBBY";
let socketToUserId = {};
let drawerQueue = [];

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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
        socketToUserId[socket.id] = uId;
        playerNames[uId] = data.name;
        if (scores[uId] === undefined) scores[uId] = 0;
        if (!players.includes(uId)) players.push(uId);
        if (!hostId) hostId = uId;
        emitPlayerList();
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0);
            totalRounds = parseInt(data.rounds) || 5;
            currentRound = 1;
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; guessesReceived = 0; fakeImages = {}; votes = {};
        if (drawerQueue.length === 0) drawerQueue = [...players].sort(() => 0.5 - Math.random());
        currentDrawerId = drawerQueue.shift();
        
        let currentImages = [...allImages].sort(() => 0.5 - Math.random()).slice(0, 9);
        io.emit('roundStarted', { 
            images: currentImages, 
            drawerId: currentDrawerId, 
            drawerName: playerNames[currentDrawerId], 
            currentRound, 
            totalRounds 
        });
        startTimer(60, () => { if(gameState === "DRAWING") startNewRound(); });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId) return;
        correctImage = data.image;
        gameState = "FAKING";
        players.forEach(pId => {
            if (pId !== currentDrawerId) {
                const pImages = [...allImages].sort(() => 0.5 - Math.random()).slice(0, 9);
                const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
                if(sid) io.to(sid).emit('showClue', { clue: data.clue, pImages, drawerName: playerNames[currentDrawerId] });
            }
        });
        startTimer(60);
    });

    socket.on('submitFake', (image) => {
        fakeImages[socketToUserId[socket.id]] = image;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING"; guessesReceived = 0;
        let options = [correctImage, ...Object.values(fakeImages)];
        let finalOptions = [...new Set(options)].sort(() => 0.5 - Math.random());
        io.emit('startVoting', { options: finalOptions, drawerId: currentDrawerId });
        startTimer(60);
    }

    socket.on('submitVote', (votedImage) => {
        votes[socketToUserId[socket.id]] = votedImage;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) finalizeRound();
    });

    function finalizeRound() {
        gameState = "RESULTS";
        let voteDetails = {};
        for(let id in votes) {
            const img = votes[id];
            if(!voteDetails[img]) voteDetails[img] = [];
            voteDetails[img].push(playerNames[id]);
            if(img === correctImage) { 
                scores[id] += 10; 
                scores[currentDrawerId] += 5; 
            }
        }
        emitPlayerList();
        io.emit('roundFinished', { correctImage, scores, voteDetails });
        setTimeout(() => {
            if (currentRound < totalRounds) { currentRound++; startNewRound(); }
            else { io.emit('gameOver', { leaderboard: players.map(id => ({name: playerNames[id], score: scores[id]})).sort((a,b)=>b.score-a.score) }); }
        }, 8000);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
