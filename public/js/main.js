import { Connection, clusterApiUrl } from '@solana/web3.js';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  BackpackWalletAdapter,
  // Add more wallets as needed
} from '@solana/wallet-adapter-wallets';

// Choose network: 'devnet' for testing, 'mainnet-beta' for production
const network = WalletAdapterNetwork.Devnet;
const endpoint = clusterApiUrl(network);

// List of supported wallets
const wallets = [
  new PhantomWalletAdapter(),
  new SolflareWalletAdapter(),
  new BackpackWalletAdapter(),
  // Add Glow, Ledger, etc. here
];

let selectedWallet = null;
let publicKey = null;

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
// WALLET ADAPTER – CONNECT / DISCONNECT
// ============================================================================

async function connectWallet() {
  try {
    // Simple prompt for now (upgrade to modal later)
    const walletName = prompt('Enter wallet name (phantom, solflare, backpack):')?.toLowerCase();
    selectedWallet = wallets.find(w => w.name.toLowerCase().includes(walletName));

    if (!selectedWallet) throw new Error('Wallet not supported');

    await selectedWallet.connect();
    publicKey = selectedWallet.publicKey.toString();
    player.wallet = publicKey;
    document.getElementById('status').textContent = `STATUS: CONNECTED (${publicKey.slice(0,6)}...)`;
    setStatus('Wallet connected!', true, 5000);
    await fetchPlayer();
  } catch (err) {
    console.error('Wallet connection failed:', err);
    setStatus('Connection failed: ' + err.message, false, 8000);
  }
}

function disconnectWallet() {
  if (selectedWallet) {
    selectedWallet.disconnect();
    selectedWallet = null;
    publicKey = null;
    player.wallet = null;
    setStatus('Disconnected', true);
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
    if (!res.ok) throw new Error('Player fetch failed');
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
// GPS + MAP + CLAIMING (unchanged from your working version)
// ============================================================================

// ... (keep your placeMarker, startLocation, attemptClaim functions as-is) ...

// ============================================================================
// NARRATIVE UI – DROPDOWNS & MODALS (unchanged)
// ============================================================================

// ... (keep your createDropdown, NPC modal, story/terminal dropdowns as-is) ...

// ============================================================================
// MAP INITIALIZATION + EVENT HANDLERS (unchanged)
// ============================================================================

// ... (keep initMap as-is) ...

// ============================================================================
// DOM READY – WIRE EVERYTHING UP
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Wallet connect – now using adapter
  document.getElementById('connectWalletBtn')?.addEventListener('click', connectWallet);

  // Optional: Add disconnect button somewhere in UI
  // document.getElementById('disconnectBtn')?.addEventListener('click', disconnectWallet);

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
});

