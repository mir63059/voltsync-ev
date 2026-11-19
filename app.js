/* RideaseVX — demo mode + Supabase v2 integration */
'use strict';

// Browser-safe Supabase configuration. Set SUPABASE_URL here or enter it in the gear modal.
const SUPABASE_URL = 'https://atucbucsqqtadfgzowiy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_2ShhTVhq7BKaEezETih2jg_xbTa3ggf';
const AUTH_REDIRECT_URL = 'https://mir63059.github.io/voltsync-ev/';
const isPrivateIPv4 = (hostname) => {
  const parts=hostname.split('.');
  if(parts.length!==4||parts.some(part=>!/^\d+$/.test(part)))return false;
  const octets=parts.map(Number);
  if(octets.some(octet=>octet<0||octet>255))return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
};
const isPrivateIPv6 = (hostname) => {
  const firstSegment=hostname.replace(/^\[|\]$/g,'').toLowerCase().split(':')[0];
  return /^(fc|fd)/.test(firstSegment)||/^fe[89ab]/.test(firstSegment);
};
const isLocalDevelopment = ['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname)
  || location.hostname.endsWith('.local')
  || isPrivateIPv4(location.hostname)
  || isPrivateIPv6(location.hostname);
const SIMULATED_POWER_KW = 5.4;
const SIMULATION_INTERVAL_MS = 200;

// Never place a Supabase secret/service-role key in this file.

const DEMO_USERS = [
  { id:'demo-1', full_name:'Ali Khan', initials:'AK', wallet_balance:2500, total_sessions:4 },
  { id:'demo-2', full_name:'Sara Ahmed', initials:'SA', wallet_balance:1800, total_sessions:2 },
  { id:'demo-3', full_name:'Usman Tariq', initials:'UT', wallet_balance:3200, total_sessions:6 }
];

const state = {
  supabase:null, configured:false, mode:'split', activeUserId:'demo-1', selectedChargerId:'CHG-001',
  tariff:65, users:structuredClone(DEMO_USERS), chargers:[], sessions:[], transactions:[],
  charging:false, startedAt:null, timer:null, tick:null, activeSessionId:null,
  lastBilledAmount:0, sessionBudget:0, sessionUnitRate:0,
  sessionStartingBatteryPct:0,
  session: null,
  profile: null,
  authMode: 'login',
  isAdmin: false,
  demoMode: true,
  qrScanner: null,
  currentQrId: null,
  realtimeChannel: null
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('en-PK',{maximumFractionDigits:2});
const fmtEnergy = (n) => Number(n || 0).toLocaleString('en-PK',{minimumFractionDigits:3,maximumFractionDigits:3});
const roundMoney = (amount) => Math.round((Number(amount) + Number.EPSILON) * 100) / 100;
let deferredInstallPrompt = null;
const toast = (message, type='success') => {
  const el=document.createElement('div'); el.className=`fade-in px-4 py-3 rounded-xl text-xs font-semibold border shadow-xl ${type==='error'?'bg-red-950 border-red-700 text-red-300':'bg-slate-900 border-emerald-500/30 text-emerald-300'}`;
  el.textContent=message; $('toast').appendChild(el); setTimeout(()=>el.remove(),3500);
};
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  const button = $('install-app');
  if (button) {
    button.textContent = 'Install App';
    button.classList.remove('hidden');
    $('install-help').classList.add('hidden');
  }
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  $('install-app')?.classList.add('hidden');
  $('install-help')?.classList.add('hidden');
});
const consoleLog=(packet,type='IN')=>{
  const el=document.createElement('div'); const time=new Date().toLocaleTimeString('en-PK');
  el.innerHTML=`<span class="text-slate-500">${time}</span> <span class="${type==='OUT'?'text-amber-400':'text-emerald-400'}">${type}</span> <span class="text-slate-300">${typeof packet==='string'?packet:JSON.stringify(packet)}</span>`;
  $('console').prepend(el);
};

function seedDemo(){
  state.chargers=[
    {id:'CHG-001',name:'Main Gate Fast Charger',location:'Karachi Station 1',status:'online',voltage:0,current:0,current_kwh:0,battery_pct:42,active_user_id:null},
    {id:'CHG-002',name:'Shopping Mall Charger',location:'Karachi Station 2',status:'online',voltage:0,current:0,current_kwh:0,battery_pct:68,active_user_id:null},
    {id:'CHG-003',name:'Airport Express Charger',location:'Karachi Station 3',status:'offline',voltage:0,current:0,current_kwh:0,battery_pct:50,active_user_id:null}
  ];
  state.sessions=[];
}

async function init(){
  seedDemo(); bindUI();
  const savedUrl=(localStorage.getItem('voltsync_url')||'').trim();
  const savedKey=(localStorage.getItem('voltsync_key')||'').trim();
  const hasSavedConfig=Boolean(savedUrl&&savedKey);
  const url=hasSavedConfig?savedUrl:SUPABASE_URL;
  const key=hasSavedConfig?savedKey:SUPABASE_ANON_KEY;
  $('supabase-url').value=url; $('supabase-key').value=key;
  localStorage.setItem('voltsync_url',url); localStorage.setItem('voltsync_key',key);
  await connectSupabase(url,key,false);
  setInterval(updateClock,1000); updateClock();
}

function setDemoMode(){
  state.configured=false; state.supabase=null;
  $('backend-status').textContent='Local Demo'; $('backend-status').className='text-xs font-mono text-amber-400'; $('backend-dot').className='relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400 status-dot';
  renderAll(); consoleLog({mode:'demo',broker:'simulation',status:'connected'} ,'IN');
}

async function connectSupabase(url,key,notify=true){
  try{
    if(!window.supabase) throw new Error('Supabase library failed to load');
    state.supabase=window.supabase.createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true}});
    state.configured=true; localStorage.setItem('voltsync_url',url); localStorage.setItem('voltsync_key',key);
    $('backend-status').textContent='Supabase + Realtime'; $('backend-status').className='text-xs font-mono text-emerald-400'; $('backend-dot').className='relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 status-dot';
    await loadSupabaseData(); subscribeRealtime();
    if(notify){ toast('Connected to Supabase'); $('config-modal').classList.add('hidden'); }
  }catch(error){ toast(error.message,'error'); setDemoMode(); }
}

async function loadSupabaseData(){
  if(!state.configured) return;
  const sb=state.supabase;
  const profilesRequest = state.session
    ? sb.from('profiles').select('*').order('full_name')
    : Promise.resolve({data:[],error:null});
  const sessionsRequest = state.session
    ? sb.from('sessions').select('*').order('started_at',{ascending:false}).limit(500)
    : Promise.resolve({data:[],error:null});
  const [chargers,settings,profiles,sessions] = await Promise.all([
    sb.from('stations').select('*').order('id'),
    sb.from('system_settings').select('*').eq('id',1).maybeSingle(),
    profilesRequest,
    sessionsRequest
  ]);
  if(chargers.error||settings.error||profiles.error||sessions.error) throw chargers.error||settings.error||profiles.error||sessions.error;
  if(chargers.data?.length) state.chargers=chargers.data;
  if(settings.data) state.tariff=Number(settings.data.unit_rate_pkr);
  if(profiles.data?.length) state.users=profiles.data;
  state.sessions=sessions.data||[];
  renderAll();
}

function subscribeRealtime(){
  if(!state.configured) return;
  state.supabase.channel('voltsync-live')
    .on('postgres_changes',{event:'*',schema:'public',table:'stations'},payload=>{ upsertRealtime('stations',payload); consoleLog({table:'stations',event:payload.eventType,row:payload.new||payload.old},'IN'); })
    .on('postgres_changes',{event:'*',schema:'public',table:'sessions'},payload=>{ upsertRealtime('sessions',payload); consoleLog({table:'sessions',event:payload.eventType,row:payload.new||payload.old},'IN'); })
    .on('postgres_changes',{event:'*',schema:'public',table:'profiles'},payload=>{ upsertRealtime('profiles',payload); renderAll(); })
    .on('postgres_changes',{event:'*',schema:'public',table:'system_settings'},payload=>{ if(payload.new?.unit_rate_pkr) state.tariff=Number(payload.new.unit_rate_pkr); renderAll(); consoleLog({table:'system_settings',unit_rate_pkr:payload.new?.unit_rate_pkr},'IN'); })
    .subscribe(status=>consoleLog({channel:'voltsync-live',status},'IN'));
}

function upsertRealtime(table,payload){
  if(table==='stations'){
    if(payload.eventType==='DELETE') state.chargers=state.chargers.filter(x=>x.id!==payload.old.id);
    else { const i=state.chargers.findIndex(x=>x.id===payload.new.id); i>=0?state.chargers[i]=payload.new:state.chargers.push(payload.new); }
  }
  if(table==='sessions'){
    if(payload.eventType==='INSERT') state.sessions.unshift(payload.new);
    else { const i=state.sessions.findIndex(x=>x.id===payload.new.id); if(i>=0) state.sessions[i]=payload.new; }
  }
  renderAll();
}

function bindUI(){
  document.querySelectorAll('.mode-btn').forEach(btn=>btn.addEventListener('click',()=>setViewMode(btn.dataset.mode)));
  document.querySelectorAll('.mobile-nav-btn').forEach(btn=>btn.addEventListener('click',()=>switchMobileTab(btn.dataset.tab)));
  $('open-config').onclick=()=>{ $('config-modal').classList.remove('hidden'); $('config-modal').classList.add('grid'); };
  $('close-config').onclick=()=>{ $('config-modal').classList.add('hidden'); $('config-modal').classList.remove('grid'); };
  $('save-config').onclick=()=>{ const url=$('supabase-url').value.trim(); const key=$('supabase-key').value.trim(); if(!url||!key) return toast('URL and anon key are required','error'); connectProductionSupabase(url,key); };
  $('clear-config').onclick=()=>{ localStorage.removeItem('voltsync_url'); localStorage.removeItem('voltsync_key'); $('supabase-url').value=''; $('supabase-key').value=''; $('config-modal').classList.add('hidden'); $('config-modal').classList.remove('grid'); setDemoMode(); };
  $('topup').onclick=topUp;
  $('toggle-charge').onclick=toggleCharging;
  $('budget-select').onchange=()=>{
    const isCustom=$('budget-select').value==='custom';
    $('custom-budget-wrap').classList.toggle('hidden',!isCustom);
    if(!isCustom)$('custom-budget').value='';
    updateBudgetHint();
  };
  $('custom-budget').oninput=updateBudgetHint;
  $('change-charger').onclick=()=>switchMobileTab('scan');
  $('update-tariff').onclick=updateTariff;
  $('add-charger').onclick=addCharger;
  $('clear-console').onclick=()=>{$('console').innerHTML='';};
}

function setViewMode(mode){
  state.mode=mode; document.querySelectorAll('.mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  $('workspace').className=mode==='mobile'?'grid grid-cols-1 lg:grid-cols-12 gap-6':mode==='admin'?'grid grid-cols-1 gap-6':'grid grid-cols-1 lg:grid-cols-12 gap-6';
  $('mobile-panel').className=mode==='admin'?'hidden':'lg:col-span-4 flex justify-center';
  $('admin-panel').className=mode==='mobile'?'hidden':'lg:col-span-8 space-y-5';
}

function switchMobileTab(tab){
  document.querySelectorAll('.mobile-tab').forEach(el=>el.classList.add('hidden')); $('tab-'+tab).classList.remove('hidden');
  document.querySelectorAll('.mobile-nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
}

function switchUser(id){
  state.activeUserId=id; const user=getActiveUser(); $('user-avatar').textContent=user.initials||String(user.full_name||'U').split(' ').map(x=>x[0]).join('').slice(0,2).toUpper();
  renderWallet(); renderHistory();
}

function getActiveUser(){
  return state.users.find(u=>u.id===state.activeUserId)||state.users.find(u=>u.full_name?.startsWith('Ali'))||state.users[0]||DEMO_USERS[0];
}

function renderAll(){ renderChargerList(); renderAdmin(); renderWallet(); renderMeter(); renderHistory(); }

function renderWallet(){ const u=getActiveUser(); $('wallet').textContent='Rs. '+fmt(u?.wallet_balance||0); updateBudgetHint(); }

function readBudgetAmount(){
  const selected=$('budget-select').value;
  if(!selected)return null;
  const raw=selected==='custom' ? $('custom-budget').value : selected;
  if(raw==='')return null;
  const amount=Number(raw);
  if(!Number.isFinite(amount)||amount<0.01||Math.abs(amount*100-Math.round(amount*100))>0.000001)return null;
  return roundMoney(amount);
}

function updateBudgetHint(){
  const user=getActiveUser();
  const balance=roundMoney(Number(user?.wallet_balance||0));
  const budget=readBudgetAmount();
  $('budget-wallet').textContent=`Available: Rs. ${fmt(balance)}`;
  if(!budget){
    $('budget-help').textContent=$('budget-select').value==='custom'?'Enter a valid amount of at least Rs. 0.01.':'Choose a budget before starting.';
    return;
  }
  if(budget>balance){
    $('budget-help').textContent='Budget exceeds your current wallet balance.';
    return;
  }
  const rate=Number(state.tariff);
  $('budget-help').textContent=rate>0
    ? `Cap: Rs. ${fmt(budget)} • about ${fmtEnergy(budget/rate)} kWh at Rs. ${fmt(rate)}/kWh`
    : `Cap: Rs. ${fmt(budget)}`;
}

async function topUp(){
  const user=getActiveUser(); if(!user) return;
  if(state.configured){
    return toast('Wallet top-ups require a verified payment provider and are unavailable right now','error');
  }else{ user.wallet_balance=Number(user.wallet_balance||0)+1000; renderWallet(); }
  toast('Rs. 1,000 added to wallet'); consoleLog({command:'WALLET_TOPUP',user_id:state.activeUserId,amount_pkr:1000},'OUT');
}

function renderChargerList(){
  $('charger-list').innerHTML=state.chargers.map(c=>{
    const status=c.status==='charging'?'Charging':c.status==='offline'?'Offline':c.status==='disabled'?'Disabled':'Available';
    const color=c.status==='charging'?'text-emerald-400':c.status==='offline'||c.status==='disabled'?'text-slate-500':'text-cyan-400';
    return `<button data-charge-id="${c.id}" class="charger-row w-full text-left bg-slate-900/90 border border-slate-800 hover:border-emerald-500/40 rounded-xl p-3 flex justify-between items-center ${c.status==='offline'||c.status==='disabled'?'opacity-60':''}"><div><div class="flex gap-2"><span class="font-mono text-xs font-bold text-emerald-400">${c.id}</span><span class="text-[10px] ${color}">${status}</span></div><div class="text-xs font-semibold mt-1">${c.name}</div><div class="text-[10px] text-slate-400">${c.location} • ${fmt(state.tariff)} PKR/kWh</div></div><span class="text-slate-500">›</span></button>`;
  }).join('')||'<p class="text-xs text-slate-500">No chargers configured</p>';
  document.querySelectorAll('.charger-row').forEach(btn=>btn.onclick=()=>selectCharger(btn.dataset.chargeId));
}

function selectCharger(id){
  if(state.charging)return toast('Stop the active session before changing chargers','error');
  const c=state.chargers.find(x=>x.id===id); if(!c)return;
  if(c.status==='offline'||c.status==='disabled') return toast('This charger is not available','error');
  state.selectedChargerId=id; $('app-charger-code').textContent=c.id; $('app-charger-name').textContent=c.name; $('app-charger-loc').textContent=`${c.location} • ${fmt(state.tariff)} PKR/kWh`; switchMobileTab('charge');
}

async function toggleCharging(){
  const c=state.chargers.find(x=>x.id===state.selectedChargerId); if(!c)return;
  if(!state.charging){
    if(!isLocalDevelopment)return toast('Charging is unavailable outside a local development network until trusted device telemetry is connected','error');
    if(c.status==='offline'||c.status==='disabled') return toast('Charger unavailable','error');
    const user=getActiveUser();
    const budget=readBudgetAmount();
    const balance=roundMoney(Number(user?.wallet_balance||0));
    const rate=Number(state.tariff);
    if(!budget)return toast('Choose a valid charging budget first','error');
    if(!Number.isFinite(rate)||rate<=0)return toast('Charging tariff is unavailable','error');
    if(balance<=0||balance<rate)return toast('Charging stopped: Insufficient wallet balance','error');
    if(budget>balance)return toast('Budget exceeds your current wallet balance','error');
    state.charging=true; state.startedAt=Date.now();
    state.sessionBudget=budget; state.sessionUnitRate=rate; state.lastBilledAmount=0;
    state.sessionStartingBatteryPct=Number(c.battery_pct||0);
    c.current_kwh=0;
    c.status='charging'; c.active_user_id=state.activeUserId;
    $('budget-select').disabled=true; $('custom-budget').disabled=true;
    $('toggle-charge').textContent='■ STOP CHARGING'; $('toggle-charge').className='min-h-11 w-full rounded-2xl bg-red-500 py-3.5 text-sm font-bold text-white hover:bg-red-400'; $('meter-box').classList.add('charging-glow','border-emerald-500/50');
    consoleLog({command:'START',charger_id:c.id,user_id:state.activeUserId,budget_pkr:budget},'OUT'); startTelemetry(); renderMeter();
  }else{ await stopCharging('User stopped session'); }
}

function getSessionProgress(elapsedSeconds){
  const budgetKwh=state.sessionBudget/state.sessionUnitRate;
  const rawKwh=Math.max(0,elapsedSeconds)*SIMULATED_POWER_KW/3600;
  let energyKwh=Math.min(rawKwh,budgetKwh);
  let billPkr=Math.min(state.sessionBudget,roundMoney(energyKwh*state.sessionUnitRate));
  const reachedBudget=rawKwh>=budgetKwh||billPkr>=state.sessionBudget;
  if(reachedBudget){
    energyKwh=budgetKwh;
    billPkr=state.sessionBudget;
  }
  return {energyKwh,billPkr,reachedBudget};
}

function startTelemetry(){
  clearInterval(state.tick);
  state.tick=setInterval(()=>{
    const c=state.chargers.find(x=>x.id===state.selectedChargerId); if(!c||!state.charging)return;
    const elapsed=(Date.now()-state.startedAt)/1000;
    const progress=getSessionProgress(elapsed);
    const voltage=220+(Math.random()*3-1.5);
    const current=SIMULATED_POWER_KW*1000/voltage;
    const u=getActiveUser();
    const addedBill=roundMoney(Math.max(0,progress.billPkr-state.lastBilledAmount));
    u.wallet_balance=roundMoney(Math.max(0,Number(u.wallet_balance||0)-addedBill));
    state.lastBilledAmount=progress.billPkr;
    if(state.profile)state.profile.wallet_balance=u.wallet_balance;
    c.voltage=voltage; c.current=current; c.current_kwh=progress.energyKwh;
    c.battery_pct=Math.min(100,Math.round(state.sessionStartingBatteryPct+elapsed/900));
    renderWallet();
    renderMeter();
    if(u.wallet_balance<=0||u.wallet_balance<state.sessionUnitRate){
      stopCharging('Insufficient wallet balance','Charging stopped: Insufficient wallet balance');
    }else if(progress.reachedBudget){
      stopCharging('Budget reached',`Budget reached • Rs. ${fmt(state.sessionBudget)} billed`);
    }
  },SIMULATION_INTERVAL_MS);
}

async function stopCharging(reason,notification=null){
  if(!state.charging)return;
  clearInterval(state.tick);
  const c=state.chargers.find(x=>x.id===state.selectedChargerId);
  if(!c)return;
  const elapsed=Math.max(0,(Date.now()-state.startedAt)/1000);
  const progress=getSessionProgress(elapsed);
  const user=getActiveUser();
  const addedBill=roundMoney(Math.max(0,progress.billPkr-state.lastBilledAmount));
  user.wallet_balance=roundMoney(Math.max(0,Number(user.wallet_balance||0)-addedBill));
  if(state.profile)state.profile.wallet_balance=user.wallet_balance;
  user.total_sessions=(user.total_sessions||0)+1;
  state.sessions.unshift({
    id:crypto.randomUUID(),session_code:'SES-'+Math.floor(100+Math.random()*899),
    station_id:c.id,user_id:user.id,energy_kwh:progress.energyKwh,unit_rate_pkr:state.sessionUnitRate,
    budget_pkr:state.sessionBudget,total_bill_pkr:progress.billPkr,duration_seconds:Math.floor(elapsed),
    status:'completed',started_at:new Date(state.startedAt).toISOString(),ended_at:new Date().toISOString()
  });
  state.lastBilledAmount=progress.billPkr;
  state.charging=false; c.status='online'; c.voltage=0; c.current=0; c.active_user_id=null;
  state.lastBilledAmount=0; state.sessionBudget=0; state.sessionUnitRate=0;
  c.current_kwh=0;
  $('budget-select').disabled=false; $('custom-budget').disabled=false;
  $('toggle-charge').textContent='⚡ START CHARGING'; $('toggle-charge').className='min-h-11 w-full rounded-2xl bg-emerald-500 py-3.5 text-sm font-bold text-slate-950 hover:bg-emerald-400'; $('meter-box').classList.remove('charging-glow','border-emerald-500/50');
  renderAll(); if(state.profile)renderAuthenticatedAccount();
  toast(notification||`Charging stopped • Rs. ${fmt(progress.billPkr)} billed`,notification?'error':'success');
  consoleLog({command:'STOP',charger_id:c.id,reason,bill_pkr:progress.billPkr},'OUT');
}

function renderMeter(){
  const c=state.chargers.find(x=>x.id===state.selectedChargerId)||state.chargers[0]; if(!c)return;
  const elapsed=state.charging?Math.floor((Date.now()-state.startedAt)/1000):0;
  $('session-duration').textContent=secondsToHMS(elapsed); $('battery-pct').textContent=Math.round(c.battery_pct||0); $('battery-bar').style.width=(c.battery_pct||0)+'%';
  $('voltage').textContent=fmt(c.voltage||0)+' V'; $('current').textContent=fmt(c.current||0)+' A'; $('kwh').textContent=fmtEnergy(c.current_kwh||0)+' kWh';
  const bill=(c.current_kwh||0)*(state.charging?state.sessionUnitRate:state.tariff); $('bill').textContent='Rs. '+fmt(bill); $('power').textContent=fmt((c.voltage||0)*(c.current||0)/1000)+' kW';
}

function secondsToHMS(s){ const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60; return [h,m,sec].map(x=>String(x).padStart(2,'0')).join(':'); }

function renderHistory(){
  const sessions=state.sessions.filter(s=>s.user_id===state.activeUserId); $('history-count').textContent=sessions.length+' Sessions';
  $('history-list').innerHTML=sessions.slice(0,20).map(s=>`<div class="bg-slate-900 border border-slate-800 rounded-xl p-3"><div class="flex justify-between"><span class="font-mono text-xs text-emerald-400">${s.session_code||'SESSION'}</span><span class="text-[10px] px-2 py-0.5 rounded-full ${s.status==='active'?'bg-emerald-500/15 text-emerald-400':'bg-slate-800 text-slate-400'}">${s.status}</span></div><div class="mt-2 flex justify-between text-xs"><span>${s.station_id||'-'}</span><b class="text-emerald-400">Rs. ${fmt(s.total_bill_pkr||0)}</b></div><div class="mt-1 text-[10px] text-slate-400">${fmtEnergy(s.energy_kwh||0)} kWh • ${secondsToHMS(s.duration_seconds||0)}</div></div>`).join('')||'<div class="text-xs text-slate-500 text-center py-8">No charging sessions yet</div>';
}

function renderAdmin(){
  const active=state.chargers.filter(c=>c.status==='charging').length; const energy=state.sessions.filter(s=>s.status==='completed').reduce((n,s)=>n+Number(s.energy_kwh||0),0); const revenue=state.sessions.filter(s=>s.status==='completed').reduce((n,s)=>n+Number(s.total_bill_pkr||0),0);
  $('kpi-users').textContent=fmt(state.users.length); $('kpi-boxes').textContent=state.chargers.length; $('kpi-active').textContent=active; $('kpi-energy').textContent=fmt(energy)+' kWh'; $('kpi-revenue').textContent='Rs. '+fmt(revenue); $('kpi-tariff').textContent='Rs. '+fmt(state.tariff); $('tariff-input').value=state.tariff;
  $('telemetry-table').innerHTML=state.chargers.map(c=>{ const u=state.users.find(x=>x.id===c.active_user_id); const st=c.status==='charging'?'text-emerald-400':c.status==='offline'||c.status==='disabled'?'text-slate-500':'text-cyan-400';
    return `<tr class="border-b border-slate-800/70"><td class="p-3"><b class="font-mono text-emerald-400">${c.id}</b><div class="text-slate-500">${c.name}</div></td><td class="${st}">${c.status}</td><td class="font-mono">${fmt(c.voltage)} V</td><td class="font-mono">${fmt(c.current)} A</td><td class="font-mono">${fmtEnergy(c.current_kwh)} kWh</td><td>${c.battery_pct||0}%</td><td>${u?.full_name||'-'}</td><td><div class="flex flex-wrap gap-1"><button class="admin-qr px-2 py-1 rounded bg-sky-500/15 text-sky-300" data-id="${c.id}">View / Print QR</button><button class="admin-start px-2 py-1 rounded bg-emerald-500/15 text-emerald-400" data-id="${c.id}">Start</button><button class="admin-stop px-2 py-1 rounded bg-red-500/15 text-red-400" data-id="${c.id}">Stop</button><button class="admin-disable px-2 py-1 rounded bg-slate-800 text-slate-300" data-id="${c.id}">${c.status==='disabled'?'Enable':'Disable'}</button></div></td></tr>`;
  }).join('')||'<tr><td colspan="8" class="p-6 text-center text-slate-500">No chargers</td></tr>';
  document.querySelectorAll('.admin-start').forEach(b=>b.onclick=()=>adminOverride(b.dataset.id,'start')); document.querySelectorAll('.admin-stop').forEach(b=>b.onclick=()=>adminOverride(b.dataset.id,'stop')); document.querySelectorAll('.admin-disable').forEach(b=>b.onclick=()=>adminOverride(b.dataset.id,'disable')); document.querySelectorAll('.admin-qr').forEach(b=>b.onclick=()=>openQrModal(b.dataset.id));
}

async function updateTariff(){
  const value=Number($('tariff-input').value); if(!Number.isFinite(value)||value<=0)return toast('Enter a valid tariff','error');
  state.tariff=value;
  if(state.configured){ const {error}=await state.supabase.from('system_settings').update({unit_rate_pkr:value,updated_at:new Date().toISOString()}).eq('id',1); if(error)return toast(error.message,'error'); }
  renderAll(); consoleLog({command:'SET_TARIFF',unit_rate_pkr:value},'OUT'); toast('Tariff updated');
}

async function addCharger(){
  const id=$('new-charger-id').value.trim().toUpperCase(); const name=$('new-charger-name').value.trim(); const location=$('new-charger-location').value.trim();
  if(!/^CHG-[0-9]+$/.test(id)||!name||!location)return toast('Enter valid charger details','error');
  if(state.configured){ const {error}=await state.supabase.from('stations').insert({id,name,location,status:'online',voltage:0,current:0,current_kwh:0,battery_pct:50}); if(error)return toast(error.message,'error'); }
  else if(!state.chargers.some(c=>c.id===id)) state.chargers.push({id,name,location,status:'online',voltage:0,current:0,current_kwh:0,battery_pct:50,active_user_id:null});
  $('new-charger-id').value=''; $('new-charger-name').value=''; $('new-charger-location').value=''; renderAll(); consoleLog({command:'PROVISION',charger_id:id,name,location},'OUT'); toast(id+' registered');
}

async function adminOverride(id,action){
  const c=state.chargers.find(x=>x.id===id); if(!c)return;
  if(state.configured&&action==='start'){
    return toast('Live charging is unavailable until trusted device telemetry is connected','error');
  }
  if(state.configured&&action==='stop'){
    const {error}=await state.supabase.rpc('complete_charging_session',{p_station_id:id,p_reason:'Admin stopped session'});
    if(error)return toast(error.message,'error');
  }
  if(action==='start'){ c.status='charging'; c.voltage=220.5; c.current=24; c.active_user_id=state.activeUserId; consoleLog({command:'START',charger_id:id,source:'admin'},'OUT'); }
  if(action==='stop'){ c.status='online'; c.voltage=0; c.current=0; c.active_user_id=null; consoleLog({command:'STOP',charger_id:id,source:'admin'},'OUT'); }
  if(action==='disable'){ c.status=c.status==='disabled'?'online':'disabled'; consoleLog({command:c.status==='disabled'?'DISABLE':'ENABLE',charger_id:id,source:'admin'},'OUT'); }
  if(state.configured){
    const {error}=await state.supabase.from('stations').update({status:c.status,voltage:c.voltage||0,current:c.current||0,active_user_id:c.active_user_id||null,updated_at:new Date().toISOString()}).eq('id',id); if(error)return toast(error.message,'error');
  }
  renderAll();
}

function updateClock(){ const d=new Date(); $('phone-clock').textContent=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }

// RideaseVX production enhancements

// Production configuration helpers use the constants declared at the top of this file.
Object.assign(state, {
  session: null,
  profile: null,
  authMode: 'login',
  isAdmin: false,
  demoMode: true,
  qrScanner: null,
  currentQrId: null,
  realtimeChannel: null
});

function initials(name) {
  return String(name || 'EV').split(/\s+/).filter(Boolean).map(s => s[0]).join('').slice(0, 2).toUpperCase();
}

function setAuthTab(mode) {
  state.authMode = mode;
  const login = mode === 'login';
  $('signup-fields').classList.toggle('hidden', login);
  $('auth-password').autocomplete = login ? 'current-password' : 'new-password';
  $('auth-submit').textContent = login ? 'Log In' : 'Create Account';
  $('auth-login-tab').className = login ? 'auth-tab rounded-lg bg-emerald-500 px-3 py-2 text-sm font-bold text-slate-950' : 'auth-tab rounded-lg px-3 py-2 text-sm text-slate-400';
  $('auth-signup-tab').className = !login ? 'auth-tab rounded-lg bg-emerald-500 px-3 py-2 text-sm font-bold text-slate-950' : 'auth-tab rounded-lg px-3 py-2 text-sm text-slate-400';
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!state.configured) {
    $('auth-message').textContent = 'Configure Supabase with the gear button first.';
    $('auth-message').className = 'mt-3 text-center text-xs text-red-400';
    return;
  }
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const name = $('auth-name').value.trim();
  const phone = $('auth-phone').value.trim();
  $('auth-message').textContent = 'Please wait…';
  try {
    let result;
    if (state.authMode === 'signup') {
      result = await state.supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: name, phone },
          emailRedirectTo: AUTH_REDIRECT_URL
        }
      });
    } else {
      result = await state.supabase.auth.signInWithPassword({ email, password });
    }
    if (result.error) throw result.error;
    if (state.authMode === 'signup' && result.data.user && !result.data.session) {
      $('auth-message').textContent = 'Account created. Confirm your email, then log in.';
      setAuthTab('login');
      return;
    }
    await applyAuthenticatedSession(result.data.session);
  } catch (error) {
    $('auth-message').textContent = error.message;
    $('auth-message').className = 'mt-3 text-center text-xs text-red-400';
  }
}

async function loadProfile(userId) {
  const { data, error } = await state.supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) throw error;
  state.profile = data;
  state.isAdmin = data.role === 'admin';
  state.activeUserId = userId;
  state.users = [data];
}

async function applyAuthenticatedSession(session) {
  state.session = session;
  if (!session?.user) {
    $('auth-screen').classList.remove('hidden');
    $('auth-screen').classList.add('grid');
    $('account-info').classList.add('hidden');
    $('logout-btn').classList.add('hidden');
    return;
  }
  await loadProfile(session.user.id);
  await loadSupabaseData();
  $('auth-screen').classList.add('hidden');
  $('auth-screen').classList.remove('grid');
  $('account-info').classList.remove('hidden');
  $('logout-btn').classList.remove('hidden');
  renderAuthenticatedAccount();
  applyRoleView();
}

function renderAuthenticatedAccount() {
  if (!state.profile) return;
  $('account-name').textContent = state.profile.full_name || state.profile.email;
  $('account-wallet').textContent = 'Rs. ' + fmt(state.profile.wallet_balance);
  $('app-user-name').textContent = state.profile.full_name || 'RideaseVX User';
  $('app-user-email').textContent = state.profile.email || state.session?.user?.email || 'Verified driver';
  $('user-avatar').textContent = initials(state.profile.full_name);
  renderWallet();
}

function applyRoleView() {
  const adminModeButton = document.querySelector('[data-mode="admin"]');
  if (adminModeButton) adminModeButton.classList.toggle('hidden', !state.isAdmin);
  if (!state.isAdmin) {
    setViewMode('mobile');
  }
}

async function logout(signOutFromSupabase = true) {
  await stopQrScanner();
  if (signOutFromSupabase && state.supabase) await state.supabase.auth.signOut();
  state.session = null;
  state.profile = null;
  state.isAdmin = false;
  $('auth-screen').classList.remove('hidden');
  $('auth-screen').classList.add('grid');
  $('account-info').classList.add('hidden');
  $('logout-btn').classList.add('hidden');
  document.querySelector('[data-mode="admin"]')?.classList.remove('hidden');
}

async function openQrScanner() {
  if (!window.Html5Qrcode) return toast('QR scanner library could not load', 'error');
  if (!window.isSecureContext) return toast('Camera scanning over Wi-Fi requires HTTPS; select a station from the list instead', 'error');
  if (!navigator.mediaDevices?.getUserMedia) return toast('Camera access is unavailable in this browser; select a station from the list instead', 'error');
  $('qr-reader').classList.remove('hidden');
  try {
    if (state.qrScanner) await state.qrScanner.clear();
    state.qrScanner = new Html5Qrcode('qr-reader');
    await state.qrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      async decoded => {
        let chargerId = decoded.trim();
        try {
          const parsed = JSON.parse(decoded);
          chargerId = parsed.station_id || parsed.charger_id || parsed.id || chargerId;
        } catch (_) {}
        const charger = state.chargers.find(c => c.id === chargerId);
        if (charger) {
          await stopQrScanner();
          selectCharger(chargerId);
          toast('QR detected: ' + chargerId);
        } else {
          toast('Unknown charger: ' + chargerId, 'error');
        }
      },
      () => {}
    );
  } catch (error) {
    $('qr-reader').classList.add('hidden');
    toast(error.message || 'Unable to access camera', 'error');
  }
}

async function stopQrScanner() {
  if (!state.qrScanner) return;
  try {
    if (typeof state.qrScanner.isScanning === 'boolean' && state.qrScanner.isScanning) {
      await state.qrScanner.stop();
    } else if (typeof state.qrScanner.getState === 'function') {
      const stateValue = state.qrScanner.getState();
      if (stateValue === 2) await state.qrScanner.stop();
    }
    await state.qrScanner.clear();
  } catch (_) {}
  state.qrScanner = null;
  if ($('qr-reader')) $('qr-reader').classList.add('hidden');
}

function openQrModal(chargerId) {
  if (!window.QRCode) return toast('QR Code library could not load', 'error');
  const charger = state.chargers.find(c => c.id === chargerId);
  if (!charger) return;
  state.currentQrId = chargerId;
  $('qr-modal-title').textContent = charger.name;
  $('qr-modal-code').textContent = chargerId;
  $('qr-code').innerHTML = '';
  new QRCode($('qr-code'), {
    text: JSON.stringify({ station_id: chargerId }),
    width: 320,
    height: 320,
    correctLevel: QRCode.CorrectLevel.H,
    colorDark: '#020617',
    colorLight: '#ffffff'
  });
  $('qr-modal').classList.remove('hidden');
  $('qr-modal').classList.add('grid');
}

function closeQrModal() {
  $('qr-modal').classList.add('hidden');
  $('qr-modal').classList.remove('grid');
}

function downloadQrPng() {
  const canvas = $('qr-code').querySelector('canvas');
  const image = $('qr-code').querySelector('img');
  const url = canvas ? canvas.toDataURL('image/png') : image?.src;
  if (!url) return toast('QR code is not ready yet', 'error');
  const link = document.createElement('a');
  link.download = `${state.currentQrId || 'charger'}-QR.png`;
  link.href = url;
  link.click();
}

function printQr() {
  const canvas = $('qr-code').querySelector('canvas');
  const image = $('qr-code').querySelector('img');
  const src = canvas ? canvas.toDataURL('image/png') : image?.src;
  if (!src) return toast('QR code is not ready yet', 'error');
  const win = window.open('', '_blank');
  win.document.write(`<html><head><title>${state.currentQrId} QR</title></head><body style="display:grid;place-items:center;font-family:Arial"><main><h2>${state.currentQrId}</h2><img src="${src}" width="320" height="320"><script>onload=()=>print()<\/script></main></body></html>`);
  win.document.close();
}

function bindProductionUI() {
  $('auth-login-tab').onclick = () => setAuthTab('login');
  $('auth-signup-tab').onclick = () => setAuthTab('signup');
  $('auth-form').onsubmit = handleAuthSubmit;
  $('logout-btn').onclick = logout;
  $('open-camera').onclick = openQrScanner;
  $('close-qr').onclick = closeQrModal;
  $('download-qr').onclick = downloadQrPng;
  $('print-qr').onclick = printQr;
  $('topup').onclick = topUp;
}

async function productionInit() {
  seedDemo();
  bindUI();
  bindProductionUI();
  setInterval(updateClock, 1000);
  updateClock();
  setupInstallSupport();
  $('auth-screen').classList.remove('hidden');
  $('auth-screen').classList.add('grid');
  setAuthTab('login');

  const savedUrl = localStorage.getItem('voltsync_url')?.trim();
  const savedKey = localStorage.getItem('voltsync_key')?.trim();
  const url = savedUrl || SUPABASE_URL;
  const key = savedKey || SUPABASE_ANON_KEY;

  localStorage.setItem('voltsync_url', url);
  localStorage.setItem('voltsync_key', key);

  $('supabase-url').value = url;
  $('supabase-key').value = key;

  const configuredUrl = url !== 'https://YOUR_PROJECT_REF.supabase.co'
    && /^https:\/\/[^/]+\.supabase\.co$/i.test(url);
  if (configuredUrl) {
    await connectProductionSupabase(url, key);
  } else {
    setDemoMode();
    setTimeout(() => {
      $('config-modal').classList.remove('hidden');
      $('config-modal').classList.add('grid');
    }, 300);
  }

}

function setupInstallSupport() {
  const button = $('install-app');
  const help = $('install-help');
  const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
  if (isStandalone) return;
  if (isAppleMobile) {
    button.classList.remove('hidden');
    help.classList.remove('hidden');
  }
  button.onclick = async () => {
    if (!deferredInstallPrompt) {
      if (isAppleMobile) toast('Tap Share, then Add to Home Screen to install RideaseVX.');
      return;
    }
    const installPrompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === 'accepted') toast('RideaseVX installed');
      button.classList.add('hidden');
    } catch (error) {
      toast(`Could not open the install prompt: ${error.message}`, 'error');
    }
  };
}

async function connectProductionSupabase(url, key) {
  try {
    state.supabase = window.supabase.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    state.configured = true;
    state.demoMode = false;
    localStorage.setItem('voltsync_url', url);
    localStorage.setItem('voltsync_key', key);
    $('backend-status').textContent = 'Supabase + Realtime';
    $('backend-status').className = 'text-xs font-mono text-emerald-400';
    $('backend-dot').className = 'relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 status-dot';

    state.supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED') {
        setTimeout(() => applyAuthenticatedSession(session).catch(error => toast(error.message, 'error')), 0);
      }
      if (event === 'SIGNED_OUT') setTimeout(() => logout(false), 0);
    });

    const { data: { session } } = await state.supabase.auth.getSession();
    if (session) await applyAuthenticatedSession(session);
    else {
      await loadSupabaseData().catch(error => toast(error.message, 'error'));
      $('auth-screen').classList.remove('hidden');
      $('auth-screen').classList.add('grid');
    }
    subscribeRealtime();
  } catch (error) {
    toast(error.message, 'error');
    setDemoMode();
  }
}

// Replace the original demo bootstrap and make authentication the production entry point.
document.removeEventListener?.('DOMContentLoaded', init);
document.addEventListener('DOMContentLoaded', productionInit);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .catch(error => console.error('RideaseVX service worker registration failed:', error));
  });
}
