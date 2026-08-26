const starterQuests = [
  { id: 1, name: 'Morning movement', note: 'Get your body moving for 20 minutes', type: 'daily', xp: 20, icon: '⚡', done: false },
  { id: 2, name: 'Mindful minute', note: 'Meditate, journal, or simply breathe', type: 'daily', xp: 10, icon: '☘', done: false },
  { id: 3, name: 'Learn something new', note: 'Spend 30 minutes sharpening your skills', type: 'daily', xp: 30, icon: '✦', done: false },
  { id: 4, name: 'Connect with someone', note: 'Call, message, or meet a person you care about', type: 'weekly', xp: 30, icon: '♥', done: false },
  { id: 5, name: 'Plan your next week', note: 'Review wins and set your intentions', type: 'weekly', xp: 50, icon: '◉', done: false }
];
let quests = JSON.parse(localStorage.getItem('levelup-quests')) || starterQuests;
let chosenIcon = '⚡';
const $ = s => document.querySelector(s);
function save(){localStorage.setItem('levelup-quests', JSON.stringify(quests))}
function render(){
  ['daily','weekly'].forEach(type=>{
    const list = $(`#${type}List`); const subset = quests.filter(q=>q.type===type);
    $(`#${type}Count`).textContent = subset.length;
    list.innerHTML = subset.map(q=>`<article class="quest ${q.done?'done':''}"><input class="check" type="checkbox" data-id="${q.id}" ${q.done?'checked':''} aria-label="Complete ${q.name}"><div class="quest-icon">${q.icon}</div><div class="quest-info"><b>${q.name}</b><small>${q.note}</small></div><span class="xp">+${q.xp} XP</span></article>`).join('');
  });
  const completed=quests.filter(q=>q.done).length,total=quests.length,xp=quests.filter(q=>q.done).reduce((sum,q)=>sum+q.xp,0);
  $('#doneCount').textContent=completed; $('#totalCount').textContent=total; $('#xpTotal').textContent=xp; $('#progressFill').style.width=total?`${completed/total*100}%`:'0%';
  $('#motivator').textContent=completed===total&&total?'All quests conquered — you are on fire!':completed?'Momentum looks good. Keep going!':'Every small win gets you closer to legendary.';
}
document.addEventListener('change',e=>{if(!e.target.matches('.check'))return;const q=quests.find(x=>x.id===+e.target.dataset.id);q.done=e.target.checked;save();render();if(q.done){$('#toastText').textContent=`+${q.xp} XP earned for ${q.name}`;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),3000)}});
$('#openModal').onclick=()=>$('#questModal').showModal();
$('#iconPicker').onclick=e=>{if(e.target.tagName!=='BUTTON')return;chosenIcon=e.target.textContent;document.querySelectorAll('#iconPicker button').forEach(b=>b.classList.toggle('chosen',b===e.target))};
$('#questForm').addEventListener('submit',e=>{if(e.submitter?.value==='cancel')return;e.preventDefault();const name=$('#questName').value.trim();if(!name)return;quests.push({id:Date.now(),name,note:'A new step toward your best self',type:$('#questType').value,xp:+$('#questXp').value,icon:chosenIcon,done:false});save();render();e.target.reset();$('#questModal').close()});
const today=new Date();$('#dateLabel').textContent=today.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase();render();
