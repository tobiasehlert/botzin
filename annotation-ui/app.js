const canvas = document.querySelector('#canvas');
const ctx = canvas.getContext('2d');
const $ = selector => document.querySelector(selector);
const colors = ['#2474ff','#ffb020','#f4e24b','#18d7be','#b68cff','#ff5e7a','#54c7ec','#ff4057','#438cff','#d46cff','#ff8a3d','#a4dc55','#ffffff','#a052e0','#777777','#f0a040'];

let meta;
let index = 0;
let image = new Image();
let boxes = [];
let selected = -1;
let activeClass = 0;
let drawing = null;
let resizing = null;
let suggestions = [];
let analysisToken = 0;
let waitingForClass = false;
let reviewedIndices = new Set();
let zoom = 1;
let fittedWidth = 0;
let fittedHeight = 0;
let mixedMode = true;
let mixedAssetCount = 0;
let mixedAssetTarget = 10 + Math.floor(Math.random()*11);
let realCursor = 0;
let originalCursor = 0;
const clamp = n => Math.max(0, Math.min(1, n));

function chooseClass(id) {
  activeClass = id;
  document.querySelectorAll('.class-btn').forEach(button => button.classList.toggle('active', +button.dataset.id === id));
  $('#itemCategory').disabled = id !== 2;
  $('#itemCategoryWrap').classList.toggle('enabled', id === 2);
  if (waitingForClass && suggestions[0]) {
    waitingForClass = false;
    answerCurrent('reclassify');
  }
}

function applyClass() {
  if (selected < 0) return;
  boxes[selected].classId = activeClass;
  if (activeClass === 2) boxes[selected].itemCategory = $('#itemCategory').value || undefined;
  else delete boxes[selected].itemCategory;
  draw();
  renderList();
  toast('Classe aplicada à caixa');
}

async function init() {
  meta = await fetch('/api/meta').then(response => response.json());
  reviewedIndices = new Set(meta.reviewedIndices ?? []);
  $('#classes').innerHTML = meta.classes.map((name, id) => `<button class="class-btn ${id === 0 ? 'active' : ''}" data-id="${id}"><span class="swatch" style="background:${colors[id]}"></span>${id + 1}. ${name}</button>`).join('');
  document.querySelectorAll('.class-btn').forEach(button => button.onclick = () => chooseClass(+button.dataset.id));
  const itemNames = {weapon:'Arma',shield:'Escudo',helmet:'Capacete',armor:'Armadura',legs:'Calças',boots:'Botas',amulet:'Amuleto',ring:'Anel',ammunition:'Munição',container:'Recipiente / mochila',consumable:'Consumível',rune:'Runa',tool:'Ferramenta',loot:'Loot / valioso',decoration:'Decoração',quest:'Item de quest',other:'Outro item'};
  $('#itemCategory').innerHTML = '<option value="">Sem categoria</option>' + meta.itemCategories.map(category => `<option value="${category}">${itemNames[category] ?? category}</option>`).join('');
  $('#itemCategory').onchange = () => {
    if (selected >= 0 && boxes[selected].classId === 2) {
      boxes[selected].itemCategory = $('#itemCategory').value || undefined;
      draw(); renderList();
    }
  };
  $('#applyClass').onclick = applyClass;
  originalCursor = meta.visualTotal;
  await load(nextMixed());
}

function nextUnreviewed(start, direction = 1) {
  let candidate = Math.max(0, Math.min(meta.total - 1, start));
  while (candidate >= 0 && candidate < meta.total && reviewedIndices.has(candidate)) candidate += direction;
  return candidate >= 0 && candidate < meta.total ? candidate : -1;
}

function nextInRange(start, minimum, maximum) {
  let candidate=Math.max(start,minimum);
  while(candidate<maximum&&reviewedIndices.has(candidate))candidate++;
  return candidate<maximum?candidate:-1;
}

function randomUnreviewed(minimum, maximum) {
  const available=[];
  for(let candidate=minimum;candidate<maximum;candidate++)if(!reviewedIndices.has(candidate))available.push(candidate);
  return available.length?available[Math.floor(Math.random()*available.length)]:-1;
}

function nextMixed() {
  if(mixedAssetCount<mixedAssetTarget){
    const asset=randomUnreviewed(meta.visualTotal,meta.total);
    if(asset>=0){originalCursor=asset+1;mixedAssetCount++;return asset;}
  }
  const real=nextInRange(realCursor,0,meta.visualTotal);
  if(real>=0){realCursor=real+1;mixedAssetCount=0;mixedAssetTarget=10+Math.floor(Math.random()*11);return real;}
  return randomUnreviewed(meta.visualTotal,meta.total);
}


async function load(next, direction = 1) {
  next = nextUnreviewed(next, direction);
  if (next < 0) { toast('Não há outro frame novo nessa direção'); return; }
  const token = ++analysisToken;
  index = Math.max(0, Math.min(meta.total - 1, next));
  const data = await fetch(`/api/frames/${index}`).then(response => response.json());
  boxes = data.annotation?.boxes ?? [];
  suggestions = [];
  updateAiStatus('Aguardando imagem…');
  $('#ignored').checked = data.annotation?.ignored ?? false;
  selectBox(-1);
  image.onload = () => {
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; $('#empty').hidden = true;
    const wrap = canvas.parentElement;
    const scale = Math.min(wrap.clientWidth / canvas.width, wrap.clientHeight / canvas.height, 1);
    fittedWidth = Math.floor(canvas.width * scale); fittedHeight = Math.floor(canvas.height * scale);
    setZoom(1); draw();
    if ($('#aiEnabled').checked) analyzeFrame(token);
    else updateAiStatus('Análise desativada');
  };
  image.src = data.imageUrl;
  $('#progress').textContent = `${index + 1} / ${meta.total}`;
  const isOriginal=index>=meta.visualTotal;
  $('#sourceKind').textContent=isOriginal?'Fonte: sprite original do Tibia':'Fonte: frame real';
  $('#mixedStatus').textContent=`Fila mista · ${mixedAssetCount}/${mixedAssetTarget} originais antes do próximo frame real`;
  $('#saved').textContent = `${meta.reviewed} revisados`;
  renderList();
}

function pixelBox(box) {
  return {x:(box.x-box.width/2)*canvas.width, y:(box.y-box.height/2)*canvas.height, w:box.width*canvas.width, h:box.height*canvas.height};
}

function draw() {
  if (!image.complete || !image.naturalWidth) return;
  ctx.drawImage(image, 0, 0);
  if ($('#cleanView')?.checked) return;
  boxes.forEach((box, id) => {
    const {x,y,w,h} = pixelBox(box);
    ctx.strokeStyle = colors[box.classId]; ctx.lineWidth = id === selected ? 4 : 2; ctx.strokeRect(x,y,w,h);
    if (id === selected) {
      for (const [hx,hy] of [[x,y],[x+w,y],[x,y+h],[x+w,y+h]]) {
        ctx.fillStyle = '#fff'; ctx.fillRect(hx-6,hy-6,12,12); ctx.strokeStyle = colors[box.classId]; ctx.lineWidth = 2; ctx.strokeRect(hx-6,hy-6,12,12);
      }
    }
  });
  suggestions.forEach((box, suggestionId) => {
    const {x,y,w,h} = pixelBox(box);
    if (suggestionId !== 0) {
      ctx.save(); ctx.globalAlpha = .22; ctx.strokeStyle = colors[box.classId]; ctx.lineWidth = 2; ctx.setLineDash([7,7]); ctx.strokeRect(x,y,w,h); ctx.restore();
      return;
    }
    ctx.fillStyle = 'rgba(255, 214, 64, .24)'; ctx.fillRect(x,y,w,h);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 8; ctx.setLineDash([13,7]); ctx.strokeRect(x,y,w,h);
    ctx.strokeStyle = colors[box.classId]; ctx.lineWidth = 4; ctx.setLineDash([13,7]); ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
    const label = `PERGUNTA ATUAL · ${meta.classes[box.classId]} · ${Math.round(box.confidence*100)}%`;
    ctx.font = 'bold 17px Segoe UI';
    const labelWidth = ctx.measureText(label).width + 12;
    const labelY = y > 30 ? y - 29 : y + 3;
    ctx.fillStyle = '#050608'; ctx.fillRect(x,labelY,labelWidth,25);
    ctx.strokeStyle = '#ffd640'; ctx.lineWidth = 2; ctx.strokeRect(x,labelY,labelWidth,25);
    ctx.fillStyle = '#ffd640'; ctx.fillText(label,x+6,labelY+18);
  });
  if (drawing) {
    ctx.strokeStyle = colors[activeClass]; ctx.lineWidth = 2; ctx.setLineDash([7,5]);
    ctx.strokeRect(drawing.x,drawing.y,drawing.w,drawing.h); ctx.setLineDash([]);
  }
}

function point(event) {
  const rect = canvas.getBoundingClientRect();
  return {x:(event.clientX-rect.left)*canvas.width/rect.width, y:(event.clientY-rect.top)*canvas.height/rect.height};
}

function setZoom(value) {
  zoom = Math.max(.5, Math.min(4, value));
  canvas.style.width = `${fittedWidth * zoom}px`;
  canvas.style.height = `${fittedHeight * zoom}px`;
  $('#zoomValue').textContent = `${Math.round(zoom * 100)}%`;
}

function cornerAt(p) {
  if (selected < 0) return null;
  const {x,y,w,h} = pixelBox(boxes[selected]);
  const corners = [{name:'nw',x,y,ax:x+w,ay:y+h},{name:'ne',x:x+w,y,ax:x,ay:y+h},{name:'sw',x,y:y+h,ax:x+w,ay:y},{name:'se',x:x+w,y:y+h,ax:x,ay:y}];
  return corners.find(corner => Math.abs(p.x-corner.x) <= 12 && Math.abs(p.y-corner.y) <= 12) ?? null;
}

function selectBox(id) {
  selected = id;
  $('#applyClass').disabled = id < 0;
  if (id >= 0 && boxes[id].classId === 2) $('#itemCategory').value = boxes[id].itemCategory ?? '';
  draw(); renderList();
}

canvas.onpointerdown = event => {
  const p = point(event);
  const corner = cornerAt(p);
  if (corner) {
    resizing = {ax:corner.ax, ay:corner.ay};
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  const reverse = [...boxes].reverse().findIndex(box => { const b=pixelBox(box); return p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h; });
  if (reverse >= 0) selectBox(boxes.length - 1 - reverse);
  else {
    const suggestionIndex = [...suggestions].reverse().findIndex(box => { const b=pixelBox(box); return p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h; });
    if (suggestionIndex >= 0) acceptSuggestion(suggestions.length - 1 - suggestionIndex);
    else { selectBox(-1); drawing = {x:p.x,y:p.y,w:0,h:0}; canvas.setPointerCapture(event.pointerId); }
  }
};

canvas.onpointermove = event => {
  const p = point(event);
  if (resizing) {
    const left=Math.min(resizing.ax,p.x), top=Math.min(resizing.ay,p.y), right=Math.max(resizing.ax,p.x), bottom=Math.max(resizing.ay,p.y);
    if (right-left >= 6 && bottom-top >= 6) boxes[selected] = {...boxes[selected],x:clamp((left+right)/2/canvas.width),y:clamp((top+bottom)/2/canvas.height),width:clamp((right-left)/canvas.width),height:clamp((bottom-top)/canvas.height)};
    draw(); return;
  }
  if (!drawing) return;
  drawing.w=p.x-drawing.x; drawing.h=p.y-drawing.y; draw();
};

canvas.onpointerup = () => {
  if (resizing) { resizing=null; draw(); renderList(); return; }
  if (!drawing) return;
  let {x,y,w,h}=drawing;
  if (w<0) {x+=w;w=-w} if (h<0) {y+=h;h=-h}
  if (w>5&&h>5) {
    boxes.push({classId:activeClass,itemCategory:activeClass===2?($('#itemCategory').value||undefined):undefined,x:clamp((x+w/2)/canvas.width),y:clamp((y+h/2)/canvas.height),width:clamp(w/canvas.width),height:clamp(h/canvas.height)});
    selected=boxes.length-1;
  }
  drawing=null; selectBox(selected);
};

function renderList() {
  $('#boxCount').textContent=boxes.length;
  $('#boxList').innerHTML=boxes.map((box,id)=>`<div class="box-row ${id===selected?'active':''}" data-id="${id}"><span style="color:${colors[box.classId]}">${meta.classes[box.classId]}${box.itemCategory?` · ${box.itemCategory}`:''}</span><button data-remove="${id}">×</button></div>`).join('');
  document.querySelectorAll('.box-row').forEach(row => row.onclick = event => {
    if (event.target.dataset.remove !== undefined) { boxes.splice(+event.target.dataset.remove,1); selectBox(-1); }
    else selectBox(+row.dataset.id);
  });
}

function updateAiStatus(message) {
  $('#aiStatus').textContent = message;
  $('#acceptSuggestions').disabled = suggestions.length === 0;
  $('#clearSuggestions').disabled = suggestions.length === 0;
  const current = suggestions[0];
  $('#activeQuestion').hidden = !current;
  if (current) $('#questionText').textContent = waitingForClass
    ? 'Agora clique na classe correta na lista acima.'
    : current.entityName
      ? `Nome oficial: “${current.entityName}”. Esta identificação está correta?`
      : `A IA marcou “${meta.classes[current.classId]}” com ${Math.round(current.confidence*100)}% de confiança. Está correto?`;
}

async function analyzeFrame(token = analysisToken) {
  suggestions = [];
  updateAiStatus('IA analisando…');
  draw();
  try {
    const response = await fetch(`/api/predictions/${index}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Falha na análise');
    if (token !== analysisToken || !$('#aiEnabled').checked) return;
    suggestions = data.suggestions ?? [];
    updateAiStatus(`${suggestions.length} sugestão(ões) encontrada(s)`);
    draw();
  } catch (error) {
    if (token === analysisToken) updateAiStatus(`Erro: ${error.message}`);
  }
}

function acceptSuggestion(id) {
  const suggestion = suggestions.splice(id, 1)[0];
  if (!suggestion) return;
  const {confidence, ...box} = suggestion;
  boxes.push(box); selected = boxes.length - 1;
  recordFeedback('correct', suggestion);
  updateAiStatus(`${suggestions.length} sugestão(ões) restante(s)`);
  selectBox(selected);
}

async function recordFeedback(action, suggestion = suggestions[0], comment = '') {
  if (!suggestion && !comment) return;
  await fetch(`/api/feedback/${index}`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action, suggestion, correctedClassId:action==='reclassify'?activeClass:undefined, comment})});
}

function answerCurrent(action) {
  const suggestion = suggestions[0];
  if (!suggestion) return;
  if (action === 'wrong' || action === 'unsure') {
    recordFeedback(action, suggestion, $('#feedbackText').value.trim());
    suggestions.shift();
  } else {
    const {confidence, ...box} = suggestion;
    if (action === 'reclassify') box.classId = activeClass;
    boxes.push(box); selected = boxes.length - 1;
    recordFeedback(action, suggestion, $('#feedbackText').value.trim());
    suggestions.shift();
    if (action === 'adjust') toast('Agora arraste os cantos da caixa');
  }
  $('#feedbackText').value = '';
  waitingForClass = false;
  updateAiStatus(`${suggestions.length} pergunta(s) restante(s)`);
  selectBox(selected);
}

function acceptAllSuggestions() {
  boxes.push(...suggestions.map(({confidence, ...box}) => box));
  suggestions = [];
  selected = boxes.length ? boxes.length - 1 : -1;
  updateAiStatus('Todas as sugestões foram aceitas');
  selectBox(selected);
}

async function save(advance=true) {
  const response = await fetch(`/api/frames/${index}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({width:canvas.width,height:canvas.height,ignored:$('#ignored').checked,boxes})});
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    toast(`Falha ao salvar: ${failure.error ?? response.status}`);
    return;
  }
  if (!reviewedIndices.has(index)) { reviewedIndices.add(index); meta.reviewed++; }
  toast('Anotação salva'); if (advance) await load(mixedMode?nextMixed():index+1, 1);
}
async function refreshTrainingStatus() {
  try {
    const state = await fetch('/api/training/status').then(response=>response.json());
    $('#trainingStatus').textContent = state.active
      ? `Aprendizado contínuo: treinando${state.pending?' · há novos frames na fila':''}`
      : state.error ? 'Aprendizado contínuo: ocorreu um erro' : `Aprendizado contínuo: pronto · versão ${state.version}`;
  } catch { $('#trainingStatus').textContent = 'Aprendizado contínuo: sem conexão'; }
}
function toast(message) { $('#toast').textContent=message; $('#toast').classList.add('show'); setTimeout(()=>$('#toast').classList.remove('show'),1200); }

$('#prev').onclick=()=>load(index-1,-1); $('#next').onclick=()=>load(index+1,1); $('#save').onclick=()=>save();
$('#clear').onclick=()=>{boxes=[];selectBox(-1)};
$('#acceptSuggestions').onclick=acceptAllSuggestions;
$('#clearSuggestions').onclick=()=>{suggestions=[];updateAiStatus('Sugestões ocultadas');draw()};
$('#aiEnabled').onchange=()=>{if($('#aiEnabled').checked)analyzeFrame();else{suggestions=[];updateAiStatus('Análise desativada');draw()}};
$('#answerCorrect').onclick=()=>answerCurrent('correct');
$('#answerReclassify').onclick=()=>{waitingForClass=true;updateAiStatus('Escolha a classe correta na lista acima');toast('Clique agora na classe correta')};
$('#answerAdjust').onclick=()=>answerCurrent('adjust');
$('#answerUnsure').onclick=()=>answerCurrent('unsure');
$('#answerWrong').onclick=()=>answerCurrent('wrong');
$('#sendFeedback').onclick=async()=>{const comment=$('#feedbackText').value.trim();if(!comment)return;await recordFeedback('comment',suggestions[0],comment);$('#feedbackText').value='';toast('Comentário registrado')};
$('#cleanView').onchange=()=>{draw();toast($('#cleanView').checked?'Imagem limpa ativada':'Caixas exibidas novamente')};
$('#zoomIn').onclick=()=>setZoom(zoom+.25);
$('#zoomOut').onclick=()=>setZoom(zoom-.25);
$('#zoomReset').onclick=()=>setZoom(1);
$('#reviewMixed').onclick=()=>{mixedMode=true;load(nextMixed(),1)};
canvas.parentElement.addEventListener('wheel',event=>{if(!event.ctrlKey)return;event.preventDefault();setZoom(zoom+(event.deltaY<0?.25:-.25))},{passive:false});
document.onkeydown=event=>{if(event.target.closest('input, textarea, select'))return;if(event.key==='Delete'&&selected>=0){boxes.splice(selected,1);selectBox(-1)}if(event.key==='Enter')save();if(/^[1-9]$/.test(event.key))document.querySelector(`[data-id="${+event.key-1}"]`)?.click()};
init();
refreshTrainingStatus(); setInterval(refreshTrainingStatus, 5000);
