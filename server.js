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

// Image Pools Configuration
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
        
        if (isJoining && !rooms[roomId]) {
            return socket.emit('errorMsg', "Room not found or session expired!");
        }

        socket.join(roomId);
        socket.roomId = roomId;
        socket.userId = userId;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], scores: {}, playerNames: {}, hostId: userId,
                gameState: "LOBBY", currentDrawerId: null,
                currentPool: [], drawerQueue: [], fakeImages: {}, votes: {},
                currentClue: "", correctImage: "", gameTimer: null, 
                targetPoints: 30, roundTimeLimit: 60,
                lastDrawerImages: [], lastFakingPool: [], lastVotingOptions: []
            };
        }

        const room = rooms[roomId];
        room.playerNames[userId] = name;
        if (!room.players.includes(userId)) room.players.push(userId);
        if (room.scores[userId] === undefined) room.scores[userId] = 0;
        
        emitPlayerList(roomId);

        // Hot-Join / Refresh Recovery Logic
        if (room.gameState !== "LOBBY") {
            if (room.gameState === "DRAWING") {
                const imgs = (userId === room.currentDrawerId) ? room.lastDrawerImages : [];
                socket.emit('roundStarted', { images: imgs, drawerId: room.currentDrawerId, drawerName: room.playerNames[room.currentDrawerId] });
            } else if (room.gameState === "FAKING") {
                const imgs = (userId !== room.currentDrawerId) ? room.lastFakingPool : [];
                socket.emit('showClue', { clue: room.currentClue, pImages: imgs, drawerId: room.currentDrawerId });
            } else if (room.gameState === "VOTING") {
                socket.emit('startVoting', { options: room.lastVotingOptions, drawerId: room.currentDrawerId });
            }
        }
    });

    function emitPlayerList(rId) {
        const room = rooms[rId];
        if (room) {
            io.to(rId).emit('updatePlayerList', { 
                players: room.players, playerNames: room.playerNames, 
                hostId: room.hostId, scores: room.scores, 
                gameState: room.gameState, roomId: rId 
            });
        }
    }

    socket.on('requestStart', (data) => {
        const room = rooms[socket.roomId];
        if (room && socket.userId === room.hostId) {
            room.targetPoints = parseInt(data.targetPoints) || 30;
            room.roundTimeLimit = parseInt(data.roundTime) || 60;
            room.currentPool = imagePools[data.mode] || imagePools.classic;
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(rId) {
        const room = rooms[rId];
        if (!room) return;
        
        room.gameState = "DRAWING"; 
        room.fakeImages = {}; 
        room.votes = {};
        
        if (room.drawerQueue.length === 0) room.drawerQueue = shuffle(room.players);
        room.currentDrawerId = room.drawerQueue.shift();
        room.lastDrawerImages = shuffle(room.currentPool).slice(0, 6);

        room.players.forEach(pId => {
            const sid = Array.from(io.sockets.adapter.rooms.get(rId) || []).find(s => io.sockets.sockets.get(s).userId === pId);
            if (sid) {
                const imgs = (pId === room.currentDrawerId) ? room.lastDrawerImages : [];
                io.to(sid).emit('roundStarted', { images: imgs, drawerId: room.currentDrawerId, drawerName: room.playerNames[room.currentDrawerId] });
            }
        });
        
        startTimer(rId, room.roundTimeLimit, () => { 
            if(room.gameState === "DRAWING") startNewRound(rId); 
        });
    }

    socket.on('submitClue', (data) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        
        room.gameState = "FAKING"; 
        room.correctImage = data.image; 
        room.currentClue = data.clue;
        room.lastFakingPool = shuffle(room.currentPool).filter(img => img !== room.correctImage).slice(0, 6);
        
        room.players.forEach(pId => {
            const sid = Array.from(io.sockets.adapter.rooms.get(socket.roomId) || []).find(s => io.sockets.sockets.get(s).userId === pId);
            if (sid) {
                const fImages = (pId !== room.currentDrawerId) ? room.lastFakingPool : [];
                io.to(sid).emit('showClue', { clue: room.currentClue, pImages: fImages, drawerId: room.currentDrawerId });
            }
        });
        startTimer(socket.roomId, room.roundTimeLimit, () => proceedToVoting(socket.roomId));
    });

    socket.on('submitFake', (img) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        room.fakeImages[socket.userId] = img;
        if (Object.keys(room.fakeImages).length >= (room.players.length - 1)) proceedToVoting(socket.roomId);
    });

    function proceedToVoting(rId) {
        const room = rooms[rId];
        if (!room || room.gameState !== "FAKING") return;
        
        room.gameState = "VOTING";
        let opts = [...new Set([room.correctImage, ...Object.values(room.fakeImages)])];
        
        while (opts.length < 6 && opts.length < room.currentPool.length) {
            let rand = room.currentPool[Math.floor(Math.random() * room.currentPool.length)];
            if (!opts.includes(rand)) opts.push(rand);
        }
        
        room.lastVotingOptions = shuffle(opts);
        io.to(rId).emit('startVoting', { options: room.lastVotingOptions, drawerId: room.currentDrawerId });
        startTimer(rId, room.roundTimeLimit, () => finalizeRound(rId));
    }

    socket.on('submitVote', (img) => {
        const room = rooms[socket.roomId];
        if (!room || img === room.fakeImages[socket.userId]) return;
        
        room.votes[socket.userId] = img;
        if (Object.keys(room.votes).length >= (room.players.length - 1)) finalizeRound(socket.roomId);
    });

    function finalizeRound(rId) {
        const room = rooms[rId];
        if (!room || room.gameState !== "VOTING") return;
        
        clearInterval(room.gameTimer);
        room.gameState = "RESULTS";
        
        let correctCount = 0;
        let totalVoters = room.players.length - 1;
        
        for (let vId in room.votes) {
            if (room.votes[vId] === room.correctImage) correctCount++;
        }
        
        if (correctCount > 0 && correctCount < totalVoters) {
            room.scores[room.currentDrawerId] += 3;
            for (let vId in room.votes) {
                if (room.votes[vId] === room.correctImage) room.scores[vId] += 3;
            }
        } else {
            for (let vId in room.votes) {
                if (room.votes[vId] === room.correctImage) room.scores[vId] += 2;
            }
        }

        for (let vId in room.votes) {
            for (let fId in room.fakeImages) {
                if (room.votes[vId] === room.fakeImages[fId] && vId !== fId) {
                    room.scores[fId] += 1;
                }
            }
        }

        let voteDetails = {}, fakers = {};
        for (let vId in room.votes) {
            const img = room.votes[vId];
            if (!voteDetails[img]) voteDetails[img] = [];
            voteDetails[img].push(room.playerNames[vId]);
        }
        for (let fId in room.fakeImages) {
            fakers[room.fakeImages[fId]] = room.playerNames[fId];
        }

        io.to(rId).emit('roundFinished', { 
            correctImage: room.correctImage, 
            scores: room.scores, 
            voteDetails, 
            fakers 
        });
        
        emitPlayerList(rId);

        setTimeout(() => {
            if (!rooms[rId]) return;
            const winner = rooms[rId].players.find(id => rooms[rId].scores[id] >= rooms[rId].targetPoints);
            if (winner) {
                const lb = rooms[rId].players.map(id => ({ 
                    name: rooms[rId].playerNames[id], 
                    score: rooms[rId].scores[id] 
                })).sort((a,b) => b.score - a.score);
                
                io.to(rId).emit('gameOver', { leaderboard: lb });
                delete rooms[rId];
            } else {
                startNewRound(rId);
            }
        }, 8000);
    }

    function startTimer(rId, dur, cb) {
        const room = rooms[rId];
        if (!room) return;
        if (room.gameTimer) clearInterval(room.gameTimer);
        let t = dur;
        io.to(rId).emit('timerUpdate', t);
        room.gameTimer = setInterval(() => {
            t--;
            io.to(rId).emit('timerUpdate', t);
            if (t <= 0) {
                clearInterval(room.gameTimer);
                if(cb) cb();
            }
        }, 1000);
    }

    socket.on('sendChat', m => {
        const room = rooms[socket.roomId];
        if(room) {
            io.to(socket.roomId).emit('newChat', { 
                sender: room.playerNames[socket.userId], 
                text: m 
            });
        }
    });

    socket.on('disconnect', () => {
        const rId = socket.roomId;
        const uId = socket.userId;
        if (rooms[rId]) {
            setTimeout(() => {
                if (!rooms[rId]) return;
                const isStillGone = !Array.from(io.sockets.adapter.rooms.get(rId) || [])
                    .some(s => io.sockets.sockets.get(s).userId === uId);
                
                if (isStillGone) {
                    rooms[rId].players = rooms[rId].players.filter(id => id !== uId);
                    if (rooms[rId].players.length === 0) {
                        clearInterval(rooms[rId].gameTimer);
                        delete rooms[rId];
                    } else {
                        if (uId === rooms[rId].hostId) rooms[rId].hostId = rooms[rId].players[0];
                        emitPlayerList(rId);
                    }
                }
            }, 3000);
        }
    });
});

server.listen(PORT, () => console.log(`PixDeception Server online on port ${PORT}`));
