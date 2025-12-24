// main.js – Atomic Fizz Caps – Combined & cleaned (v1.1 – full gameplay + narrative)

// ============================================================================
// CONSTANTS & GLOBALS
// ============================================================================

const API_BASE = window.location.origin;
const CLAIM_RADIUS = 50; // meters
const MAX_RADS = 1000;
const DROP_CHANCE = { legendary: 0.35, epic: 0.18, rare: 0.09, common: 0.04 };

const GEAR_NAMES = {
  common: ['Pipe Rifle', '10mm Pistol', 'Leather Armor', 'Vault Suit'],
  rare: ['Hunting Rifle', 'Combat Shotgun', 'Laser Pistol', 'Metal Armor'],
  epic: ['Plasma Rifle', 'Gauss Rifle', 'Combat Armor', 'T-51b Power Armor'],
  legendary: ['Alien Blaster', 'Fat Man', "Lincoln's Repeater", 'Experimental MIRV']
};

const EFFECT_POOL = {
  common: [{type: 'maxHp', min: 5, max: 20}, {type: 'radResist', min: 20, max: 60}],
  rare: [{type: 'maxHp', min: 25, max: 50}, {type: 'radResist', min: 70, max: 140}, {type: 'capsBonus', min: 10, max: 25}],
  epic: [{type: 'maxHp', min: 50, max: 90}, {type: 'radResist', min: 150, max: 250}, {type: 'capsBonus', min: 25, max: 45}, {type: 'xpBonus', min: 15, max: 30}],
  legendary: [{type: 'maxHp', min: 100, max: 180}, {type: 'radResist', min: 300, max: 500}, {type: 'capsBonus', min: 40, max: 80}, {type: 'critDrop', min: 20, max: 40}]
};

let player = {
  wallet: null,
  lvl: 1,
  hp: 100,
  maxHp: 100,
  caps: 0,
  rads: 0,
  xp: 0,
  xpToNext: 100,
  gear: [],
  equipped: {}, // gearId -> gear object
  claimed: new Set(),
  quests: []
};

let map, playerMarker = null, playerLatLng = null, lastAccuracy = 999, watchId = null, firstLock = true;
let locations = [], allQuests = [], markers = {};
let terminalSignal = null;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function randomEffect(rarity) {
  const pool = EFFECT_POOL[rarity] || EFFECT_POOL.common;
  const eff = pool[Math.floor(Math.random() * pool.length)];
  const val = eff.min + Math.floor(Math.random() * (eff.max - eff.min + 1));
  return { type: eff.type, val };
}

function generateGearDrop(rarity = 'common') {
  const names = GEAR_NAMES[rarity] || GEAR_NAMES.common;
  const effectCount = rarity === 'legendary' ? 3 : rarity === 'epic' ? 2 : rarity === 'rare' ? 2 : 1;
  const effects = Array.from({ length: effectCount }, () => randomEffect(rarity));
  return {
    id: `gear_${Date.now()}_${Math.random().toString(36).substr(2,9)}`,
    name: names[Math.floor(Math.random() * names.length)],
    rarity,
    effects,
    nftMint: null
  };
}

function applyGearBonuses() {
  let hpBonus = 0, radRes = 0, capsBonus = 0;
  Object.values(player.equipped).forEach(g => {
    g.effects.forEach(e => {
      if (e.type === 'maxHp') hpBonus += e.val;
      if (e.type === 'radResist') radRes += e.val;
      if (e.type === 'capsBonus') capsBonus += e.val;
    });
  });
  player.maxHp = 100 + (player.lvl - 1) * 10 + hpBonus;
  player.radResist = radRes;
  player.capsBonus = capsBonus;
  if (player.hp > player.maxHp) player.hp = player.maxHp;
}

function updateHPBar() {
  const hpPct = Math.min(100, player.hp / player.maxHp * 100);
  const radPct = Math.min(100, player.rads / MAX_RADS * 100);
  document.getElementById('hpFill').style.width = `${hpPct}%`;
  document.getElementById('radFill').style.width = `${radPct}%`;
  document.getElementById('hpText').textContent = `HP ${Math.floor(player.hp)} / ${player.maxHp}`;
  document.getElementById('playerLevel').textContent = player.lvl;
  document.getElementById('playerCaps').textContent = player.caps.toLocaleString();
}

function setStatus(text, isGood = true, time = 5000) {
  const s = document.getElementById('status');
  if (!s) return;
  s.textContent = `Status: ${text}`;
  s.className = isGood ? 'status-good' : 'status-bad';
  clearTimeout(s._to);
  if (time > 0) s._to = setTimeout(() => {
    s.textContent = 'Status: ready';
    s.className = 'status-good';
  }, time);
}

function playSfx(id, volume = 0.4) {
  const audio = document.getElementById(id);
  if (audio) {
    audio.currentTime = 0;
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.play().catch(() => {});
  }
}

// ============================================================================
// PLAYER DATA FETCH & SYNC
// ============================================================================

const NarrativeAPI = {
  async getMain() { const r = await fetch(`${API_BASE}/api/narrative/main`); return r.ok ? r.json() : { acts: [] }; },
  async getDialogList() { const r = await fetch(`${API_BASE}/api/narrative/dialog`); return r.ok ? r.json() : []; },
  async getDialog(key) { const r = await fetch(`${API_BASE}/api/narrative/dialog/${key}`); return r.ok ? r.json() : null; },
  async getTerminals() { const r = await fetch(`${API_BASE}/api/narrative/terminals`); return r.ok ? r.json() : { terminals: [] }; },
  async getCollectibles() { const r = await fetch(`${API_BASE}/api/narrative/collectibles`); return r.ok ? r.json() : { collectibles: [] }; }
};

async function fetchPlayer() {
  if (!player.wallet) return;
  try {
    const res = await fetch(`${API_BASE}/player/${player.wallet}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    Object.assign(player, data);
    player.claimed = new Set(data.claimed || []);
    player.quests = data.quests || [];
    player.gear = data.gear || [];
    player.equipped = data.equipped || {};
    applyGearBonuses();
    updateHPBar();
  } catch (e) {
    console.error('Player fetch failed:', e);
    setStatus('STATUS: OFFLINE', false);
  }
}

// ============================================================================
// GPS + MAP + CLAIMING
// ============================================================================

function placeMarker(lat, lng, accuracy) {
  playerLatLng = L.latLng(lat, lng);
  lastAccuracy = accuracy;

  if (!playerMarker) {
    playerMarker = L.circleMarker(playerLatLng, { radius: 10, color: '#00ff41', weight: 3, fillOpacity: 0.9 })
      .addTo(map)
      .bindPopup('You are here');
  } else {
    playerMarker.setLatLng(playerLatLng);
  }

  document.getElementById('gpsStatus').textContent = `GPS: ${Math.round(accuracy)}m`;
  document.getElementById('gpsDot').className = 'acc-dot ' + (accuracy <= 20 ? 'acc-green' : 'acc-amber');

  if (firstLock) {
    map.flyTo(playerLatLng, 16);
    firstLock = false;
  }
  document.getElementById('requestGpsBtn').style.display = 'none';
  setStatus("GPS LOCK ACQUIRED", true, 5000);
}

function startLocation() {
  if (!navigator.geolocation) return setStatus("GPS not supported", false);
  if (watchId) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    pos => placeMarker(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    () => setStatus("GPS error", false),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
  setStatus("Requesting GPS lock...");
}

async function attemptClaim(loc) {
  if (lastAccuracy > CLAIM_RADIUS || !playerLatLng || !player.wallet || player.claimed.has(loc.n)) {
    setStatus("Cannot claim", false);
    return;
  }
  const dist = map.distance(playerLatLng, L.latLng(loc.lat, loc.lng));
  if (dist > CLAIM_RADIUS) {
    setStatus(`Too far (${Math.round(dist)}m)`, false);
    return;
  }

  const message = `Claim:${loc.n}:${Date.now()}`;
  try {
    const encoded = new TextEncoder().encode(message);
    const signed = await window.solana.signMessage(encoded);
    const signature = bs58.encode(signed);

    const res = await fetch(`${API_BASE}/find-loot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: player.wallet,
        spot: loc.n,
        message,
        signature
      })
    });
    const data = await res.json();

    if (data.success) {
      player.caps = data.totalCaps || player.caps;
      player.claimed.add(loc.n);
      markers[loc.n]?.setStyle({ fillColor: '#003300', fillOpacity: 0.5 });

      const baseRad = loc.rarity === 'legendary' ? 120 : loc.rarity === 'epic' ? 80 : loc.rarity === 'rare' ? 50 : 20;
      player.rads = Math.min(MAX_RADS, player.rads + Math.max(5, baseRad - (player.radResist || 0) / 3));

      const xpGain = loc.rarity === 'legendary' ? 150 : loc.rarity === 'epic' ? 100 : loc.rarity === 'rare' ? 60 : 30;
      player.xp += xpGain;

      while (player.xp >= player.xpToNext) {
        player.xp -= player.xpToNext;
        player.lvl++;
        player.xpToNext = Math.floor(player.xpToNext * 1.5);
        player.maxHp += 10;
        player.hp = player.maxHp;
        setStatus(`LEVEL UP! Level ${player.lvl}`, true, 12000);
        playSfx('sfxLevelUp', 0.8);
      }

      let gearDropped = false;
      const chance = DROP_CHANCE[loc.rarity] || DROP_CHANCE.common;
      if (Math.random() < chance) {
        const newGear = generateGearDrop(loc.rarity || 'common');
        player.gear.push(newGear);
        setStatus(`GEAR DROP! ${newGear.name} (${newGear.rarity.toUpperCase()})`, true, 15000);
        playSfx('sfxGearDrop', 0.7);
        gearDropped = true;
      }

      playSfx('sfxClaim', 0.5);
      updateHPBar();
      checkTerminalAccess();
    } else {
      setStatus(data.error || "Claim failed", false);
    }
  } catch (err) {
    setStatus("Claim error", false);
  }
}

// ============================================================================
// UI & DROPDOWNS (from the first file)
// ============================================================================

function createDropdown(containerId, label, onOpen) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="dropdown">
      <button class="dropdown-btn">${label} ▼</button>
      <div class="dropdown-content hidden"></div>
    </div>
  `;

  const btn = container.querySelector('.dropdown-btn');
  const content = container.querySelector('.dropdown-content');

  let isLoading = false;

  btn.addEventListener('click', async () => {
    document.querySelectorAll('.dropdown-content').forEach(c => {
      if (c !== content) c.classList.add('hidden');
    });

    if (!content.classList.contains('hidden')) {
      content.classList.add('hidden');
      return;
    }

    content.classList.remove('hidden');
    content.innerHTML = '<div class="loading">Loading...</div>';

    if (isLoading) return;
    isLoading = true;

    try {
      const html = await onOpen();
      content.innerHTML = html || '<div class="empty">No data available.</div>';
    } catch (e) {
      console.error('Dropdown load failed:', e);
      content.innerHTML = '<div class="error">Failed to load. <button onclick="location.reload()">Retry</button></div>';
    } finally {
      isLoading = false;
    }
  });
}

// Create all narrative dropdowns (same as first file)
createDropdown('pipboy-logs-container', 'Terminal Logs', async () => {
  const data = await NarrativeAPI.getCollectibles();
  const logs = data.collectibles || [];
  if (!logs.length) return '<p>No logs found.</p>';
  return logs.map(log => `
    <div class="pip-log">
      <strong>${log.title || 'Untitled Log'}</strong>
      <small class="poi">${log.poi || 'Unknown Location'}</small>
      <pre>${log.content || 'No content'}</pre>
      <hr>
    </div>
  `).join('');
});

// NPC dialog dropdown + modal (same as first file)
createDropdown('pipboy-dialog-container', 'NPC Records', async () => {
  const list = await NarrativeAPI.getDialogList();
  if (!list.length) return '<p>No NPC records found.</p>';
  return list.map(npc => `
    <div class="npc-entry" data-key="${npc.key}">
      <strong>${npc.npc || 'Unknown Contact'}</strong>
      <small>${npc.title || ''}</small>
    </div>
  `).join('');
});

document.addEventListener('click', async e => {
  const entry = e.target.closest('.npc-entry');
  if (!entry) return;
  const key = entry.dataset.key;
  if (!key) return;

  const dlg = await NarrativeAPI.getDialog(key);
  if (!dlg) return;

  const modal = document.createElement('div');
  modal.className = 'pipboy-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="dialog-header">${dlg.npc} - ${dlg.title || 'Contact'}</div>
      <div class="dialog-body">${dlg.intro?.text || '<p>No introduction available.</p>'}</div>
      <button class="btn close-modal">Close</button>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('.close-modal').onclick = () => modal.remove();
  modal.onclick = ev => { if (ev.target === modal) modal.remove(); };
});

// Story & Terminal dropdowns (same as first file)
createDropdown('pipboy-story-container', 'Mission Archives', async () => {
  const main = await NarrativeAPI.getMain();
  const acts = main.acts || [];
  const sideQuests = main.side_quests || [];

  let html = '<h2>Main Storyline</h2>';
  if (acts.length) {
    html += acts.map(a => `<div class="story-act"><strong>${a.name || a.id}</strong><p>${a.summary || 'No summary'}</p></div>`).join('');
  } else {
    html += '<p>No main acts loaded.</p>';
  }

  html += '<h2>Side Operations</h2>';
  if (sideQuests.length) {
    html += sideQuests.map(q => `<div class="story-side"><strong>${q.name || q.id}</strong><p>${q.summary || 'No summary'}</p></div>`).join('');
  } else {
    html += '<p>No side quests loaded.</p>';
  }
  return html;
});

createDropdown('terminal-archives-container', 'Vault-Tec Archives', async () => {
  const data = await NarrativeAPI.getTerminals();
  const terminals = data.terminals || [];
  if (!terminals.length) return '<p>No terminal entries found.</p>';

  const grouped = terminals.reduce((acc, t) => {
    acc[t.poi] = acc[t.poi] || [];
    acc[t.poi].push(t);
    return acc;
  }, {});

  return Object.entries(grouped).map(([poi, entries]) => `
    <h3>${poi}</h3>
    ${entries.map(e => `
      <div class="terminal-entry">
        <strong>${e.title}</strong>
        <pre>${e.content}</pre>
        <hr>
      </div>
    `).join('')}
  `).join('');
});

// ============================================================================
// MAP INITIALIZATION + EVENT HANDLERS
// ============================================================================

async function initMap() {
  map = L.map('map', { zoomControl: false }).setView([36.1146, -115.1728], 11);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: ''
  }).addTo(map);

  try {
    const res = await fetch(`${API_BASE}/locations`);
    if (!res.ok) throw new Error();
    locations = await res.json();

    locations.forEach(loc => {
      const color = loc.rarity === 'legendary' ? '#ffff00'
        : loc.rarity === 'epic' ? '#ff6200'
        : loc.rarity === 'rare' ? '#00ffff'
        : '#00ff41';

      const m = L.circleMarker([loc.lat, loc.lng], {
        radius: 16,
        weight: 4,
        color: '#001100',
        fillColor: color,
        fillOpacity: 0.9
      })
      .addTo(map)
      .bindPopup(`<b>${loc.n}</b><br>Level ${loc.lvl || 1}<br>Rarity: ${loc.rarity || 'common'}`)
      .on('click', () => attemptClaim(loc));

      markers[loc.n] = m;

      if (player.claimed.has(loc.n)) {
        m.setStyle({ fillColor: '#003300', fillOpacity: 0.5 });
      }
    });

    setStatus(`Loaded ${locations.length} locations`, true);
  } catch (err) {
    setStatus("Locations offline", false);
  }

  startLocation();
  updateHPBar();
}

// ============================================================================
// DOM READY – WIRE EVERYTHING UP
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Wallet connect
  document.getElementById('connectWalletBtn')?.addEventListener('click', async () => {
    const provider = window.solana;
    if (!provider?.isPhantom) {
      alert('Phantom wallet not detected!');
      return;
    }
    try {
      await provider.connect();
      player.wallet = provider.publicKey.toString();
      document.getElementById('status').textContent = `STATUS: CONNECTED (${player.wallet.slice(0,6)}...)`;
      await fetchPlayer();
    } catch (err) {
      console.error('Wallet connection failed:', err);
    }
  });

  document.getElementById('refreshPlayerBtn')?.addEventListener('click', fetchPlayer);

  document.getElementById('requestGpsBtn')?.addEventListener('click', startLocation);

  // Sound effects on buttons
  document.querySelectorAll('.btn, .tab, .dropdown-btn').forEach(el => {
    el.addEventListener('click', () => playSfx('sfxButton', 0.3));
  });

  // Radiation drain
  setInterval(() => {
    const effectiveRads = Math.max(0, player.rads - (player.radResist || 0));
    if (effectiveRads > 150 && player.hp > 0) {
      player.hp -= Math.floor(effectiveRads / 250);
      if (player.hp <= 0) player.hp = 0;
      updateHPBar();
    }
  }, 30000);

  // Initial setup
  updateHPBar();
  initMap();

  // Create all narrative dropdowns
  createDropdown('pipboy-logs-container', 'Terminal Logs', /* ... */); // already defined above
  createDropdown('pipboy-dialog-container', 'NPC Records', /* ... */);
  createDropdown('pipboy-story-container', 'Mission Archives', /* ... */);
  createDropdown('terminal-archives-container', 'Vault-Tec Archives', /* ... */);
});