/* RideaseVX — demo mode + Supabase v2 integration */
'use strict';

// Browser-safe Supabase configuration. Set SUPABASE_URL here or enter it in the gear modal.
const SUPABASE_URL = 'https://atucbucsqqtadfgzowiy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_2ShhTVhq7BKaEezETih2jg_xbTa3ggf';
const AUTH_REDIRECT_URL = 'https://mir63059.github.io/voltsync-ev/';
const EASYPAISA_ACCOUNT_TITLE = 'Jahandad Dad';
const EASYPAISA_ACCOUNT_NUMBER = '03423715266';
const EASYPAISA_QR_IMAGE = './easypaisa-qr.png';
const OWNER_ADMIN_EMAIL = 'mir.63059@iqra.edu.pk';
const isOwnerEmail = email => String(email || '').trim().toLowerCase() === OWNER_ADMIN_EMAIL.toLowerCase();
const hasOwnerAdminAccess = () => isOwnerEmail(state.session?.user?.email);
// Never place a Supabase secret/service-role key in this file.

const DEMO_USERS = [
  { id:'demo-1', full_name:'Ali Khan', initials:'AK', paid_balance:0, total_sessions:0 },
  { id:'demo-2', full_name:'Sara Ahmed', initials:'SA', paid_balance:0, total_sessions:0 },
  { id:'demo-3', full_name:'Usman Tariq', initials:'UT', paid_balance:0, total_sessions:0 }
];

const state = {
  supabase:null, configured:false, mode:'split', activeUserId:'demo-1', selectedChargerId:'CHG-001',
  tariff:65, users:structuredClone(DEMO_USERS), chargers:[], sessions:[], transactions:[], paymentRequests:[],
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
  realtimeChannel: null, authSubscription:null, sessionUserId:null, sessionLoad:null
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
  if(state.realtimeChannel&&state.supabase)state.supabase.removeChannel(state.realtimeChannel);
  state.authSubscription?.unsubscribe();
  state.configured=false;
  state.supabase=null;
  state.demoMode=true;
  state.session=null;
  state.sessionUserId=null;
  state.sessionLoad=null;
  state.authSubscription=null;
  state.realtimeChannel=null;
  state.profile=null;
  state.isAdmin=false;
  state.activeDbSession=null;
  state.charging=false;
  state.paymentRequests=[];
  state.sessions=[];
  state.users=structuredClone(DEMO_USERS);
  state.mode='mobile';
  seedDemo();
  $('auth-screen').classList.remove('hidden');
  $('auth-screen').classList.add('grid');
  $('account-info').classList.add('hidden');
  $('logout-btn').classList.add('hidden');
  document.querySelector('[data-mode="admin"]')?.classList.add('hidden');
  $('admin-panel').classList.add('hidden');
  $('backend-status').textContent='Local Demo'; $('backend-status').className='text-xs font-mono text-amber-400'; $('backend-dot').className='relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400 status-dot';
  renderAll(); consoleLog({mode:'demo',status:'authentication-required; charging-disabled'},'IN');
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
  const requestedUserId=state.session?.user?.id||null;
  const isAdmin = hasOwnerAdminAccess();
  const profilesRequest = state.session
  ? sb.from('profiles').select('id,email,full_name,phone,role,paid_balance,total_sessions,created_at').order('full_name')
  : Promise.resolve({data:[],error:null});
  let sessionsQuery=state.session
  ? sb.from('sessions').select('*')
  : null;
  if(sessionsQuery&&!isAdmin)sessionsQuery=sessionsQuery.eq('user_id',state.session.user.id);
  const sessionsRequest = sessionsQuery
  ? sessionsQuery.order('started_at',{ascending:false}).limit(isAdmin?500:100)
  : Promise.resolve({data:[],error:null});
  const paymentsRequest = state.session
  ? sb.from('easypaisa_payment_requests').select('*').order('created_at',{ascending:false}).limit(isAdmin?200:20)
  : Promise.resolve({data:[],error:null});
  const [chargers,settings,profiles,sessions,payments] = await Promise.all([
    sb.from('stations').select('*').order('id'),
    sb.from('system_settings').select('*').eq('id',1).maybeSingle(),
    profilesRequest,
  sessionsRequest,
  paymentsRequest
  ]);
  if(requestedUserId!==(state.session?.user?.id||null))return;
  if(chargers.error)toast(`Stations could not be loaded: ${chargers.error.message}`,'error');
  else if(chargers.data?.length) state.chargers=chargers.data;
  if(settings.error)toast(`Tariff could not be loaded: ${settings.error.message}`,'error');
  else if(settings.data) state.tariff=Number(settings.data.unit_rate_pkr);
  if(profiles.error)toast(`Profiles could not be loaded: ${profiles.error.message}`,'error');
  else if(profiles.data){
    state.users=profiles.data;
    const ownProfile=profiles.data.find(profile=>profile.id===requestedUserId);
    if(ownProfile)state.profile=ownProfile;
  }
  if(sessions.error)toast(`Charging sessions could not be loaded: ${sessions.error.message}`,'error');
  else if(sessions.data)state.sessions=sessions.data;
  if(payments.error){
    state.paymentRequests=[];
    toast(`Payment history is unavailable: ${payments.error.message}`,'error');
  }else if(payments.data)state.paymentRequests=payments.data;
  syncActiveSession();
  renderAll();
}

function subscribeRealtime(){
  if(!state.configured) return;
  if(state.realtimeChannel) state.supabase.removeChannel(state.realtimeChannel);
  state.realtimeChannel=state.supabase.channel('rideasevx-live')
    .on('postgres_changes',{event:'*',schema:'public',table:'stations'},payload=>{ upsertRealtime('stations',payload); consoleLog({table:'stations',event:payload.eventType,row:payload.new||payload.old},'IN'); })
    .on('postgres_changes',{event:'*',schema:'public',table:'sessions'},payload=>{ upsertRealtime('sessions',payload); consoleLog({table:'sessions',event:payload.eventType,row:payload.new||payload.old},'IN'); })
    .on('postgres_changes',{event:'*',schema:'public',table:'profiles'},payload=>{ upsertRealtime('profiles',payload); renderAll(); })
  .on('postgres_changes',{event:'*',schema:'public',table:'easypaisa_payment_requests'},payload=>{ upsertPaymentRequest(payload); })
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
    syncActiveSession();
  }
  if(table==='profiles'&&payload.new?.id===state.session?.user?.id){
    state.profile=payload.new;
    state.users=[payload.new];
  }
  renderAll();
}

function syncActiveSession(){
  const active = state.sessions.find(session => session.user_id === state.session?.user?.id && session.status === 'active');
  state.activeDbSession = active || null;
  state.charging = Boolean(active);
  if(active){
    state.selectedChargerId=active.station_id;
    state.sessionBudget=Number(active.budget_pkr||0);
    state.sessionUnitRate=Number(active.unit_rate_pkr||0);
    state.startedAt=Date.parse(active.started_at);
  }else{
    state.sessionBudget=0;
    state.sessionUnitRate=0;
    state.startedAt=null;
  }
}

function upsertPaymentRequest(payload){
  const request=payload.new||payload.old;
  if(!request)return;
  if(payload.eventType==='DELETE'){
    state.paymentRequests=state.paymentRequests.filter(item=>item.id!==request.id);
  }else{
    const index=state.paymentRequests.findIndex(item=>item.id===request.id);
    if(index>=0)state.paymentRequests[index]=request;
    else state.paymentRequests.unshift(request);
  }
  renderPaymentRequests();
}

function bindUI(){
  document.querySelectorAll('.mode-btn').forEach(btn=>btn.addEventListener('click',()=>setViewMode(btn.dataset.mode)));
  document.querySelectorAll('.mobile-nav-btn').forEach(btn=>btn.addEventListener('click',()=>switchMobileTab(btn.dataset.tab)));
  $('open-config').onclick=()=>{ $('config-modal').classList.remove('hidden'); $('config-modal').classList.add('grid'); };
  $('close-config').onclick=()=>{ $('config-modal').classList.add('hidden'); $('config-modal').classList.remove('grid'); };
  $('save-config').onclick=()=>{ const url=$('supabase-url').value.trim(); const key=$('supabase-key').value.trim(); if(!url||!key) return toast('URL and anon key are required','error'); connectProductionSupabase(url,key); };
  $('clear-config').onclick=()=>{ localStorage.removeItem('voltsync_url'); localStorage.removeItem('voltsync_key'); $('supabase-url').value=''; $('supabase-key').value=''; $('config-modal').classList.add('hidden'); $('config-modal').classList.remove('grid'); setDemoMode(); };
  $('toggle-charge').onclick=toggleCharging;
  $('payment-form').onsubmit=submitEasypaisaPayment;
  $('payment-amount').onchange=syncPaymentAmount;
  $('payment-custom-amount').oninput=syncPaymentAmount;
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
  if(mode==='admin'&&!requireAdmin())return;
  state.mode=mode; document.querySelectorAll('.mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  $('workspace').className=mode==='mobile'?'grid grid-cols-1 lg:grid-cols-12 gap-6':mode==='admin'?'grid grid-cols-1 gap-6':'grid grid-cols-1 lg:grid-cols-12 gap-6';
  $('mobile-panel').className=mode==='admin'?'hidden':'lg:col-span-4 flex justify-center';
  $('admin-panel').classList.toggle('hidden',mode!=='admin'||!hasOwnerAdminAccess());
  if(mode==='split'&&hasOwnerAdminAccess())$('admin-panel').classList.remove('hidden');
}

function switchMobileTab(tab){
  document.querySelectorAll('.mobile-tab').forEach(el=>el.classList.add('hidden')); $('tab-'+tab).classList.remove('hidden');
  document.querySelectorAll('.mobile-nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
}

function switchUser(id){
  if(!requireAdmin())return;
  state.activeUserId=id; const user=getActiveUser(); $('user-avatar').textContent=user.initials||String(user.full_name||'U').split(' ').map(x=>x[0]).join('').slice(0,2).toUpper();
  renderWallet(); renderHistory();
}

function getActiveUser(){
  return state.users.find(u=>u.id===state.session?.user?.id)||state.users.find(u=>u.id===state.activeUserId)||state.profile||null;
}

function renderAll(){ renderChargerList(); renderAdmin(); renderWallet(); renderMeter(); renderHistory(); renderPaymentRequests(); }

function renderWallet(){ const u=getActiveUser(); $('wallet').textContent='Rs. '+fmt(u?.paid_balance||0); updateBudgetHint(); if(state.profile)$('account-wallet').textContent='Rs. '+fmt(state.profile.paid_balance||0); }

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
  const balance=roundMoney(Number(user?.paid_balance||0));
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
  if(!state.configured||!state.session?.user)return toast('Sign in to a configured Supabase project before charging.','error');
  const c=state.chargers.find(x=>x.id===state.selectedChargerId); if(!c)return;
  if(state.charging)return stopCharging('User stopped session');
  if(c.status==='offline'||c.status==='disabled'||c.status==='charging')return toast('Charger unavailable.','error');
  const budget=readBudgetAmount();
  const balance=roundMoney(Number(getActiveUser()?.paid_balance||0));
  if(!budget)return toast('Choose a valid charging budget first','error');
  if(budget>balance)return toast('Budget exceeds your verified paid balance.','error');
  $('toggle-charge').disabled=true;
  try{
    const {error}=await state.supabase.rpc('start_charging_session',{
      p_station_id:c.id,
      p_budget_pkr:budget
    });
    if(error)throw error;
    await loadSupabaseData();
    $('payment-message').textContent='';
    toast(`Charging started with a maximum spend of Rs. ${fmt(budget)}.`);
  }catch(error){
    toast(error.message,'error');
  }finally{
    $('toggle-charge').disabled=false;
    renderChargingControls();
  }
}

async function stopCharging(reason,notification=null){
  const session=state.activeDbSession;
  if(!session||!state.configured)return;
  $('toggle-charge').disabled=true;
  try{
    const {data,error}=await state.supabase.rpc('complete_charging_session',{
      p_station_id:session.station_id,
      p_reason:reason||'User stopped session'
    });
    if(error)throw error;
    await loadSupabaseData();
    const billed=Number(data?.bill_pkr||0);
    toast(notification||`Charging stopped • Rs. ${fmt(billed)} used; unused balance returned.`);
  }catch(error){
    toast(error.message,'error');
  }finally{
    $('toggle-charge').disabled=false;
    renderChargingControls();
  }
}

function renderMeter(){
  const c=state.chargers.find(x=>x.id===state.selectedChargerId)||state.chargers[0]; if(!c)return;
  const elapsed=state.charging?Math.floor((Date.now()-state.startedAt)/1000):0;
  $('session-duration').textContent=secondsToHMS(elapsed); $('battery-pct').textContent=Math.round(c.battery_pct||0); $('battery-bar').style.width=(c.battery_pct||0)+'%';
  $('voltage').textContent=fmt(c.voltage||0)+' V'; $('current').textContent=fmt(c.current||0)+' A'; $('kwh').textContent=fmtEnergy(c.current_kwh||0)+' kWh';
  const bill=state.activeDbSession
    ? Number(state.activeDbSession.total_bill_pkr||0)
    : (c.current_kwh||0)*state.tariff;
  $('bill').textContent='Rs. '+fmt(bill); $('power').textContent=fmt((c.voltage||0)*(c.current||0)/1000)+' kW';
  renderChargingControls();
}

function renderChargingControls(){
  const active=state.activeDbSession;
  $('toggle-charge').textContent=active?'■ STOP CHARGING':'⚡ START CHARGING';
  $('toggle-charge').classList.toggle('bg-red-500',Boolean(active));
  $('toggle-charge').classList.toggle('bg-emerald-500',!active);
  $('toggle-charge').classList.toggle('text-white',Boolean(active));
  $('toggle-charge').classList.toggle('text-slate-950',!active);
  $('budget-select').disabled=Boolean(active);
  $('custom-budget').disabled=Boolean(active);
  if(active){
    $('budget-help').textContent=`Reserved: Rs. ${fmt(active.budget_pkr)} • used: Rs. ${fmt(active.total_bill_pkr)}. Remaining reserved balance is refunded when stopped.`;
    $('app-charger-code').textContent=active.station_id;
  }
}

function secondsToHMS(s){ const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60; return [h,m,sec].map(x=>String(x).padStart(2,'0')).join(':'); }

function renderHistory(){
  const userId=state.session?.user?.id||getActiveUser()?.id;
  const sessions=state.sessions.filter(s=>s.user_id===userId); $('history-count').textContent=sessions.length+' Sessions';
  $('history-list').innerHTML=sessions.slice(0,20).map(s=>`<div class="bg-slate-900 border border-slate-800 rounded-xl p-3"><div class="flex justify-between"><span class="font-mono text-xs text-emerald-400">${s.session_code||'SESSION'}</span><span class="text-[10px] px-2 py-0.5 rounded-full ${s.status==='active'?'bg-emerald-500/15 text-emerald-400':'bg-slate-800 text-slate-400'}">${s.status}</span></div><div class="mt-2 flex justify-between text-xs"><span>${s.station_id||'-'}</span><b class="text-emerald-400">Rs. ${fmt(s.total_bill_pkr||0)}</b></div><div class="mt-1 text-[10px] text-slate-400">${fmtEnergy(s.energy_kwh||0)} kWh • ${secondsToHMS(s.duration_seconds||0)}</div></div>`).join('')||'<div class="text-xs text-slate-500 text-center py-8">No charging sessions yet</div>';
}

function renderAdmin(){
  $('admin-panel').classList.toggle('hidden',!hasOwnerAdminAccess());
  if(!hasOwnerAdminAccess())return;
  const active=state.chargers.filter(c=>c.status==='charging').length; const energy=state.sessions.filter(s=>s.status==='completed').reduce((n,s)=>n+Number(s.energy_kwh||0),0); const revenue=state.sessions.filter(s=>s.status==='completed').reduce((n,s)=>n+Number(s.total_bill_pkr||0),0);
  $('kpi-users').textContent=fmt(state.users.length); $('kpi-boxes').textContent=state.chargers.length; $('kpi-active').textContent=active; $('kpi-energy').textContent=fmt(energy)+' kWh'; $('kpi-revenue').textContent='Rs. '+fmt(revenue); $('kpi-tariff').textContent='Rs. '+fmt(state.tariff); $('tariff-input').value=state.tariff;
  $('telemetry-table').innerHTML=state.chargers.map(c=>{ const u=state.users.find(x=>x.id===c.active_user_id); const st=c.status==='charging'?'text-emerald-400':c.status==='offline'||c.status==='disabled'?'text-slate-500':'text-cyan-400';
    return `<tr class="border-b border-slate-800/70"><td class="p-3"><b class="font-mono text-emerald-400">${c.id}</b><div class="text-slate-500">${c.name}</div></td><td class="${st}">${c.status}</td><td class="font-mono">${fmt(c.voltage)} V</td><td class="font-mono">${fmt(c.current)} A</td><td class="font-mono">${fmtEnergy(c.current_kwh)} kWh</td><td>${c.battery_pct||0}%</td><td>${u?.full_name||'-'}</td><td><div class="flex flex-wrap gap-1"><button class="admin-qr px-2 py-1 rounded bg-sky-500/15 text-sky-300" data-id="${c.id}">View / Print QR</button><button class="admin-stop px-2 py-1 rounded bg-red-500/15 text-red-400" data-id="${c.id}">Stop</button><button class="admin-disable px-2 py-1 rounded bg-slate-800 text-slate-300" data-id="${c.id}">${c.status==='disabled'?'Enable':'Disable'}</button></div></td></tr>`;
  }).join('')||'<tr><td colspan="8" class="p-6 text-center text-slate-500">No chargers</td></tr>';
  document.querySelectorAll('.admin-stop').forEach(b=>b.onclick=()=>adminOverride(b.dataset.id,'stop')); document.querySelectorAll('.admin-disable').forEach(b=>b.onclick=()=>adminOverride(b.dataset.id,'disable')); document.querySelectorAll('.admin-qr').forEach(b=>b.onclick=()=>openQrModal(b.dataset.id));
}

async function updateTariff(){
  if(!requireAdmin())return;
  const value=Number($('tariff-input').value); if(!Number.isFinite(value)||value<=0)return toast('Enter a valid tariff','error');
  if(!state.configured)return toast('Admin changes require the secured Supabase setup.','error');
  const {error}=await state.supabase.from('system_settings').update({unit_rate_pkr:value,updated_at:new Date().toISOString()}).eq('id',1);
  if(error)return toast(error.message,'error');
  state.tariff=value;
  renderAll(); consoleLog({command:'SET_TARIFF',unit_rate_pkr:value},'OUT'); toast('Tariff updated');
}

async function addCharger(){
  if(!requireAdmin())return;
  const id=$('new-charger-id').value.trim().toUpperCase(); const name=$('new-charger-name').value.trim(); const location=$('new-charger-location').value.trim();
  if(!/^CHG-[0-9]+$/.test(id)||!name||!location)return toast('Enter valid charger details','error');
  if(!state.configured)return toast('Admin changes require the secured Supabase setup.','error');
  const {error}=await state.supabase.from('stations').insert({id,name,location,status:'online',voltage:0,current:0,current_kwh:0,battery_pct:50});
  if(error)return toast(error.message,'error');
  $('new-charger-id').value=''; $('new-charger-name').value=''; $('new-charger-location').value=''; await loadSupabaseData(); consoleLog({command:'PROVISION',charger_id:id,name,location},'OUT'); toast(id+' registered');
}

async function adminOverride(id,action){
  if(!requireAdmin())return;
  const c=state.chargers.find(x=>x.id===id); if(!c)return;
  if(!state.configured)return toast('Admin actions require the secured Supabase setup.','error');
  if(action==='stop'){
    const {error}=await state.supabase.rpc('complete_charging_session',{p_station_id:id,p_reason:'Admin stopped session'});
    if(error)return toast(error.message,'error');
  }else if(action==='disable'){
    const {error}=await state.supabase.from('stations').update({status:c.status==='disabled'?'online':'disabled'}).eq('id',id);
    if(error)return toast(error.message,'error');
  }else return toast('Unknown admin action.','error');
  await loadSupabaseData();
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

function requireAdmin(){
  if(hasOwnerAdminAccess()&&state.configured)return true;
  toast('Administrator access is required.','error');
  return false;
}

function isConfiguredEasypaisaAccount(){
  return EASYPAISA_ACCOUNT_TITLE!=='YOUR_EASYPAISA_ACCOUNT_TITLE'
    && !EASYPAISA_ACCOUNT_TITLE.includes('YOUR_')
    && EASYPAISA_ACCOUNT_NUMBER!=='03XX-XXXXXXX'
    && /\d{8,}/.test(EASYPAISA_ACCOUNT_NUMBER.replace(/\D/g,''));
}

function renderEasypaisaDetails(){
  $('easypaisa-title').textContent=isConfiguredEasypaisaAccount()?EASYPAISA_ACCOUNT_TITLE:'Set EASYPAISA_ACCOUNT_TITLE in app.js';
  $('easypaisa-number').textContent=isConfiguredEasypaisaAccount()?EASYPAISA_ACCOUNT_NUMBER:'Set EASYPAISA_ACCOUNT_NUMBER in app.js';
  const image=$('easypaisa-qr');
  image.classList.add('hidden');
  $('easypaisa-qr-help').textContent=!isConfiguredEasypaisaAccount()
    ? 'Payments are disabled until you configure your Easypaisa account details.'
    : EASYPAISA_QR_IMAGE
      ? 'This QR is fixed at Rs. 500. For other amounts, pay directly to the account number. Confirm the recipient and exact amount before sending.'
      : 'No compatible QR is configured. Send the exact amount to this account number; TIDs are credited only after manual verification.';
  if(!EASYPAISA_QR_IMAGE)return;
  image.onerror=()=>{
    image.classList.add('hidden');
    $('easypaisa-qr-help').textContent='Add your real payment QR image as easypaisa-qr.png in the project root, or pay using the account details.';
  };
  image.onload=()=>image.classList.remove('hidden');
  image.src=EASYPAISA_QR_IMAGE;
}

function selectedPaymentAmount(){
  const raw=$('payment-amount').value==='custom'
    ? $('payment-custom-amount').value
    : $('payment-amount').value;
  const amount=Number(raw);
  if(!Number.isFinite(amount)||amount<=0||Math.abs(amount*100-Math.round(amount*100))>0.000001)return null;
  return Math.round(amount*100);
}

function syncPaymentAmount(){
  const isCustom=$('payment-amount').value==='custom';
  $('payment-custom-amount').classList.toggle('hidden',!isCustom);
  const amount=selectedPaymentAmount();
  $('payment-paid-amount').value=amount===null?'':(amount/100).toFixed(2);
}

async function submitEasypaisaPayment(event){
  event.preventDefault();
  if(!state.configured||!state.session?.user)return toast('Sign in before submitting a payment.','error');
  if(!isConfiguredEasypaisaAccount())return toast('Easypaisa account details are not configured.','error');
  const amountCents=selectedPaymentAmount();
  const paidAmount=Number($('payment-paid-amount').value);
  const paidCents=Math.round(paidAmount*100);
  if(amountCents===null||!Number.isFinite(paidAmount)||paidCents!==amountCents){
    return toast('The amount paid must exactly match the amount you selected.','error');
  }
  const transactionId=$('payment-tid').value.trim();
  if(!transactionId)return toast('Enter the Easypaisa transaction ID (TID).','error');
  $('payment-submit').disabled=true;
  $('payment-message').textContent='Submitting for administrator verification…';
  try{
    const {error}=await state.supabase.rpc('submit_easypaisa_payment',{
      p_transaction_id:transactionId,
      p_paid_amount_pkr:paidCents/100
    });
    if(error)throw error;
    $('payment-tid').value='';
    $('payment-message').textContent=`Rs. ${fmt(paidCents/100)} submitted. It will be credited only after the TID is verified.`;
    await loadSupabaseData();
  }catch(error){
    $('payment-message').textContent=error.message;
    toast(error.message,'error');
  }finally{
    $('payment-submit').disabled=false;
  }
}

function escapeHtml(value){
  return String(value??'').replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[char]);
}

function renderPaymentRequests(){
  if(!$('payment-history'))return;
  $('payment-history').innerHTML=state.paymentRequests
    .filter(request=>request.user_id===state.session?.user?.id)
    .slice(0,10)
    .map(request=>`<div class="rounded-lg border border-slate-800 px-3 py-2 text-[11px]"><div class="flex justify-between gap-2"><span>TID ${escapeHtml(request.transaction_id)}</span><strong>Rs. ${fmt(request.paid_amount_pkr)}</strong></div><p class="mt-1 text-slate-400">Status: ${escapeHtml(request.status)}</p></div>`)
    .join('');
  if(!$('payment-review-list'))return;
  $('payment-review-list').innerHTML=hasOwnerAdminAccess()
    ? state.paymentRequests.filter(request=>request.status==='pending').map(request=>{
      const owner=state.users.find(user=>user.id===request.user_id);
      return `<div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 p-3 text-xs"><div><strong>Rs. ${fmt(request.paid_amount_pkr)}</strong> · TID <span class="font-mono">${escapeHtml(request.transaction_id)}</span><p class="text-slate-400">${escapeHtml(owner?.email||request.user_id)}</p></div><div class="flex gap-2"><button class="payment-review primary-btn" data-id="${escapeHtml(request.id)}" data-approve="true">Verify &amp; credit</button><button class="payment-review secondary-btn" data-id="${escapeHtml(request.id)}" data-approve="false">Reject</button></div></div>`;
    }).join('')||'<p class="text-xs text-slate-400">No pending Easypaisa payments.</p>'
    : '';
  document.querySelectorAll('.payment-review').forEach(button=>{
    button.onclick=()=>reviewEasypaisaPayment(button.dataset.id,button.dataset.approve==='true');
  });
}

async function reviewEasypaisaPayment(paymentId,approve){
  if(!requireAdmin())return;
  try{
    const {error}=await state.supabase.rpc('review_easypaisa_payment',{
      p_payment_id:paymentId,
      p_approve:approve
    });
    if(error)throw error;
    await loadSupabaseData();
    toast(approve?'Payment verified and exact amount credited.':'Payment rejected.');
  }catch(error){
    toast(error.message,'error');
  }
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
  if(state.session?.user?.id!==userId)return;
  state.profile = data;
  state.isAdmin = isOwnerEmail(state.session?.user?.email);
  state.activeUserId = userId;
  state.users = [data];
}

async function applyAuthenticatedSession(session) {
  state.session = session;
  if (!session?.user) {
    state.sessionUserId=null;
    state.sessionLoad=null;
    state.profile=null;
    state.isAdmin=false;
    $('auth-screen').classList.remove('hidden');
    $('auth-screen').classList.add('grid');
    $('account-info').classList.add('hidden');
    $('logout-btn').classList.add('hidden');
    applyRoleView();
    return;
  }
  const userId=session.user.id;
  if(state.sessionUserId===userId&&state.profile){
    state.session=session;
    return;
  }
  state.sessionUserId=userId;
  state.isAdmin=isOwnerEmail(session.user.email);
  if(state.profile?.id!==userId){
    state.profile={
      id:userId,
      email:session.user.email,
      full_name:session.user.user_metadata?.full_name||session.user.email,
      role:'user',
      paid_balance:0,
      total_sessions:0
    };
  }
  state.users=[state.profile];
  state.activeUserId=userId;
  $('auth-screen').classList.add('hidden');
  $('auth-screen').classList.remove('grid');
  $('account-info').classList.remove('hidden');
  $('logout-btn').classList.remove('hidden');
  renderAuthenticatedAccount();
  applyRoleView();
  switchMobileTab('scan');

  const promise=(async()=>{
    try{
      await loadProfile(userId);
      renderAuthenticatedAccount();
      applyRoleView();
    }catch(error){
      toast(`Profile data is unavailable: ${error.message}`,'error');
    }
    try{
      await loadSupabaseData();
    }catch(error){
      toast(`App data is unavailable: ${error.message}`,'error');
    }
  })();
  state.sessionLoad={userId,promise};
  promise.finally(()=>{
    if(state.sessionLoad?.promise===promise)state.sessionLoad=null;
  });
}

function renderAuthenticatedAccount() {
  if (!state.profile) return;
  $('account-name').textContent = state.profile.full_name || state.profile.email;
  $('account-wallet').textContent = 'Rs. ' + fmt(state.profile.paid_balance);
  $('app-user-name').textContent = state.profile.full_name || 'RideaseVX User';
  $('app-user-email').textContent = state.profile.email || state.session?.user?.email || 'Verified driver';
  $('user-avatar').textContent = initials(state.profile.full_name);
  renderWallet();
}

function applyRoleView() {
  const adminModeButton = document.querySelector('[data-mode="admin"]');
  const isAdmin=hasOwnerAdminAccess();
  if (adminModeButton) adminModeButton.classList.toggle('hidden', !isAdmin);
  $('admin-panel').classList.toggle('hidden',!isAdmin||state.mode==='mobile');
  if (!isAdmin) {
    setViewMode('mobile');
  }else{
    setViewMode(state.mode==='mobile'?'mobile':'split');
  }
}

async function logout(signOutFromSupabase = true) {
  await stopQrScanner();
  if (signOutFromSupabase && state.supabase) await state.supabase.auth.signOut();
  state.session = null;
  state.sessionUserId=null;
  state.sessionLoad=null;
  state.profile = null;
  state.isAdmin = false;
  $('auth-screen').classList.remove('hidden');
  $('auth-screen').classList.add('grid');
  $('account-info').classList.add('hidden');
  $('logout-btn').classList.add('hidden');
  document.querySelector('[data-mode="admin"]')?.classList.add('hidden');
  $('admin-panel').classList.add('hidden');
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
  if (!requireAdmin()) return;
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
  if (!requireAdmin()) return;
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
  if (!requireAdmin()) return;
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
}

async function productionInit() {
  seedDemo();
  bindUI();
  bindProductionUI();
  setInterval(updateClock, 1000);
  updateClock();
  setupInstallSupport();
  renderEasypaisaDetails();
  syncPaymentAmount();
  $('admin-panel').classList.add('hidden');
  document.querySelector('[data-mode="admin"]').classList.add('hidden');
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
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
        storageKey: `rideasevx-${new URL(url).hostname}-auth-token`
      }
    });
    state.configured = true;
    state.demoMode = false;
    localStorage.setItem('voltsync_url', url);
    localStorage.setItem('voltsync_key', key);
    $('backend-status').textContent = 'Supabase + Realtime';
    $('backend-status').className = 'text-xs font-mono text-emerald-400';
    $('backend-dot').className = 'relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 status-dot';

    state.authSubscription?.unsubscribe();
    const {data:{subscription}}=state.supabase.auth.onAuthStateChange((event, session) => {
      if(event==='TOKEN_REFRESHED'){
        state.session=session;
        return;
      }
      if(event==='SIGNED_IN'){
        setTimeout(()=>applyAuthenticatedSession(session).catch(error=>toast(error.message,'error')),0);
      }
      if (event === 'SIGNED_OUT') setTimeout(() => logout(false), 0);
    });
    state.authSubscription=subscription;

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
