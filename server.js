const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Matter = require('matter-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const { Engine, Bodies, Body, Composite, Events } = Matter;
// 엔진 안정성(관통 방지)을 위해 반복 연산 횟수 상향
const engine = Engine.create({ positionIterations: 16, velocityIterations: 12 });

// 우주 밖으로 날아가는 것을 방지하기 위해 천장(ceiling) 추가
const ground = Bodies.rectangle(450, 520, 910, 120, { isStatic: true, friction: 1.0 });
const ceiling = Bodies.rectangle(450, -100, 910, 100, { isStatic: true }); 
const leftWall = Bodies.rectangle(-10, -4725, 20, 10550, { isStatic: true });
const rightWall = Bodies.rectangle(910, -4725, 20, 10550, { isStatic: true });
Composite.add(engine.world, [ground, ceiling, leftWall, rightWall]);

function createCharacter(x, y, name) {
    const core = Bodies.circle(x, y, 25, { label: name + 'Core', density: 1.0 });
    const stick = Bodies.rectangle(x + 60, y, 100, 15, { label: name + 'Stick', chamfer: { radius: 5 }, density: 0.0001 });
    return Body.create({ parts: [core, stick], friction: 0.8, restitution: 0.8, label: name });
}

let players = {}; 
const slots = { player: null, bot: null }; 
let gameState = 'WAITING'; 
let restartTimer = null;

const aiState = {
    active: false
};

function resetUniverse() {
    for (let id in players) {
        if (players[id].body) {
            Composite.remove(engine.world, players[id].body);
        }
    }
    players = {}; 

    if (slots.player) {
        const body1 = createCharacter(300, 300, 'player');
        Composite.add(engine.world, body1);
        players[slots.player] = { body: body1, label: 'player' };
    }

    if (slots.bot) {
        const body2 = createCharacter(600, 300, 'bot');
        Composite.add(engine.world, body2);
        players[slots.bot] = { body: body2, label: 'bot' };
        aiState.active = false; 
    } else if (slots.player) {
        // 1P 혼자일 때 AI 스폰
        const aiBody = createCharacter(600, 300, 'bot');
        Composite.add(engine.world, aiBody);
        players['AI_BOT'] = { body: aiBody, label: 'bot' };
        aiState.active = true; 
    }

    gameState = (slots.player) ? 'PLAYING' : 'WAITING';
    io.emit('game_reset'); 
}

io.on('connection', (socket) => {
    let myRole = null;

    if (!slots.player) {
        myRole = 'player';
        slots.player = socket.id;
    } else if (!slots.bot) {
        myRole = 'bot';
        slots.bot = socket.id;
    }

    if (myRole) {
        socket.emit('role_assign', { id: socket.id, label: myRole });
        io.emit('receive_msg', { role: 'sys', msg: `${myRole === 'player' ? '1P' : '2P'} 님이 전장에 합류했습니다!` });
        
        if (myRole === 'bot' && aiState.active) {
            io.emit('receive_msg', { role: 'sys', msg: '새로운 도전자 접속! 훈련용 AI가 소멸합니다.' });
        } else if (myRole === 'player' && !slots.bot) {
            io.emit('receive_msg', { role: 'sys', msg: '상대방을 기다리는 동안 AI와 대련하세요.' });
        }
        
        resetUniverse(); 
    } else {
        socket.emit('spectator', '방이 가득 차 관전 모드로 전환됩니다.');
    }

    socket.on('send_msg', (msg) => {
        let currentRole = 'spectator';
        if (slots.player === socket.id) currentRole = 'player';
        else if (slots.bot === socket.id) currentRole = 'bot';
        io.emit('receive_msg', { role: currentRole, msg: msg });
    });

    socket.on('player_input', (inputData) => {
        if (gameState !== 'PLAYING') return; 

        const p = players[socket.id];
        if (!p || !p.body) return;

        const maxAngularVelocity = 0.3;
        const baseRotationSpeed = 0.15;

        if (inputData.isDashing) {
            Body.setAngularVelocity(p.body, inputData.dashDirection * 0.6);
        } else {
            if (inputData.left) Body.setAngularVelocity(p.body, -baseRotationSpeed);
            else if (inputData.right) Body.setAngularVelocity(p.body, baseRotationSpeed);
            
            if (Math.abs(p.body.angularVelocity) > maxAngularVelocity) {
                Body.setAngularVelocity(p.body, Math.sign(p.body.angularVelocity) * maxAngularVelocity);
            }
        }
    });

    socket.on('disconnect', () => {
        let leftRole = null;
        if (slots.player === socket.id) { slots.player = null; leftRole = '1P'; }
        if (slots.bot === socket.id) { slots.bot = null; leftRole = '2P'; }

        if (!leftRole) return; 

        io.emit('receive_msg', { role: 'sys', msg: `${leftRole} 님이 도망쳤습니다.` });

        if (!slots.player && slots.bot) {
            slots.player = slots.bot;
            slots.bot = null;
            io.to(slots.player).emit('role_assign', { id: slots.player, label: 'player' });
            io.emit('receive_msg', { role: 'sys', msg: `상대방이 나가서 1P로 변경되었습니다. 훈련용 AI를 가동합니다.` });
        }

        if (!slots.player) {
            gameState = 'WAITING';
            aiState.active = false;
            players = {};
            clearInterval(restartTimer); 
        } else {
            resetUniverse(); 
        }
    });
});

Events.on(engine, 'collisionStart', (event) => {
    if (gameState !== 'PLAYING') return; 

    const pairs = event.pairs;
    for (let i = 0; i < pairs.length; i++) {
        const bodyA = pairs[i].bodyA; 
        const bodyB = pairs[i].bodyB;

        const checkKill = (labelA, labelB, weapon, weakPoint) => { 
            return (labelA === weapon && labelB === weakPoint) || (labelB === weapon && labelA === weakPoint); 
        };
        
        let winnerLabel = null;
        let loserLabel = null;

        if (checkKill(bodyA.label, bodyB.label, 'playerStick', 'botCore')) {
            winnerLabel = 'player'; loserLabel = 'bot';
        } else if (checkKill(bodyA.label, bodyB.label, 'botStick', 'playerCore')) {
            winnerLabel = 'bot'; loserLabel = 'player';
        }

        if (winnerLabel && loserLabel) {
            gameState = 'GAME_OVER';
            
            let loserId = Object.keys(players).find(id => players[id].label === loserLabel);
            if (loserId && players[loserId].body) {
                const loserBody = players[loserId].body;
                const deathX = loserBody.position.x;
                const deathY = loserBody.position.y;

                Composite.remove(engine.world, loserBody);
                players[loserId].body = null; 

                io.emit('game_over', { 
                    winnerLabel: winnerLabel, 
                    loserLabel: loserLabel, 
                    x: deathX, 
                    y: deathY 
                });

                clearInterval(restartTimer);
                let count = 3;
                restartTimer = setInterval(() => {
                    count--;
                    if (count > 0) {
                        io.emit('countdown', count); 
                    } else {
                        clearInterval(restartTimer);
                        resetUniverse(); 
                    }
                }, 1000);
            }
            continue; 
        }
        
        const isStickClash = (bodyA.label === 'playerStick' && bodyB.label === 'botStick') || (bodyB.label === 'playerStick' && bodyA.label === 'botStick');
        if (isStickClash) {
            let contactX = (bodyA.position.x + bodyB.position.x) / 2; 
            let contactY = (bodyA.position.y + bodyB.position.y) / 2;
            if (pairs[i].collision && pairs[i].collision.supports && pairs[i].collision.supports.length > 0) {
                contactX = pairs[i].collision.supports[0].x; 
                contactY = pairs[i].collision.supports[0].y;
            }
            io.emit('create_spark', { x: contactX, y: contactY });
        }
    }
});

let lastTime = Date.now();
setInterval(() => {
    const now = Date.now();
    let delta = now - lastTime;
    lastTime = now;
    if (delta > 33) delta = 33; 

    let isSlowMo = false;
    if (gameState === 'PLAYING') {
        let p1Body = null;
        let p2Body = null;

        if (players[slots.player]) p1Body = players[slots.player].body;
        
        if (slots.bot && players[slots.bot]) {
            p2Body = players[slots.bot].body;
        } else if (!slots.bot && players['AI_BOT']) {
            p2Body = players['AI_BOT'].body;
        }
        
        if (p1Body && p2Body) {
            const dist = Math.hypot(p1Body.position.x - p2Body.position.x, p1Body.position.y - p2Body.position.y);
            if (dist < 180) {
                isSlowMo = true;
                engine.timing.timeScale = 0.3; 
            } else {
                engine.timing.timeScale = 1.0;
            }
        }
    } else {
        engine.timing.timeScale = 1.0;
    }

    // ==========================================
    // [스마트 AI 로직] 속도 제한형 추적 알고리즘 적용
    // ==========================================
    if (aiState.active && gameState === 'PLAYING') {
        let p1Body = players[slots.player] ? players[slots.player].body : null;
        let aiBody = players['AI_BOT'] ? players['AI_BOT'].body : null;

        if (p1Body && aiBody) {
            let dx = p1Body.position.x - aiBody.position.x;
            let aiSpeedX = aiBody.velocity.x;
            
            // 거리가 멀고, AI가 과속(돌진) 상태가 아닐 때만 회전력을 주어 안전하게 굴러가도록 통제
            if (dx < -30 && aiSpeedX > -6) {
                Body.setAngularVelocity(aiBody, -0.12);
            } else if (dx > 30 && aiSpeedX < 6) {
                Body.setAngularVelocity(aiBody, 0.12);
            }
        }
    }

    Engine.update(engine, delta);

    const syncData = { _isSlowMo: isSlowMo }; 
    
    for (let id in players) {
        const pBody = players[id].body;
        if (pBody) {
            syncData[id] = {
                label: players[id].label,
                x: pBody.position.x,
                y: pBody.position.y,
                angle: pBody.angle,
                velocity: pBody.velocity,
                angularVelocity: pBody.angularVelocity
            };
        }
    }
    io.emit('sync_state', syncData);

}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버 가동 중 (Port: ${PORT})`);
});
