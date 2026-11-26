/* RideaseVX — demo mode + Supabase v2 integration */
'use strict';

// Browser-safe Supabase configuration for the deployed app.
const SUPABASE_URL = 'https://atucbucsqqtadfgzowiy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_2ShhTVhq7BKaEezETih2jg_xbTa3ggf';
const AUTH_REDIRECT_URL = 'https://mir63059.github.io/voltsync-ev/';
const EASYPAISA_ACCOUNT_TITLE = 'Jahandad Dad';
const EASYPAISA_ACCOUNT_NUMBER = '03423715266';
const EASYPAISA_QR_IMAGE = './easypaisa-qr.png';
const OWNER_ADMIN_EMAIL = 'mir.63059@iqra.edu.pk';
const REALTIME_CHANNEL_NAME = 'rideasevx-live';

const isOwnerEmail = email => String(email || '').trim().toLowerCase() === OWNER_ADMIN_EMAIL.toLowerCase();
const hasOwnerAdminAccess = () => isOwnerEmail(state.session?.user?.email);
// Never place a Supabase secret/service-role key in this file.

const DEMO_USERS = [
  { id: 'demo-1', full_name: 'Ali Khan', initials: 'AK', paid_balance: 0, total_sessions: 0 },
  { id: 'demo-2', full_name: 'Sara Ahmed', initials: 'SA', paid_balance: 0, total_sessions: 0 },
  { id: 'demo-3', full_name: 'Usman Tariq', initials: 'UT', paid_balance: 0, total_sessions: 0 }
];

const state = {
  supabase: null,
  configured: false,
  activeUserId: 'demo-1',
  selectedChargerId: 'CHG-001',
  tariff: 65,
  users: structuredClone(DEMO_USERS),
  chargers: [],
  sessions: [],
  transactions: [],
  paymentRequests: [],
  charging: false,
  activeDbSession: null,
  startedAt: null,
  timer: null,
  tick: null,
  activeSessionId: null,
  settlingSessionId: null,
  autoStopSessionId: null,
  lastBilledAmount: 0,
  sessionBudget: 0,
  sessionUnitRate: 0,
  sessionStartingBatteryPct: 0,
  session: null,
  profile: null,
  authMode: 'login',
  isAdmin: false,
  demoMode: false,
  qrScanner: null,
  currentQrId: null,
  realtimeChannel: null,
  authSubscription: null,
  sessionUserId: null,
  sessionLoad: null
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 });
const fmtEnergy = (n) => Number(n || 0).toLocaleString('en-PK', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const roundMoney = (amount) => Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

function parseBatteryPct(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : 0;
}

function parseTimestampMs(raw) {
  if (!raw) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function hideConfigUI() {
  const openBtn = $('open-config');
  const modal = $('config-modal');
  if (openBtn) {
    openBtn.classList.add('hidden');
    openBtn.style.display = 'none';
  }
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('grid');
    modal.style.display = 'none';
  }
}

let deferredInstallPrompt = null;

function toast(message, type = 'success') {
  const container = $('toast');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `fade-in px-4 py-3 rounded-xl text-xs font-semibold border shadow-xl ${
    type === 'error'
      ? 'bg-red-950 border-red-700 text-red-300'
      : 'bg-slate-900 border-emerald-500/30 text-emerald-300'
  }`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  const button = $('install-app');
  if (button) {
    button.textContent = 'Install App';
    button.classList.remove('hidden');
    $('install-help')?.classList.add('hidden');
  }
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  $('install-app')?.classList.add('hidden');
  $('install-help')?.classList.add('hidden');
});

function consoleLog(packet, type = 'IN') {
  if (!hasOwnerAdminAccess()) return;
  const box = $('console');
  if (!box) return;
  const el = document.createElement('div');
  const time = new Date().toLocaleTimeString('en-PK');
  const body = typeof packet === 'string' ? escapeHtml(packet) : escapeHtml(JSON.stringify(packet));
  el.innerHTML = `<span class="text-slate-500">${escapeHtml(time)}</span> <span class="${
    type === 'OUT' ? 'text-amber-400' : 'text-emerald-400'
  }">${type}</span> <span class="text-slate-300">${body}</span>`;
  box.prepend(el);
}

function seedDemo() {
  state.chargers = [
    { id: 'CHG-001', name: 'Main Gate Fast Charger', location: 'Karachi Station 1', status: 'online', voltage: 0, current: 0, power_kw: 0, current_kwh: 0, battery_pct: 0, active_user_id: null },
    { id: 'CHG-002', name: 'Shopping Mall Charger', location: 'Karachi Station 2', status: 'online', voltage: 0, current: 0, power_kw: 0, current_kwh: 0, battery_pct: 0, active_user_id: null },
    { id: 'CHG-003', name: 'Airport Express Charger', location: 'Karachi Station 3', status: 'offline', voltage: 0, current: 0, power_kw: 0, current_kwh: 0, battery_pct: 0, active_user_id: null }
  ];
  state.sessions = [];
  state.paymentRequests = [];
}

function initials(name) {
  return String(name || 'EV')
    .split(/\s+/)
    .filter(Boolean)
    .map(s => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function requireAdmin() {
  if (hasOwnerAdminAccess() && state.configured) return true;
  toast('Administrator access is required.', 'error');
  return false;
}

function removeAdminPanel() {
  $('admin-panel')?.classList.add('hidden');
}

function showAdminPanelIfOwner() {
  if (!hasOwnerAdminAccess() || !state.configured) {
    removeAdminPanel();
    return;
  }
  $('admin-panel')?.classList.remove('hidden');
  renderAdmin();
}

async function init() {
  seedDemo();
  bindUI();
  hideConfigUI();
  await renderEasypaisaDetails();
  const savedUrl = (localStorage.getItem('voltsync_url') || '').trim();
  const savedKey = (localStorage.getItem('voltsync_key') || '').trim();
  const hasSavedConfig = Boolean(savedUrl && savedKey);
  const url = hasSavedConfig ? savedUrl : SUPABASE_URL;
  const key = hasSavedConfig ? savedKey : SUPABASE_ANON_KEY;
  if ($('supabase-url')) $('supabase-url').value = url;
  if ($('supabase-key')) $('supabase-key').value = key;
  localStorage.setItem('voltsync_url', url);
  localStorage.setItem('voltsync_key', key);
  await connectSupabase(url, key, false);
  hideConfigUI();
  if (!state.tick) {
    state.tick = setInterval(updateChargingMeter, 1000);
  }
  setInterval(updateClock, 1000);
  updateClock();
}

function setDemoMode() {
  if (state.realtimeChannel && state.supabase) {
    state.supabase.removeChannel(state.realtimeChannel);
  }
  state.authSubscription?.data?.subscription?.unsubscribe?.();
  state.authSubscription?.unsubscribe?.();
  state.configured = false;
  state.supabase = null;
  state.demoMode = true;
  state.session = null;
  state.sessionUserId = null;
  state.sessionLoad = null;
  state.authSubscription = null;
  state.realtimeChannel = null;
  state.profile = null;
  state.isAdmin = false;
  state.activeDbSession = null;
  state.charging = false;
  state.startedAt = null;
  state.settlingSessionId = null;
  state.autoStopSessionId = null;
  state.paymentRequests = [];
  state.sessions = [];
  state.users = structuredClone(DEMO_USERS);
  seedDemo();
  hideConfigUI();
  $('auth-screen')?.classList.remove('hidden');
  $('auth-screen')?.classList.add('grid');
  $('account-info')?.classList.add('hidden');
  $('logout-btn')?.classList.add('hidden');
  removeAdminPanel();
  $('role-badge')?.classList.add('hidden');
  if ($('workspace')) $('workspace').className = 'grid grid-cols-1 gap-6';
  if ($('mobile-panel')) $('mobile-panel').className = 'flex justify-center';
  renderAll();
  consoleLog({ mode: 'demo', status: 'authentication-required; charging-disabled' }, 'IN');
}

async function applySessionState(session) {
  state.session = session || null;
  const user = state.session?.user || null;
  state.sessionUserId = user?.id || null;
  state.isAdmin = Boolean(user && isOwnerEmail(user.email));
  state.demoMode = false;
  hideConfigUI();

  if (user) {
    $('auth-screen')?.classList.add('hidden');
    $('auth-screen')?.classList.remove('grid');
    $('account-info')?.classList.remove('hidden');
    $('logout-btn')?.classList.remove('hidden');
    if ($('account-email')) $('account-email').textContent = user.email || '';
    if ($('role-badge')) {
      $('role-badge').classList.remove('hidden');
      $('role-badge').textContent = state.isAdmin ? 'ADMIN' : 'USER';
    }
    if ($('workspace')) {
      $('workspace').className = state.isAdmin
        ? 'grid grid-cols-1 lg:grid-cols-12 gap-6'
        : 'grid grid-cols-1 gap-6';
    }
    if ($('mobile-panel')) {
      $('mobile-panel').className = state.isAdmin
        ? 'lg:col-span-5 flex justify-center'
        : 'flex justify-center';
    }
    if (state.isAdmin) showAdminPanelIfOwner();
    else removeAdminPanel();
  } else {
    state.profile = null;
    state.activeDbSession = null;
    state.charging = false;
    state.startedAt = null;
    $('auth-screen')?.classList.remove('hidden');
    $('auth-screen')?.classList.add('grid');
    $('account-info')?.classList.add('hidden');
    $('logout-btn')?.classList.add('hidden');
    $('role-badge')?.classList.add('hidden');
    removeAdminPanel();
    if ($('workspace')) $('workspace').className = 'grid grid-cols-1 gap-6';
    if ($('mobile-panel')) $('mobile-panel').className = 'flex justify-center';
  }

  await loadSupabaseData();
  hideConfigUI();
}

async function connectSupabase(url, key, notify = true) {
  try {
    if (!window.supabase) throw new Error('Supabase library failed to load');
    if (state.realtimeChannel && state.supabase) {
      state.supabase.removeChannel(state.realtimeChannel);
    }
    state.authSubscription?.data?.subscription?.unsubscribe?.();
    state.authSubscription?.unsubscribe?.();

    state.supabase = window.supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    state.configured = true;
    localStorage.setItem('voltsync_url', url);
    localStorage.setItem('voltsync_key', key);

    state.authSubscription = state.supabase.auth.onAuthStateChange((_event, session) => {
      state.sessionLoad = applySessionState(session);
    });

    const { data: { session } } = await state.supabase.auth.getSession();
    state.sessionLoad = applySessionState(session);
    await state.sessionLoad;

    subscribeRealtime();
    hideConfigUI();
    if (notify) toast('Connected to Supabase');
  } catch (error) {
    toast(error.message, 'error');
    setDemoMode();
  }
}

async function connectProductionSupabase(url, key) {
  await connectSupabase(url, key, true);
}

async function loadSupabaseData() {
  if (!state.configured || !state.supabase) return;
  const sb = state.supabase;
  const requestedUserId = state.session?.user?.id || null;
  const isAdmin = hasOwnerAdminAccess();

  const profilesRequest = state.session
    ? sb.from('profiles').select('id,email,full_name,phone,role,paid_balance,total_sessions,created_at').order('full_name')
    : Promise.resolve({ data: [], error: null });

  let sessionsQuery = state.session ? sb.from('sessions').select('*') : null;
  if (sessionsQuery && !isAdmin) {
    sessionsQuery = sessionsQuery.eq('user_id', state.session.user.id);
  }
  const sessionsRequest = sessionsQuery
    ? sessionsQuery.order('started_at', { ascending: false }).limit(isAdmin ? 500 : 100)
    : Promise.resolve({ data: [], error: null });

  const paymentsRequest = state.session
    ? sb.from('easypaisa_payment_requests').select('*').order('created_at', { ascending: false }).limit(isAdmin ? 200 : 20)
    : Promise.resolve({ data: [], error: null });

  const [chargers, settings, profiles, sessions, payments] = await Promise.all([
    sb.from('stations').select('*').order('id'),
    sb.from('system_settings').select('*').eq('id', 1).maybeSingle(),
    profilesRequest,
    sessionsRequest,
    paymentsRequest
  ]);

  if (requestedUserId !== (state.session?.user?.id || null)) return;

  if (chargers.error) toast(`Stations could not be loaded: ${chargers.error.message}`, 'error');
  else if (chargers.data?.length) state.chargers = chargers.data;

  if (settings.error) toast(`Tariff could not be loaded: ${settings.error.message}`, 'error');
  else if (settings.data?.unit_rate_pkr != null) state.tariff = Number(settings.data.unit_rate_pkr);

  if (profiles.error) {
    toast(`Profiles could not be loaded: ${profiles.error.message}`, 'error');
  } else if (profiles.data) {
    state.users = profiles.data;
    const ownProfile = profiles.data.find(profile => profile.id === requestedUserId);
    if (ownProfile) state.profile = ownProfile;
  }

  if (sessions.error) toast(`Charging sessions could not be loaded: ${sessions.error.message}`, 'error');
  else if (sessions.data) state.sessions = sessions.data;

  if (payments.error) {
    state.paymentRequests = [];
    toast(`Payment history is unavailable: ${payments.error.message}`, 'error');
  } else if (payments.data) {
    state.paymentRequests = payments.data;
  }

  syncActiveSession();
  renderAll();
}

function subscribeRealtime() {
  if (!state.configured || !state.supabase) return;
  if (state.realtimeChannel) {
    state.supabase.removeChannel(state.realtimeChannel);
  }
  state.realtimeChannel = state.supabase
    .channel(REALTIME_CHANNEL_NAME)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stations' }, payload => {
      upsertRealtime('stations', payload);
      consoleLog({ table: 'stations', event: payload.eventType, row: payload.new || payload.old }, 'IN');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, payload => {
      upsertRealtime('sessions', payload);
      consoleLog({ table: 'sessions', event: payload.eventType, row: payload.new || payload.old }, 'IN');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, payload => {
      upsertRealtime('profiles', payload);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'easypaisa_payment_requests' }, payload => {
      upsertPaymentRequest(payload);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'system_settings' }, payload => {
      if (payload.new?.unit_rate_pkr != null) state.tariff = Number(payload.new.unit_rate_pkr);
      renderAll();
      consoleLog({ table: 'system_settings', unit_rate_pkr: payload.new?.unit_rate_pkr }, 'IN');
    })
    .subscribe(status => consoleLog({ channel: REALTIME_CHANNEL_NAME, status }, 'IN'));
}

function upsertRealtime(table, payload) {
  if (table === 'stations') {
    if (payload.eventType === 'DELETE') {
      state.chargers = state.chargers.filter(x => x.id !== payload.old.id);
    } else if (payload.new) {
      const i = state.chargers.findIndex(x => x.id === payload.new.id);
      if (i >= 0) state.chargers[i] = { ...state.chargers[i], ...payload.new };
      else state.chargers.push(payload.new);
    }
  }
  if (table === 'sessions') {
    if (payload.eventType === 'INSERT' && payload.new) {
      const exists = state.sessions.some(x => x.id === payload.new.id);
      if (!exists) state.sessions.unshift(payload.new);
    } else if (payload.eventType === 'DELETE' && payload.old) {
      state.sessions = state.sessions.filter(x => x.id !== payload.old.id);
    } else if (payload.new) {
      const i = state.sessions.findIndex(x => x.id === payload.new.id);
      if (i >= 0) state.sessions[i] = { ...state.sessions[i], ...payload.new };
      else state.sessions.unshift(payload.new);
    }
    syncActiveSession();
  }
  if (table === 'profiles' && payload.new?.id === state.session?.user?.id) {
    state.profile = payload.new;
    const idx = state.users.findIndex(u => u.id === payload.new.id);
    if (idx >= 0) state.users[idx] = payload.new;
    else state.users.push(payload.new);
  }
  renderAll();
}

function syncActiveSession() {
  const active = state.sessions.find(
    session => session.user_id === state.session?.user?.id && session.status === 'active'
  );
  state.activeDbSession = active || null;
  state.charging = Boolean(active);
  if (active) {
    state.selectedChargerId = active.station_id;
    state.sessionBudget = Number(active.budget_pkr || 0);
    state.sessionUnitRate = Number(active.unit_rate_pkr || 0);
    const parsedStart = parseTimestampMs(active.started_at);
    const serverDur = Math.max(0, Number(active.duration_seconds || 0));
    if (parsedStart !== null) {
      state.startedAt = parsedStart > Date.now() ? Date.now() - serverDur * 1000 : parsedStart;
    } else {
      state.startedAt = Date.now() - serverDur * 1000;
    }
    if (state.autoStopSessionId !== active.id) state.autoStopSessionId = null;
  } else {
    state.sessionBudget = 0;
    state.sessionUnitRate = 0;
    state.startedAt = null;
    state.autoStopSessionId = null;
  }
}

function upsertPaymentRequest(payload) {
  const request = payload.new || payload.old;
  if (!request) return;
  if (payload.eventType === 'DELETE') {
    state.paymentRequests = state.paymentRequests.filter(item => item.id !== request.id);
  } else {
    const index = state.paymentRequests.findIndex(item => item.id === request.id);
    if (index >= 0) state.paymentRequests[index] = { ...state.paymentRequests[index], ...request };
    else state.paymentRequests.unshift(request);
  }
  renderPaymentRequests();
}

function bindUI() {
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMobileTab(btn.dataset.tab));
  });

  if ($('close-config')) {
    $('close-config').onclick = hideConfigUI;
  }
  if ($('save-config')) {
    $('save-config').onclick = () => {
      const url = $('supabase-url')?.value.trim();
      const key = $('supabase-key')?.value.trim();
      if (!url || !key) return toast('URL and anon key are required', 'error');
      connectProductionSupabase(url, key);
    };
  }
  if ($('clear-config')) {
    $('clear-config').onclick = () => {
      localStorage.removeItem('voltsync_url');
      localStorage.removeItem('voltsync_key');
      if ($('supabase-url')) $('supabase-url').value = '';
      if ($('supabase-key')) $('supabase-key').value = '';
      hideConfigUI();
      setDemoMode();
    };
  }

  if ($('auth-form')) $('auth-form').onsubmit = handleAuthSubmit;
  if ($('logout-btn')) $('logout-btn').onclick = handleLogout;
  if ($('toggle-charge')) $('toggle-charge').onclick = toggleCharging;
  if ($('payment-form')) $('payment-form').onsubmit = submitEasypaisaPayment;
  if ($('payment-amount')) $('payment-amount').onchange = syncPaymentAmount;
  if ($('payment-custom-amount')) $('payment-custom-amount').oninput = syncPaymentAmount;

  if ($('budget-select')) {
    $('budget-select').onchange = () => {
      const isCustom = $('budget-select').value === 'custom';
      $('custom-budget-wrap')?.classList.toggle('hidden', !isCustom);
      if (!isCustom && $('custom-budget')) $('custom-budget').value = '';
      updateBudgetHint();
    };
  }
  if ($('custom-budget')) $('custom-budget').oninput = updateBudgetHint;
  if ($('change-charger')) $('change-charger').onclick = () => switchMobileTab('scan');

  if ($('save-tariff')) $('save-tariff').onclick = updateTariff;
  if ($('add-charger')) $('add-charger').onclick = addCharger;
  if ($('close-qr')) {
    $('close-qr').onclick = () => {
      $('qr-modal')?.classList.add('hidden');
      $('qr-modal')?.classList.remove('grid');
    };
  }
  if ($('print-qr')) $('print-qr').onclick = () => window.print();
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!state.configured || !state.supabase) {
    return toast('Supabase is not configured yet.', 'error');
  }
  const email = $('auth-email')?.value.trim() || '';
  const password = $('auth-password')?.value || '';
  if (!email || !password) return toast('Email and password are required.', 'error');

  const submitBtn = $('auth-submit');
  if (submitBtn) submitBtn.disabled = true;
  try {
    if (state.authMode === 'signup') {
      const fullName = $('auth-name')?.value.trim() || '';
      const phone = $('auth-phone')?.value.trim() || '';
      const { error } = await state.supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: AUTH_REDIRECT_URL,
          data: { full_name: fullName, phone }
        }
      });
      if (error) throw error;
      toast('Account created. Check your email if confirmation is enabled.');
    } else {
      const { error } = await state.supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      toast('Signed in successfully.');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function handleLogout() {
  if (!state.supabase) return setDemoMode();
  const { error } = await state.supabase.auth.signOut();
  if (error) return toast(error.message, 'error');
  await applySessionState(null);
  toast('Signed out');
}

function switchMobileTab(tab) {
  document.querySelectorAll('.mobile-tab').forEach(el => el.classList.add('hidden'));
  $('tab-' + tab)?.classList.remove('hidden');
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

function switchUser(id) {
  if (!requireAdmin()) return;
  state.activeUserId = id;
  const user = getActiveUser();
  if ($('user-avatar') && user) {
    $('user-avatar').textContent = user.initials || initials(user.full_name || 'U');
  }
  renderWallet();
  renderHistory();
}

function getActiveUser() {
  return (
    state.users.find(u => u.id === state.session?.user?.id) ||
    state.users.find(u => u.id === state.activeUserId) ||
    state.profile ||
    null
  );
}

function renderAll() {
  renderChargerList();
  renderAdmin();
  renderWallet();
  renderMeter();
  renderHistory();
  renderPaymentRequests();
}

function renderWallet() {
  const u = getActiveUser();
  if ($('wallet')) $('wallet').textContent = 'Rs. ' + fmt(u?.paid_balance || 0);
  updateBudgetHint();
  if (state.profile && $('account-wallet')) {
    $('account-wallet').textContent = 'Rs. ' + fmt(state.profile.paid_balance || 0);
  }
}

function readBudgetAmount() {
  const selectEl = $('budget-select');
  if (!selectEl) return null;
  const selected = selectEl.value;
  if (!selected) return null;
  const raw = selected === 'custom' ? $('custom-budget')?.value : selected;
  if (raw === '' || raw == null) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0.01 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
    return null;
  }
  return roundMoney(amount);
}

function updateBudgetHint() {
  const user = getActiveUser();
  const balance = roundMoney(Number(user?.paid_balance || 0));
  const budget = readBudgetAmount();
  if ($('budget-wallet')) $('budget-wallet').textContent = `Available: Rs. ${fmt(balance)}`;
  if (!$('budget-help')) return;
  if (!budget) {
    $('budget-help').textContent = $('budget-select')?.value === 'custom'
      ? 'Enter a valid amount of at least Rs. 0.01.'
      : 'Choose a budget before starting.';
    return;
  }
  if (budget > balance) {
    $('budget-help').textContent = 'Budget exceeds your current wallet balance.';
    return;
  }
  const rate = Number(state.tariff);
  $('budget-help').textContent = rate > 0
    ? `Cap: Rs. ${fmt(budget)} • about ${fmtEnergy(budget / rate)} kWh at Rs. ${fmt(rate)}/kWh`
    : `Cap: Rs. ${fmt(budget)}`;
}

function renderChargerList() {
  const list = $('charger-list');
  if (!list) return;
  list.innerHTML = state.chargers.map(c => {
    const online = isChargerOnline(c);
    const status = c.status === 'disabled'
      ? 'Disabled'
      : !online
        ? 'Offline'
        : c.status === 'charging'
          ? 'Charging'
          : 'Available';
    const unavailable = status === 'Offline' || status === 'Disabled';
    const color = status === 'Charging' ? 'text-emerald-400' : unavailable ? 'text-slate-500' : 'text-cyan-400';
    return `<button data-charge-id="${escapeHtml(c.id)}" class="charger-row w-full text-left bg-slate-900/90 border border-slate-800 hover:border-emerald-500/40 rounded-xl p-3 flex justify-between items-center ${unavailable ? 'opacity-60' : ''}"><div><div class="flex gap-2"><span class="font-mono text-xs font-bold text-emerald-400">${escapeHtml(c.id)}</span><span class="text-[10px] ${color}">${status}</span></div><div class="text-xs font-semibold mt-1">${escapeHtml(c.name)}</div><div class="text-[10px] text-slate-400">${escapeHtml(c.location)} • ${fmt(state.tariff)} PKR/kWh</div></div><span class="text-slate-500">›</span></button>`;
  }).join('') || '<p class="text-xs text-slate-500">No chargers configured</p>';

  document.querySelectorAll('.charger-row').forEach(btn => {
    btn.onclick = () => selectCharger(btn.dataset.chargeId);
  });
}

function isChargerOnline(charger) {
  if (!charger || charger.status === 'offline' || charger.status === 'disabled') return false;
  if (charger.status === 'charging') return true;
  const lastSeenRaw = charger.device_last_seen_at || charger.updated_at || '';
  const seenAt = parseTimestampMs(lastSeenRaw);
  if (seenAt === null) return true;
  return Date.now() - seenAt < 60000;
}

function selectCharger(id) {
  if (state.charging) return toast('Stop the active session before changing chargers', 'error');
  const c = state.chargers.find(x => x.id === id);
  if (!c) return;
  if (c.status === 'disabled' || !isChargerOnline(c)) return toast('This charger is not available', 'error');
  state.selectedChargerId = id;
  if ($('app-charger-code')) $('app-charger-code').textContent = c.id;
  if ($('app-charger-name')) $('app-charger-name').textContent = c.name;
  if ($('app-charger-loc')) $('app-charger-loc').textContent = `${c.location} • ${fmt(state.tariff)} PKR/kWh`;
  switchMobileTab('charge');
}

async function toggleCharging() {
  if (!state.configured || !state.session?.user) {
    return toast('Sign in to a configured Supabase project before charging.', 'error');
  }
  const c = state.chargers.find(x => x.id === state.selectedChargerId);
  if (!c) return;
  if (state.charging) return stopCharging('User stopped session');
  if (c.status === 'disabled' || !isChargerOnline(c) || c.status === 'charging') {
    return toast('Charger unavailable.', 'error');
  }
  const budget = readBudgetAmount();
  const balance = roundMoney(Number(getActiveUser()?.paid_balance || 0));
  if (!budget) return toast('Choose a valid charging budget first', 'error');
  if (budget > balance) return toast('Budget exceeds your verified paid balance.', 'error');

  if ($('toggle-charge')) $('toggle-charge').disabled = true;
  try {
    const { error } = await state.supabase.rpc('start_charging_session', {
      p_station_id: c.id,
      p_budget_pkr: budget
    });
    if (error) throw error;
    await loadSupabaseData();
    if ($('payment-message')) $('payment-message').textContent = '';
    toast(`Charging started with a maximum spend of Rs. ${fmt(budget)}.`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if ($('toggle-charge')) $('toggle-charge').disabled = false;
    renderChargingControls();
  }
}

async function stopCharging(reason, notification = null) {
  const session = state.activeDbSession;
  if (!session || !state.configured || state.settlingSessionId === session.id) return;
  state.settlingSessionId = session.id;
  if ($('toggle-charge')) $('toggle-charge').disabled = true;
  try {
    const { data, error } = await state.supabase.rpc('complete_charging_session', {
      p_station_id: session.station_id,
      p_reason: reason || 'User stopped session'
    });
    if (error) throw error;
    await loadSupabaseData();
    const billed = Number(data?.bill_pkr || 0);
    toast(notification || `Charging stopped • Rs. ${fmt(billed)} used; unused balance returned.`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (state.settlingSessionId === session.id) state.settlingSessionId = null;
    if ($('toggle-charge')) $('toggle-charge').disabled = false;
    renderChargingControls();
  }
}

function renderMeter() {
  const c = state.chargers.find(x => x.id === state.selectedChargerId) || state.chargers[0];
  if (!c) return;

  const serverDuration = Math.max(0, Number(state.activeDbSession?.duration_seconds || 0));
  const localElapsed = state.startedAt != null
    ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))
    : 0;
  const elapsed = state.activeDbSession ? Math.max(0, Math.max(serverDuration, localElapsed)) : 0;

  const batteryPct = parseBatteryPct(c.battery_pct);
  const voltage = Number.isFinite(Number(c.voltage)) ? Math.max(0, Number(c.voltage)) : 0;
  const current = Number.isFinite(Number(c.current)) ? Math.max(0, Number(c.current)) : 0;
  const kwh = Number.isFinite(Number(c.current_kwh)) ? Math.max(0, Number(c.current_kwh)) : 0;
  const powerKw = c.power_kw != null && Number.isFinite(Number(c.power_kw))
    ? Math.max(0, Number(c.power_kw))
    : (voltage * current) / 1000;

  if ($('session-duration')) $('session-duration').textContent = secondsToHMS(elapsed);
  if ($('battery-pct')) $('battery-pct').textContent = String(Math.round(batteryPct));
  if ($('battery-unit')) $('battery-unit').classList.remove('hidden');
  if ($('battery-bar')) $('battery-bar').style.width = batteryPct + '%';
  if ($('voltage')) $('voltage').textContent = fmt(voltage) + ' V';
  if ($('current')) $('current').textContent = fmt(current) + ' A';
  if ($('kwh')) $('kwh').textContent = fmtEnergy(kwh) + ' kWh';

  const bill = state.activeDbSession
    ? Math.max(0, Number(state.activeDbSession.total_bill_pkr || 0))
    : Math.max(0, kwh * Number(state.tariff || 0));
  if ($('bill')) $('bill').textContent = 'Rs. ' + fmt(bill);
  if ($('power')) $('power').textContent = fmt(powerKw) + ' kW';

  const telemetryStatus = $('telemetry-status');
  if (telemetryStatus) {
    const hasTelemetry = voltage > 0 && isChargerOnline(c);
    telemetryStatus.classList.toggle('hidden', !state.activeDbSession);
    telemetryStatus.textContent = state.activeDbSession
      ? (hasTelemetry ? 'Live charger telemetry received.' : 'Waiting for trusted charger telemetry.')
      : '';
  }
  renderChargingControls();
}

function updateChargingMeter() {
  if (!state.activeDbSession) return;
  renderMeter();
  const charger = state.chargers.find(item => item.id === state.activeDbSession.station_id);
  const batteryPct = parseBatteryPct(charger?.battery_pct);
  if (batteryPct !== null && batteryPct >= 100 && state.autoStopSessionId !== state.activeDbSession.id) {
    state.autoStopSessionId = state.activeDbSession.id;
    void stopCharging('Battery reached 100%');
  }
}

function renderChargingControls() {
  const active = state.activeDbSession;
  const btn = $('toggle-charge');
  if (!btn) return;
  btn.textContent = active ? '■ STOP CHARGING' : '⚡ START CHARGING';
  btn.classList.toggle('bg-red-500', Boolean(active));
  btn.classList.toggle('bg-emerald-500', !active);
  btn.classList.toggle('text-white', Boolean(active));
  btn.classList.toggle('text-slate-950', !active);
  if ($('budget-select')) $('budget-select').disabled = Boolean(active);
  if ($('custom-budget')) $('custom-budget').disabled = Boolean(active);
  if (active) {
    if ($('budget-help')) {
      $('budget-help').textContent = `Reserved: Rs. ${fmt(active.budget_pkr)} • used: Rs. ${fmt(active.total_bill_pkr)}. Remaining reserved balance is refunded when stopped.`;
    }
    if ($('app-charger-code')) $('app-charger-code').textContent = active.station_id;
  }
}

function secondsToHMS(s) {
  const safe = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const sec = safe % 60;
  return [h, m, sec].map(x => String(x).padStart(2, '0')).join(':');
}

function renderHistory() {
  const list = $('history-list');
  if (!list) return;
  const userId = state.session?.user?.id || getActiveUser()?.id;
  const sessions = state.sessions.filter(s => s.user_id === userId);
  if ($('history-count')) $('history-count').textContent = sessions.length + ' Sessions';
  list.innerHTML = sessions.slice(0, 20).map(s => `<div class="bg-slate-900 border border-slate-800 rounded-xl p-3"><div class="flex justify-between"><span class="font-mono text-xs text-emerald-400">${escapeHtml(s.session_code || 'SESSION')}</span><span class="text-[10px] px-2 py-0.5 rounded-full ${s.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-800 text-slate-400'}">${escapeHtml(s.status)}</span></div><div class="mt-2 flex justify-between text-xs"><span>${escapeHtml(s.station_id || '-')}</span><b class="text-emerald-400">Rs. ${fmt(s.total_bill_pkr || 0)}</b></div><div class="mt-1 text-[10px] text-slate-400">${fmtEnergy(s.energy_kwh || 0)} kWh • ${secondsToHMS(s.duration_seconds || 0)}</div></div>`).join('') || '<div class="text-xs text-slate-500 text-center py-8">No charging sessions yet</div>';
}

function renderAdmin() {
  if (!hasOwnerAdminAccess() || !$('admin-panel')) return;
  const active = state.chargers.filter(c => c.status === 'charging').length;
  const energy = state.sessions
    .filter(s => s.status === 'completed')
    .reduce((n, s) => n + Number(s.energy_kwh || 0), 0);
  const revenue = state.sessions
    .filter(s => s.status === 'completed')
    .reduce((n, s) => n + Number(s.total_bill_pkr || 0), 0);

  if ($('kpi-users')) $('kpi-users').textContent = fmt(state.users.length);
  if ($('kpi-boxes')) $('kpi-boxes').textContent = String(state.chargers.length);
  if ($('kpi-active')) $('kpi-active').textContent = String(active);
  if ($('kpi-energy')) $('kpi-energy').textContent = fmt(energy) + ' kWh';
  if ($('kpi-revenue')) $('kpi-revenue').textContent = 'Rs. ' + fmt(revenue);
  if ($('kpi-tariff')) $('kpi-tariff').textContent = 'Rs. ' + fmt(state.tariff);
  if ($('tariff-input')) $('tariff-input').value = state.tariff;

  const tbody = $('telemetry-table');
  if (!tbody) return;
  tbody.innerHTML = state.chargers.map(c => {
    const u = state.users.find(x => x.id === c.active_user_id);
    const st = c.status === 'charging'
      ? 'text-emerald-400'
      : c.status === 'offline' || c.status === 'disabled'
        ? 'text-slate-500'
        : 'text-cyan-400';
    const batteryVal = parseBatteryPct(c.battery_pct);
    const battery = `${Math.round(batteryVal)}%`;
    const volt = Number.isFinite(Number(c.voltage)) ? Math.max(0, Number(c.voltage)) : 0;
    const curr = Number.isFinite(Number(c.current)) ? Math.max(0, Number(c.current)) : 0;
    const pwr = c.power_kw != null && Number.isFinite(Number(c.power_kw))
      ? Math.max(0, Number(c.power_kw))
      : (volt * curr) / 1000;
    return `<tr class="border-b border-slate-800/70"><td class="p-3"><b class="font-mono text-emerald-400">${escapeHtml(c.id)}</b><div class="text-slate-500">${escapeHtml(c.name)}</div></td><td class="${st}">${escapeHtml(c.status)}</td><td class="font-mono">${fmt(volt)} V</td><td class="font-mono">${fmt(curr)} A</td><td class="font-mono">${fmt(pwr)} kW</td><td class="font-mono">${fmtEnergy(c.current_kwh)} kWh</td><td>${escapeHtml(battery)}</td><td>${escapeHtml(u?.full_name || '-')}</td><td><div class="flex flex-wrap gap-1"><button class="admin-qr px-2 py-1 rounded bg-sky-500/15 text-sky-300" data-id="${escapeHtml(c.id)}">View / Print QR</button><button class="admin-stop px-2 py-1 rounded bg-red-500/15 text-red-400" data-id="${escapeHtml(c.id)}">Stop</button><button class="admin-disable px-2 py-1 rounded bg-slate-800 text-slate-300" data-id="${escapeHtml(c.id)}">${c.status === 'disabled' ? 'Enable' : 'Disable'}</button></div></td></tr>`;
  }).join('') || '<tr><td colspan="9" class="p-6 text-center text-slate-500">No chargers</td></tr>';

  document.querySelectorAll('.admin-stop').forEach(b => {
    b.onclick = () => adminOverride(b.dataset.id, 'stop');
  });
  document.querySelectorAll('.admin-disable').forEach(b => {
    b.onclick = () => adminOverride(b.dataset.id, 'disable');
  });
  document.querySelectorAll('.admin-qr').forEach(b => {
    b.onclick = () => openQrModal(b.dataset.id);
  });
}

function openQrModal(chargerId) {
  const c = state.chargers.find(x => x.id === chargerId);
  if (!c) return;
  state.currentQrId = c.id;
  if ($('qr-station-id')) $('qr-station-id').textContent = c.id;
  if ($('qr-station-name')) $('qr-station-name').textContent = `${c.name} — ${c.location}`;
  if ($('qr-modal')) {
    $('qr-modal').classList.remove('hidden');
    $('qr-modal').classList.add('grid');
  }
}

async function updateTariff() {
  if (!requireAdmin()) return;
  const value = Number($('tariff-input')?.value);
  if (!Number.isFinite(value) || value <= 0) return toast('Enter a valid tariff', 'error');
  const { error } = await state.supabase
    .from('system_settings')
    .update({ unit_rate_pkr: value, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) return toast(error.message, 'error');
  state.tariff = value;
  renderAll();
  consoleLog({ command: 'SET_TARIFF', unit_rate_pkr: value }, 'OUT');
  toast('Tariff updated');
}

async function addCharger() {
  if (!requireAdmin()) return;
  const id = $('new-charger-id')?.value.trim().toUpperCase() || '';
  const name = $('new-charger-name')?.value.trim() || '';
  const location = $('new-charger-location')?.value.trim() || '';
  if (!/^CHG-[0-9]+$/.test(id) || !name || !location) return toast('Enter valid charger details', 'error');
  const { error } = await state.supabase.from('stations').insert({
    id,
    name,
    location,
    status: 'online',
    voltage: 0,
    current: 0,
    power_kw: 0,
    current_kwh: 0,
    battery_pct: 0
  });
  if (error) return toast(error.message, 'error');
  if ($('new-charger-id')) $('new-charger-id').value = '';
  if ($('new-charger-name')) $('new-charger-name').value = '';
  if ($('new-charger-location')) $('new-charger-location').value = '';
  await loadSupabaseData();
  consoleLog({ command: 'PROVISION', charger_id: id, name, location }, 'OUT');
  toast(id + ' registered');
}

async function adminOverride(id, action) {
  if (!requireAdmin()) return;
  const c = state.chargers.find(x => x.id === id);
  if (!c) return;
  if (action === 'stop') {
    const { error } = await state.supabase.rpc('complete_charging_session', {
      p_station_id: id,
      p_reason: 'Admin stopped session'
    });
    if (error) return toast(error.message, 'error');
  } else if (action === 'disable') {
    const { error } = await state.supabase
      .from('stations')
      .update({ status: c.status === 'disabled' ? 'online' : 'disabled' })
      .eq('id', id);
    if (error) return toast(error.message, 'error');
  } else {
    return toast('Unknown admin action.', 'error');
  }
  await loadSupabaseData();
}

function updateClock() {
  const el = $('phone-clock');
  if (!el) return;
  const d = new Date();
  el.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isConfiguredEasypaisaAccount() {
  return EASYPAISA_ACCOUNT_TITLE !== 'YOUR_EASYPAISA_ACCOUNT_TITLE'
    && !EASYPAISA_ACCOUNT_TITLE.includes('YOUR_')
    && EASYPAISA_ACCOUNT_NUMBER !== '03XX-XXXXXXX'
    && /\d{8,}/.test(EASYPAISA_ACCOUNT_NUMBER.replace(/\D/g, ''));
}

async function renderEasypaisaDetails() {
  if ($('easypaisa-title')) {
    $('easypaisa-title').textContent = isConfiguredEasypaisaAccount()
      ? EASYPAISA_ACCOUNT_TITLE
      : 'Set EASYPAISA_ACCOUNT_TITLE in app.js';
  }
  if ($('easypaisa-number')) {
    $('easypaisa-number').textContent = isConfiguredEasypaisaAccount()
      ? EASYPAISA_ACCOUNT_NUMBER
      : 'Set EASYPAISA_ACCOUNT_NUMBER in app.js';
  }
  const image = $('easypaisa-qr');
  if (!image) return;
  image.classList.add('hidden');
  image.removeAttribute('src');
  if ($('easypaisa-qr-help')) {
    $('easypaisa-qr-help').textContent = isConfiguredEasypaisaAccount()
      ? 'Confirm the account name and amount in Easypaisa before sending.'
      : 'Payments are disabled until you configure your Easypaisa account details.';
  }
  if (!isConfiguredEasypaisaAccount()) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    if ($('easypaisa-qr-help')) {
      $('easypaisa-qr-help').textContent = 'QR preview requires the deployed app. Pay using the account details above.';
    }
    return;
  }
  image.onload = () => image.classList.remove('hidden');
  try {
    const response = await fetch(EASYPAISA_QR_IMAGE, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
      if ($('easypaisa-qr-help')) {
        $('easypaisa-qr-help').textContent = 'QR unavailable. Pay using the Easypaisa account details above.';
      }
      return;
    }
    image.src = EASYPAISA_QR_IMAGE;
  } catch {
    if ($('easypaisa-qr-help')) {
      $('easypaisa-qr-help').textContent = 'QR unavailable. Pay using the Easypaisa account details above.';
    }
  }
}

function selectedPaymentAmount() {
  const selectEl = $('payment-amount');
  if (!selectEl) return null;
  const raw = selectEl.value === 'custom'
    ? $('payment-custom-amount')?.value
    : selectEl.value;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
    return null;
  }
  return Math.round(amount * 100);
}

function syncPaymentAmount() {
  const isCustom = $('payment-amount')?.value === 'custom';
  $('payment-custom-amount')?.classList.toggle('hidden', !isCustom);
  const amount = selectedPaymentAmount();
  if ($('payment-paid-amount')) {
    $('payment-paid-amount').value = amount === null ? '' : (amount / 100).toFixed(2);
  }
}

async function submitEasypaisaPayment(event) {
  event.preventDefault();
  if (!state.configured || !state.session?.user) {
    return toast('Sign in before submitting a payment.', 'error');
  }
  if (!isConfiguredEasypaisaAccount()) {
    return toast('Easypaisa account details are not configured.', 'error');
  }
  const amountCents = selectedPaymentAmount();
  const paidAmount = Number($('payment-paid-amount')?.value);
  const paidCents = Math.round(paidAmount * 100);
  if (amountCents === null || !Number.isFinite(paidAmount) || paidCents !== amountCents) {
    return toast('The amount paid must exactly match the amount you selected.', 'error');
  }
  const transactionId = $('payment-tid')?.value.trim() || '';
  if (!transactionId) return toast('Enter the Easypaisa transaction ID (TID).', 'error');

  if ($('payment-submit')) $('payment-submit').disabled = true;
  if ($('payment-message')) $('payment-message').textContent = 'Submitting for administrator verification…';
  try {
    const { error } = await state.supabase.rpc('submit_easypaisa_payment', {
      p_transaction_id: transactionId,
      p_paid_amount_pkr: paidCents / 100
    });
    if (error) throw error;
    if ($('payment-tid')) $('payment-tid').value = '';
    if ($('payment-message')) {
      $('payment-message').textContent = `Rs. ${fmt(paidCents / 100)} submitted. It will be credited only after the TID is verified.`;
    }
    await loadSupabaseData();
  } catch (error) {
    if ($('payment-message')) $('payment-message').textContent = error.message;
    toast(error.message, 'error');
  } finally {
    if ($('payment-submit')) $('payment-submit').disabled = false;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function renderPaymentRequests() {
  const container = $('payment-history');
  if (!container) return;
  const userId = state.session?.user?.id;
  const items = state.paymentRequests
    .filter(request => !userId || request.user_id === userId)
    .slice(0, 10);

  container.innerHTML = items.map(request => {
    const status = String(request.status || 'pending').toLowerCase();
    const badgeClass = status === 'approved' || status === 'verified' || status === 'credited'
      ? 'bg-emerald-500/15 text-emerald-400'
      : status === 'rejected' || status === 'failed'
        ? 'bg-red-500/15 text-red-400'
        : 'bg-amber-500/15 text-amber-300';
    const amt = request.paid_amount_pkr ?? request.amount_pkr ?? 0;
    const when = request.created_at ? new Date(request.created_at).toLocaleString('en-PK') : '';
    return `<div class="rounded-lg border border-slate-800 bg-slate-900/90 p-3 text-xs"><div class="flex justify-between items-center gap-2"><span class="font-mono text-emerald-400 truncate">${escapeHtml(request.transaction_id || 'TID')}</span><span class="text-[10px] px-2 py-0.5 rounded-full ${badgeClass}">${escapeHtml(request.status || 'pending')}</span></div><div class="mt-1.5 flex justify-between items-center text-slate-300"><b>Rs. ${fmt(amt)}</b><span class="text-[10px] text-slate-500">${escapeHtml(when)}</span></div></div>`;
  }).join('') || '<p class="text-xs text-slate-500">No payment requests yet.</p>';
}

init();