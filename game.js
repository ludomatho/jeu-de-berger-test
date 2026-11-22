'use strict';
// Toutes les distances sont exprimées en unités de terrain, les vitesses par seconde.
const CONFIG = Object.freeze({
  step: 1 / 120, dogSpeed: 185, sheepRadius: 10,
  dogRadius: 12, separation: 38, separationForce: 65, wanderSpeed: 7, calmSpeed: 19, fleeSpeed: 70, dogRange: 145,
  fleeForce: 91, edgeRange: 65, edgeForce: 80, response: 3.5,
  agitationRange: 90, agitationRise: 5, agitationDecay: 0.55,
  agitationSpeed: 0.24, agitationSpacing: 0.42, agitationForce: 0.28,
  densityRange: 100, densityFull: 3, dogSlowdown: 0.22, dogSpeedResponse: 4,
  anticipation: 85, corridor: 38, sidestepForce: 95, contactDistance: 32,
  holdDelay: 220, dragThreshold: 8,
  bodySpacing: 30, spacingResponse: 24, spacingCorrectionSpeed: 48,
  rebelInitialMin: 8, rebelInitialMax: 18,
  rebelDogYieldRange: 110,
  rebelBurstForce: 18, rebelBurstRise: 6, rebelBurstDecay: 2.5,
  surpriseRange: 60, surpriseSpeedThreshold: 24, surpriseMax: 0.22,
  surpriseRise: 6, surpriseDecay: 1.2, surpriseForce: 28, surpriseSpeedGain: 0.5
});

const SOCIAL = Object.freeze({ force:24, cap:22, separationDistance:30, softBand:20, dogSuppression:0.9 });
const PROFILE_DEFAULTS = Object.freeze({
  color:'#fff9e9', highlight:'#fffdf4', attractiveness:1, range:160, receptivity:1,
  separation:1, speed:1, dogRange:1, dogForce:1, response:1, turn:1,
  movingAttraction:0, escapeForce:0, escapeSpeed:0, burstSpeed:0,
  waitMin:14, waitMax:26, escapeMin:3, escapeMax:5, burstMin:0.7, burstMax:1.2
});
const PERSONALITIES = Object.freeze({
  normal: {},
  foufou: {color:'#E8A0A4',highlight:'#F1BBC0',attractiveness:1.3,receptivity:0.85,
    escapeForce:22,escapeSpeed:5,burstSpeed:22},
  meneur: {color:'#D9B54A',highlight:'#F0D786',attractiveness:2,movingAttraction:0.6},
  peureux: {color:'#B5D9ED',highlight:'#D4EAF5',dogRange:1.3,dogForce:1.15,speed:1.05},
  tetu: {color:'#A4AAA4',highlight:'#C4C9C3',receptivity:0.6,dogRange:0.9,dogForce:0.85,response:0.65,turn:0.65}
});
// Lignes = receveur, colonnes = émetteur. Aucun coefficient d'émission ici.
const SENSITIVITY = Object.freeze({
  normal:  {normal:1,foufou:1,meneur:1,peureux:1,tetu:1},
  foufou:  {normal:1,foufou:1,meneur:1.1,peureux:1,tetu:1},
  meneur:  {normal:1,foufou:0.8,meneur:1,peureux:1,tetu:1},
  peureux: {normal:1,foufou:0.45,meneur:1.6,peureux:1,tetu:1},
  tetu:    {normal:0.8,foufou:0.65,meneur:0.9,peureux:0.8,tetu:0.8}
});
// Banc manuel facultatif : true remplace seulement la session JOUER, pas LEVELS.
const DEVELOPMENT = Object.freeze({ personalities:false });
function resolveProfile(type='normal', intensity=1, overrides={}) {
  if(type==='rebel') type='foufou'; // Anciennes configurations compatibles.
  if(!Object.hasOwn(PERSONALITIES,type)) throw new Error('Personnalité inconnue : '+type);
  if(!Number.isFinite(intensity)) throw new Error('Intensité invalide');
  intensity=Math.max(0,Math.min(2,intensity));
  const target={...PROFILE_DEFAULTS,...PERSONALITIES[type]},result={type,intensity};
  for(const key of Object.keys(PROFILE_DEFAULTS)){
    const value=target[key],base=PROFILE_DEFAULTS[key];
    result[key]=typeof value==='number'?base+(value-base)*intensity:value;
  }
  const limits={attractiveness:[0,4],range:[40,220],receptivity:[0,2],separation:[1,1.4],
    speed:[0.75,1.3],dogRange:[0.75,1.6],dogForce:[0.6,1.6],response:[0.4,1.5],turn:[0.4,1.5]};
  for(const [key,value] of Object.entries(overrides)){
    if(!limits[key]||!Number.isFinite(value))throw new Error('Paramètre individuel invalide : '+key);
    result[key]=Math.max(limits[key][0],Math.min(limits[key][1],value));
  }
  return Object.freeze(result);
}
function makeSheep(spawn) {
  const profile=resolveProfile(spawn.type,spawn.intensity??1,spawn.traits??{});
  return {x:spawn.x,y:spawn.y,group:spawn.group,vx:0,vy:0,angle:-Math.PI/2,
    phase:Math.random()*Math.PI*2,temperament:0.88+Math.random()*0.24,
    profile,type:profile.type,agitation:0,surprise:0,surpriseX:0,surpriseY:0,
    mood:'calm',wait:randomBetween(CONFIG.rebelInitialMin,CONFIG.rebelInitialMax),escapeLeft:0,escapeAngle:0,
    burstDelay:0,burstLeft:0,burst:0,boldness:randomBetween(0.9,1.1)};
}
function socialVisible(a,b) {
  // Les clôtures interrompent l'influence directe ; aucune recherche de chemin.
  return !walls.some(w=>{
    const dx=b.x-a.x,dy=b.y-a.y,wx=w.x2-w.x1,wy=w.y2-w.y1;
    const cross=dx*wy-dy*wx;
    if(Math.abs(cross)<1e-9)return false;
    const rx=w.x1-a.x,ry=w.y1-a.y,t=(rx*wy-ry*wx)/cross,u=(rx*dy-ry*dx)/cross;
    return t>0&&t<1&&u>=0&&u<=1;
  });
}
function localAttraction(receiver) {
  let x=0,y=0,neighbors=0;
  for(const source of sheep){
    if(source===receiver)continue;
    const dx=source.x-receiver.x,dy=source.y-receiver.y,d=Math.hypot(dx,dy);
    // La portée personnelle du receveur limite aussi sa perception.
    const range=Math.min(receiver.profile.range,source.profile.range);
    if(d>=range||d<1e-8||!socialVisible(receiver,source))continue;
    neighbors++;
    const spacing=Math.max(0,Math.min(1,(d-SOCIAL.separationDistance)/SOCIAL.softBand));
    const weight=spacing*(1-d/range)**2;
    const moving=Math.min(1,Math.hypot(source.vx,source.vy)/CONFIG.calmSpeed);
    const sensitivity=1+(SENSITIVITY[receiver.type][source.type]-1)*receiver.profile.intensity;
    const strength=SOCIAL.force*source.profile.attractiveness*(1+source.profile.movingAttraction*moving)*
      Math.max(0,sensitivity)*receiver.profile.receptivity*weight;
    x+=dx/d*strength;y+=dy/d*strength;
  }
  const length=Math.hypot(x,y),scale=length>0?SOCIAL.cap*Math.tanh(length/SOCIAL.cap)/length:0;
  return {x:x*scale,y:y*scale,neighbors};
}
function startPersonalityTest(){
  startLevel(0);
  activeLevel={...activeLevel,id:'test',title:'Test des personnalités',sheepCount:10,victory:{type:'disabled'}};
  walls=[];sheep.length=0;
  Object.keys(PERSONALITIES).forEach((type,i)=>{
    for(let j=0;j<2;j++)sheep.push(makeSheep({type,x:160+i*55,y:410+j*55,group:'test'}));
  });
  ui['level-title'].textContent='Test des cinq personnalités';
  ui.objective.textContent='Blanc · rouge · doré · bleu · gris';
}

const LEVELS = [
  {
    id: 1, title: 'Les premiers moutons', sheepCount: 4,
    terrain: { width: 600, height: 820 }, dogStart: { x: 300, y: 650 },
    pen: { x: 110, y: 75, width: 380, height: 235, opening: { side: 'bottom', width: 200 } },
    sheep: [
      { type: 'normal', group: 'A', x: 255, y: 430 },
      { type: 'normal', group: 'A', x: 308, y: 415 },
      { type: 'normal', group: 'A', x: 280, y: 475 },
      { type: 'normal', group: 'A', x: 337, y: 465 }
    ],
    victory: { type: 'allInside', fullBody: true },
    difficulty: { label: 'Découverte', physicsOverrides: null }
  },
  {
    id: 2, title: 'Le troupeau dispersé', sheepCount: 6,
    terrain: { width: 640, height: 840 }, dogStart: { x: 320, y: 690 },
    pen: { x: 110, y: 75, width: 420, height: 245, opening: { side: 'bottom', width: 220 } },
    sheep: [
      { type: 'normal', group: 'A', x: 165, y: 445 },
      { type: 'normal', group: 'A', x: 205, y: 465 },
      { type: 'normal', group: 'A', x: 168, y: 495 },
      { type: 'normal', group: 'B', x: 430, y: 445 },
      { type: 'normal', group: 'B', x: 470, y: 465 },
      { type: 'normal', group: 'B', x: 434, y: 498 }
    ],
    victory: { type: 'allInside', fullBody: true },
    difficulty: { label: 'Deux groupes', physicsOverrides: null }
  }
];
// Règles ajoutées pour les barrières ; CONFIG conserve toute la physique V0.2.2.
const FENCE = Object.freeze({ halfWidth: 3, sheepBody: 15, dogBody: 20,
  avoidRange: 36, avoidForce: 24, maxMoveStep: 4 });
let mode = 'home', activeLevel = null, walls = [];
const ui = Object.fromEntries(['home','game','victory','play','restart','next','home-button',
  'level-title','objective','victory-title','stage'].map(id => [id, document.getElementById(id)]));

const canvas = document.getElementById('field');
const ctx = canvas.getContext('2d');
const world = { width: 900, height: 900 };
const dog = { x: 450, y: 700, tx: 450, ty: 700, angle: -Math.PI / 2, speed: CONFIG.dogSpeed };
const sheep = [];
function randomBetween(min,max){return min+Math.random()*(max-min);}
let elapsed = 0, lastTime = null, accumulator = 0, markerTime = 0;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function resize() {
  // Le terrain du niveau garde ses coordonnées : tourner le téléphone ne déplace rien.
  const rect=ui.stage.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  const scale=Math.min(rect.width/world.width,rect.height/world.height);
  const width=world.width*scale,height=world.height*scale;
  canvas.style.width=width+'px';canvas.style.height=height+'px';
  const dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
}
new ResizeObserver(resize).observe(ui.stage);
// Un seul pointeur commande le chien. Aucun historique de trajectoire.
let steering = null;
function pointDogAt(event) {
  const rect = canvas.getBoundingClientRect();
  dog.tx = clamp((event.clientX - rect.left) / rect.width * world.width, 16, world.width - 16);
  dog.ty = clamp((event.clientY - rect.top) / rect.height * world.height, 16, world.height - 16);
}
function stopSteering() {
  if (!steering) return;
  const id = steering.id;
  steering = null;
  dog.tx = dog.x; dog.ty = dog.y;
  markerTime = 0;
  if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
}
canvas.addEventListener('pointerdown', event => {
  event.preventDefault();
  if (mode !== 'playing' || steering || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
  steering = { id: event.pointerId, x: event.clientX, y: event.clientY,
    started: event.timeStamp, moved: false };
  canvas.setPointerCapture(event.pointerId);
  pointDogAt(event); // Départ immédiat, même avant la distinction toucher/maintien.
  markerTime = 0.65;
});
canvas.addEventListener('pointermove', event => {
  if (!steering || event.pointerId !== steering.id) return;
  event.preventDefault();
  if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) { stopSteering(); return; }
  steering.moved ||= Math.hypot(event.clientX - steering.x, event.clientY - steering.y) >= CONFIG.dragThreshold;
  pointDogAt(event);
});
canvas.addEventListener('pointerup', event => {
  if (!steering || event.pointerId !== steering.id) return;
  event.preventDefault();
  const continuous = steering.moved ||
    Math.hypot(event.clientX - steering.x, event.clientY - steering.y) >= CONFIG.dragThreshold ||
    event.timeStamp - steering.started >= CONFIG.holdDelay;
  if (continuous) { stopSteering(); return; }
  // Un toucher bref laisse le chien terminer son déplacement automatique.
  const id = steering.id;
  pointDogAt(event);
  steering = null;
  if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
});
for (const eventName of ['pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(eventName, event => {
    if (steering && event.pointerId === steering.id) stopSteering();
  });
}
window.addEventListener('blur', stopSteering);
canvas.addEventListener('contextmenu', event => event.preventDefault());


// Les profils partagent ce moteur ; seules les fugues configurées ont un état temporaire.

function updatePersonalities(dt, social) {
  sheep.forEach((s,i)=>{
    if(s.profile.escapeForce<=0)return;
    const nearDog=Math.hypot(s.x-dog.x,s.y-dog.y)<CONFIG.rebelDogYieldRange;
    if(s.mood==='calm'){
      s.wait-=dt;
      if(s.wait<=0&&!nearDog&&social[i].neighbors>0){
        s.mood='escape';s.escapeLeft=randomBetween(s.profile.escapeMin,s.profile.escapeMax);
        const a=social[i];
        s.escapeAngle=Math.hypot(a.x,a.y)>0.1?Math.atan2(-a.y,-a.x)+randomBetween(-1.1,1.1):randomBetween(-Math.PI,Math.PI);
        s.burstDelay=randomBetween(0.25,1.4);s.burstLeft=0;
      }
    }else{
      s.escapeLeft-=dt;
      if(s.escapeLeft<=0||nearDog||social[i].neighbors===0){
        s.mood='calm';s.wait=randomBetween(s.profile.waitMin,s.profile.waitMax);s.burstLeft=0;
      }else{
        const before=s.burstDelay;s.burstDelay-=dt;
        if(before>0&&s.burstDelay<=0)s.burstLeft=randomBetween(s.profile.burstMin,s.profile.burstMax);
      }
    }
    s.burstLeft=Math.max(0,s.burstLeft-dt);
    const target=s.burstLeft>0&&s.mood==='escape'?1:0;
    s.burst+=(target-s.burst)*(1-Math.exp(-(target>s.burst?CONFIG.rebelBurstRise:CONFIG.rebelBurstDecay)*dt));
  });
  for(const s of sheep){
    let target=0,awayX=0,awayY=0;
    for(const r of sheep){
      if(r===s||r.profile.escapeForce<=0||r.burst<0.2||Math.hypot(r.vx,r.vy)<CONFIG.surpriseSpeedThreshold)continue;
      const dx=s.x-r.x,dy=s.y-r.y,d=Math.hypot(dx,dy);
      if(d>=CONFIG.surpriseRange||!socialVisible(s,r))continue;
      const strength=CONFIG.surpriseMax*(1-d/CONFIG.surpriseRange)*r.burst;
      if(strength>target){target=strength;const a=d>0.001?Math.atan2(dy,dx):s.phase;awayX=Math.cos(a);awayY=Math.sin(a);}
    }
    if(target>0){s.surpriseX=awayX;s.surpriseY=awayY;}
    s.surprise+=(target-s.surprise)*(1-Math.exp(-(target>s.surprise?CONFIG.surpriseRise:CONFIG.surpriseDecay)*dt));
  }
}

function buildWalls(pen) {
  const { x, y, width: w, height: h } = pen;
  // Une ouverture centrée sur le côté bas ; utilisée par les deux niveaux.
  const left = x + (w - pen.opening.width) / 2, right = left + pen.opening.width;
  return [
    { x1:x,y1:y,x2:x+w,y2:y }, { x1:x,y1:y,x2:x,y2:y+h },
    { x1:x+w,y1:y,x2:x+w,y2:y+h },
    { x1:x,y1:y+h,x2:left,y2:y+h }, { x1:right,y1:y+h,x2:x+w,y2:y+h }
  ];
}
function startLevel(index) {
  const level = LEVELS[index];
  if (!level || level.sheep.length !== level.sheepCount) throw new Error('Configuration de niveau invalide');
  stopSteering();
  activeLevel = level; walls = buildWalls(level.pen);
  world.width = level.terrain.width; world.height = level.terrain.height;
  Object.assign(dog, level.dogStart, { tx:level.dogStart.x, ty:level.dogStart.y,
    speed:CONFIG.dogSpeed, angle:-Math.PI/2 });
  sheep.length = 0;
  level.sheep.forEach(spawn=>sheep.push(makeSheep(spawn)));
  elapsed=0;lastTime=null;accumulator=0;markerTime=0;mode='playing';
  ui.home.hidden=true;ui.victory.hidden=true;ui.game.hidden=false;ui.game.inert=false;
  ui['level-title'].textContent='Niveau '+level.id+' · '+level.title;
  updateObjective();resize();draw();
  canvas.focus({preventScroll:true});
}
function showHome() {
  stopSteering();mode='home';activeLevel=null;walls=[];sheep.length=0;
  lastTime=null;accumulator=0;markerTime=0;
  ui.game.hidden=true;ui.game.inert=true;ui.victory.hidden=true;ui.home.hidden=false;
  ui.play.focus({preventScroll:true});
}
function entirelyInPen(s) {
  const p=activeLevel.pen, margin=FENCE.sheepBody+FENCE.halfWidth;
  return s.x>=p.x+margin && s.x<=p.x+p.width-margin &&
    s.y>=p.y+margin && s.y<=p.y+p.height-margin;
}
function updateObjective() {
  ui.objective.textContent=sheep.filter(entirelyInPen).length+' / '+activeLevel.sheepCount+' moutons dans l’enclos';
}
function checkVictory() {
  if(mode!=='playing'||activeLevel.victory.type!=='allInside'||sheep.length!==activeLevel.sheepCount) return;
  updateObjective();
  if(!sheep.every(entirelyInPen)) return;
  stopSteering();dog.tx=dog.x;dog.ty=dog.y;mode='won';accumulator=0;
  ui.game.inert=true;ui.victory.hidden=false;
  ui['victory-title'].textContent='Bravo ! Niveau '+activeLevel.id+' réussi !';
  const hasNext=LEVELS.indexOf(activeLevel)<LEVELS.length-1;
  ui.next.hidden=!hasNext;ui['home-button'].hidden=hasNext;
  (hasNext?ui.next:ui['home-button']).focus({preventScroll:true});
}
ui.play.addEventListener('click',()=>DEVELOPMENT.personalities?startPersonalityTest():startLevel(0));
ui.restart.addEventListener('click',()=>{if(mode==='playing'){if(activeLevel.id==='test')startPersonalityTest();else startLevel(LEVELS.indexOf(activeLevel));}});
ui.next.addEventListener('click',()=>{if(mode==='won')startLevel(LEVELS.indexOf(activeLevel)+1);});
ui['home-button'].addEventListener('click',showHome);

function nearestOnWall(x,y,wall) {
  const dx=wall.x2-wall.x1,dy=wall.y2-wall.y1;
  const t=clamp(((x-wall.x1)*dx+(y-wall.y1)*dy)/(dx*dx+dy*dy),0,1);
  return {x:wall.x1+t*dx,y:wall.y1+t*dy};
}
function clearOfWalls(x,y,body) {
  return walls.every(w=>{const p=nearestOnWall(x,y,w);return Math.hypot(x-p.x,y-p.y)>=body+FENCE.halfWidth-1e-6;});
}
// Déplacements découpés : même une correction de contact ne peut franchir un mur.
function constrainMove(animal,from,body) {
  const dx=animal.x-from.x,dy=animal.y-from.y;
  const steps=Math.max(1,Math.ceil(Math.hypot(dx,dy)/FENCE.maxMoveStep));
  let x=from.x,y=from.y;
  for(let step=0;step<steps;step++){
    const oldX=x,oldY=y;x+=dx/steps;y+=dy/steps;
    for(let pass=0;pass<3;pass++)for(const wall of walls){
      const p=nearestOnWall(x,y,wall);let nx=x-p.x,ny=y-p.y,d=Math.hypot(nx,ny);
      const radius=body+FENCE.halfWidth;
      if(d>=radius)continue;
      if(d<1e-8){const old=nearestOnWall(oldX,oldY,wall);nx=oldX-old.x;ny=oldY-old.y;d=Math.hypot(nx,ny);
        if(d<1e-8){nx=wall.y1===wall.y2?0:1;ny=wall.y1===wall.y2?1:0;d=1;}}
      nx/=d;ny/=d;x=p.x+nx*radius;y=p.y+ny*radius;
      if(Number.isFinite(animal.vx)){const inward=Math.min(0,animal.vx*nx+animal.vy*ny);animal.vx-=inward*nx;animal.vy-=inward*ny;}
    }
  }
  animal.x=clamp(x,body,world.width-body);animal.y=clamp(y,body,world.height-body);
}
function fenceAvoidance(s) {
  let x=0,y=0;
  for(const wall of walls){
    const p=nearestOnWall(s.x,s.y,wall),dx=s.x-p.x,dy=s.y-p.y,d=Math.hypot(dx,dy);
    if(d>0&&d<FENCE.avoidRange){const force=(1-d/FENCE.avoidRange)**2*FENCE.avoidForce;x+=dx/d*force;y+=dy/d*force;}
  }
  return {x,y};
}
function drawPen() {
  if(!activeLevel||activeLevel.id==='test')return;
  const p=activeLevel.pen;
  ctx.fillStyle='rgba(226,239,172,.24)';ctx.fillRect(p.x,p.y,p.width,p.height);
  ctx.strokeStyle='#665640';ctx.lineWidth=FENCE.halfWidth*2;ctx.lineCap='round';
  for(const wall of walls){ctx.beginPath();ctx.moveTo(wall.x1,wall.y1);ctx.lineTo(wall.x2,wall.y2);ctx.stroke();}
  ctx.fillStyle='#334f30';ctx.font='14px system-ui';ctx.textAlign='center';
  ctx.fillText('ENCLOS',p.x+p.width/2,p.y+30);
}

function update(dt) {
  if (mode !== 'playing') return;
  const previousDog={x:dog.x,y:dog.y};
  const previousSheep=sheep.map(s=>({x:s.x,y:s.y}));
  elapsed += dt; markerTime = Math.max(0, markerTime - dt);
  const dx = dog.tx - dog.x, dy = dog.ty - dog.y, distance = Math.hypot(dx, dy);
  const density = sheep.reduce((sum, s) => {
    const near = clamp(1 - Math.hypot(s.x - dog.x, s.y - dog.y) / CONFIG.densityRange, 0, 1);
    return sum + near * near;
  }, 0);
  const desiredSpeed = CONFIG.dogSpeed * (1 - CONFIG.dogSlowdown * clamp(density / CONFIG.densityFull, 0, 1));
  dog.speed += (desiredSpeed - dog.speed) * (1 - Math.exp(-CONFIG.dogSpeedResponse * dt));
  if (distance > 0) {
    const travel = Math.min(distance, dog.speed * dt);
    dog.x += dx / distance * travel; dog.y += dy / distance * travel;
    dog.angle = Math.atan2(dy, dx);
  }
  constrainMove(dog,previousDog,FENCE.dogBody);
  // Une mémoire courte de proximité : montée douce, retour au calme plus lent.
  for (const s of sheep) {
    const near = clamp(1 - Math.hypot(s.x - dog.x, s.y - dog.y) / (CONFIG.agitationRange*s.profile.dogRange), 0, 1);
    const target = clamp(near * near * (3 - 2 * near) * s.temperament, 0, 1);
    const rate = target > s.agitation ? CONFIG.agitationRise : CONFIG.agitationDecay;
    s.agitation += (target - s.agitation) * (1 - Math.exp(-rate * dt));
  }
  const social=sheep.map(localAttraction);
  updatePersonalities(dt,social);
  // Calcul simultané : aucun mouton ne lit un voisin déjà déplacé.
  const velocities = sheep.map((s, i) => {
    const wander = s.phase + Math.sin(elapsed * 0.43 + s.phase) * 1.8 + elapsed * 0.09;
    const pressure=Math.max(0,1-Math.hypot(s.x-dog.x,s.y-dog.y)/(CONFIG.dogRange*s.profile.dogRange));
    const socialGain=(1-SOCIAL.dogSuppression*pressure)*(s.mood==='escape'?0.55:1);
    let vx=social[i].x*socialGain+Math.cos(wander)*CONFIG.wanderSpeed;
    let vy=social[i].y*socialGain+Math.sin(wander)*CONFIG.wanderSpeed;
    if(s.mood==='escape'){const urge=(s.profile.escapeForce+CONFIG.rebelBurstForce*s.burst*s.profile.intensity)*s.boldness;vx+=Math.cos(s.escapeAngle)*urge;vy+=Math.sin(s.escapeAngle)*urge;}
    vx += s.surpriseX * s.surprise * CONFIG.surpriseForce;
    vy += s.surpriseY * s.surprise * CONFIG.surpriseForce;
    for (let j = 0; j < sheep.length; j++) {
      if (i === j) continue;
      let sx = s.x - sheep[j].x, sy = s.y - sheep[j].y, d = Math.hypot(sx, sy);
      if (d < 0.001) { sx = i < j ? -1 : 1; sy = 0; d = 1; }
      const spacing = CONFIG.separation * Math.max(s.profile.separation,sheep[j].profile.separation) * (1 + CONFIG.agitationSpacing * Math.max(s.agitation, sheep[j].agitation));
      if (d < spacing) {
        const force = (1 - d / spacing) * CONFIG.separationForce * (1 + CONFIG.agitationForce * s.agitation);
        vx += sx / d * force; vy += sy / d * force;
      }
    }
    let awayX = s.x - dog.x, awayY = s.y - dog.y, dogDistance = Math.hypot(awayX, awayY);
    if (dogDistance < 0.001) { awayX = Math.cos(s.phase); awayY = Math.sin(s.phase); dogDistance = 1; }
    const proximity = clamp(1 - dogDistance / (CONFIG.dogRange*s.profile.dogRange), 0, 1);
    const fear = proximity * proximity * (3 - 2 * proximity);
    const flight = fear * CONFIG.fleeForce * s.profile.dogForce * s.temperament * (1 + CONFIG.agitationForce * s.agitation);
    vx += awayX / dogDistance * flight;
    vy += awayY / dogDistance * flight;
    // Laisser passer le chien sur le côté au lieu de seulement fuir devant lui.
    if (distance > 1) {
      const forwardX = Math.cos(dog.angle), forwardY = Math.sin(dog.angle);
      const ahead = awayX * forwardX + awayY * forwardY;
      const lateral = -awayX * forwardY + awayY * forwardX;
      if (ahead > 0 && ahead < CONFIG.anticipation && Math.abs(lateral) < CONFIG.corridor) {
        const side = Math.abs(lateral) < 0.01 ? (i % 2 ? 1 : -1) : Math.sign(lateral);
        const urgency = (1 - ahead / CONFIG.anticipation) * (1 - Math.abs(lateral) / CONFIG.corridor);
        vx -= forwardY * side * urgency * CONFIG.sidestepForce * s.temperament;
        vy += forwardX * side * urgency * CONFIG.sidestepForce * s.temperament;
      }
    }
    const fenceForce=fenceAvoidance(s);vx+=fenceForce.x;vy+=fenceForce.y;
    const edge = value => Math.pow(clamp(1 - value / CONFIG.edgeRange, 0, 1), 2) * CONFIG.edgeForce;
    vx += edge(s.x) - edge(world.width - s.x);
    vy += edge(s.y) - edge(world.height - s.y);
    const extraSpeed = s.mood === 'escape' ? (s.profile.escapeSpeed + s.profile.burstSpeed * s.burst) * s.boldness : 0;
    const maxSpeed = s.profile.speed * ((CONFIG.calmSpeed + (CONFIG.fleeSpeed - CONFIG.calmSpeed) * fear) * s.temperament * (1 + CONFIG.agitationSpeed * s.agitation) + extraSpeed) * (1 + CONFIG.surpriseSpeedGain * s.surprise);
    const speed = Math.hypot(vx, vy);
    if (speed > maxSpeed) { vx *= maxSpeed / speed; vy *= maxSpeed / speed; }
    const blend = 1 - Math.exp(-CONFIG.response * s.profile.response * dt);
    return { vx: s.vx + (vx - s.vx) * blend, vy: s.vy + (vy - s.vy) * blend };
  });
  sheep.forEach((s, i) => {
    Object.assign(s, velocities[i]);
    s.x += s.vx * dt; s.y += s.vy * dt;
    const margin = CONFIG.sheepRadius + 2;
    const x = clamp(s.x, margin, world.width - margin), y = clamp(s.y, margin, world.height - margin);
    if (x !== s.x) s.vx = 0;
    if (y !== s.y) s.vy = 0;
    s.x = x; s.y = y;
    resolveDogContact(s);
    if (Math.hypot(s.vx, s.vy) > 1) {
      const target = Math.atan2(s.vy, s.vx);
      s.angle += Math.atan2(Math.sin(target - s.angle), Math.cos(target - s.angle)) * (1 - Math.exp(-6 * s.profile.turn * dt));
    }
  });
  relaxSheepSpacing(dt);
  sheep.forEach((s,i)=>constrainMove(s,previousSheep[i],FENCE.sheepBody));
  checkVictory();
}
// Relaxation souple : corrections simultanées et bornées, sans impulsion ni rebond.
// Le dessin atteint 15 unités depuis le centre : deux moutons demandent environ 30.
function relaxSheepSpacing(dt) {
  const shifts = sheep.map(() => ({ x: 0, y: 0 }));
  const blend = 1 - Math.exp(-CONFIG.spacingResponse * dt);
  for (let i = 0; i < sheep.length; i++) {
    for (let j = i + 1; j < sheep.length; j++) {
      let dx = sheep[j].x - sheep[i].x, dy = sheep[j].y - sheep[i].y;
      let distance = Math.hypot(dx, dy);
      if (distance >= CONFIG.bodySpacing) continue;
      if (distance < 0.0001) {
        const angle = (i * 7 + j) * 2.3999632297;
        dx = Math.cos(angle); dy = Math.sin(angle); distance = 0;
      } else { dx /= distance; dy /= distance; }
      const amount = (CONFIG.bodySpacing - distance) * 0.5 * blend;
      shifts[i].x -= dx * amount; shifts[i].y -= dy * amount;
      shifts[j].x += dx * amount; shifts[j].y += dy * amount;
    }
  }
  sheep.forEach((s, i) => {
    const shift = shifts[i], length = Math.hypot(shift.x, shift.y);
    const limit = CONFIG.spacingCorrectionSpeed * dt;
    const factor = length > limit ? limit / length : 1;
    const margin = CONFIG.sheepRadius + 2;
    s.x = clamp(s.x + shift.x * factor, margin, world.width - margin);
    s.y = clamp(s.y + shift.y * factor, margin, world.height - margin);
    resolveDogContact(s); // La relaxation ne doit pas repousser un mouton dans le chien.
  });
}

// Correction géométrique minimale, sans rebond ni blocage du chien.
function resolveDogContact(s) {
  const dx = s.x - dog.x, dy = s.y - dog.y, distance = Math.hypot(dx, dy);
  const radius = CONFIG.contactDistance;
  if (distance >= radius) return;
  const angle = distance > 0.001 ? Math.atan2(dy, dx) : s.phase;
  const margin = CONFIG.sheepRadius + 2;
  const inside = (x, y) => x >= margin && x <= world.width - margin && y >= margin && y <= world.height - margin && clearOfWalls(x,y,FENCE.sheepBody);
  let x = dog.x + Math.cos(angle) * radius, y = dog.y + Math.sin(angle) * radius;
  if (!inside(x, y)) {
    // Au bord, choisir le point libre le plus proche sur le cercle de contact.
    let best = Infinity;
    for (let i = 0; i < 64; i++) {
      const a = angle + i * Math.PI * 2 / 64;
      const cx = dog.x + Math.cos(a) * radius, cy = dog.y + Math.sin(a) * radius;
      const cost = (cx - s.x) ** 2 + (cy - s.y) ** 2;
      if (inside(cx, cy) && cost < best) { x = cx; y = cy; best = cost; }
    }
  }
  s.x = x; s.y = y;
  const nx = (x - dog.x) / radius, ny = (y - dog.y) / radius;
  const inward = Math.min(0, s.vx * nx + s.vy * ny);
  s.vx -= inward * nx; s.vy -= inward * ny;
}
function ellipse(x, y, rx, ry, color) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
}
function draw() {
  ctx.setTransform(canvas.width / world.width, 0, 0, canvas.height / world.height, 0, 0);
  ctx.fillStyle = '#8fae70'; ctx.fillRect(0, 0, world.width, world.height);
  drawPen();
  // Quelques brins fixes, sans assets ni animation décorative.
  ctx.strokeStyle = 'rgba(53,93,49,.16)'; ctx.lineWidth = 1.4;
  for (let i = 0; i < 110; i++) {
    const x = ((i * 137.51 + 23) % 997) / 997 * world.width;
    const y = ((i * 83.19 + 57) % 991) / 991 * world.height;
    ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x, y); ctx.lineTo(x + 2, y - 5); ctx.stroke();
  }
  if (markerTime > 0) {
    ctx.strokeStyle = 'rgba(255,255,240,' + markerTime + ')'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(dog.tx, dog.ty, 13, 0, Math.PI * 2); ctx.stroke();
  }
  for (const s of sheep) {
    ellipse(s.x + 1, s.y + 4, 12, 8, 'rgba(35,62,32,.16)');
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.angle);
    ellipse(9, 0, 6, 5, '#53594c');
    ellipse(6, -5, 3, 2, '#53594c'); ellipse(6, 5, 3, 2, '#53594c');
    ellipse(-2, 0, 11, 9, s.profile.color);
    ellipse(-5, -2, 6, 5, s.profile.highlight);
    ctx.restore();
  }
  ellipse(dog.x + 1, dog.y + 4, 15, 9, 'rgba(35,62,32,.22)');
  ctx.save(); ctx.translate(dog.x, dog.y); ctx.rotate(dog.angle);
  ctx.strokeStyle = '#29332e'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(-19, -4); ctx.stroke();
  ellipse(-2, 0, 13, 9, '#29332e');
  ellipse(5, 0, 4, 8, '#e9e7d8');
  ellipse(11, 0, 8, 6, '#29332e');
  ellipse(8, -6, 4, 3, '#29332e'); ellipse(8, 6, 4, 3, '#29332e');
  ellipse(16, 0, 3, 3, '#b5aa8c');
  ctx.restore();
}
function frame(time) {
  if (lastTime === null) lastTime = time;
  accumulator += Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;
  while (accumulator >= CONFIG.step && mode === 'playing') { accumulator -= CONFIG.step; update(CONFIG.step); }
  if(mode !== 'playing') accumulator=0;
  if(mode !== 'home') draw();
  requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', () => { lastTime = null; accumulator = 0; if (document.hidden) stopSteering(); });
requestAnimationFrame(frame);
