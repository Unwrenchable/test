require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const Redis = require('ioredis');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmRawTransaction,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
} = require('@solana/spl-token');
const { Metaplex } = require('@metaplex-foundation/js');

// === Narrative Loader (minimal working version) ===
function loadNarrative(dataDir) {
  const narrative = {
    main: safeJsonRead(path.join(dataDir, 'narrative_main.json')),
    dialog: {},
    terminals: safeJsonRead(path.join(dataDir, 'terminals.json')),
    encounters: safeJsonRead(path.join(dataDir, 'encounters.json')),
    collectibles: safeJsonRead(path.join(dataDir, 'collectibles.json')),
  };

  // Load all dialog_*.json files
  fs.readdirSync(dataDir)
    .filter(file => file.startsWith('dialog_') && file.endsWith('.json'))
    .forEach(file => {
      const data = safeJsonRead(path.join(dataDir, file));
      if (data?.id) narrative.dialog[data.id] = data;
    });

  return narrative;
}

function safeJsonRead(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('JSON load error:', filePath, e);
    return [];
  }
}

process.on('unhandledRejection', (r) => console.warn('Unhandled Rejection:', r));
process.on('uncaughtException', (e) => console.error('Uncaught Exception:', e));

const {
  SOLANA_RPC,
  TOKEN_MINT,
  GAME_VAULT_SECRET,
  DEV_WALLET_SECRET,
  PORT = 3000,
  COOLDOWN_SECONDS = 60,
  REDIS_URL,
} = process.env;

if (!SOLANA_RPC || !TOKEN_MINT || !GAME_VAULT_SECRET || !DEV_WALLET_SECRET || !REDIS_URL) {
  console.error('Missing required env vars');
  process.exit(1);
}

const connection = new Connection(SOLANA_RPC, 'confirmed');
const MINT_PUBKEY = new PublicKey(TOKEN_MINT);
const GAME_VAULT = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(GAME_VAULT_SECRET)));
const COOLDOWN = Number(COOLDOWN_SECONDS);
const redis = new Redis(REDIS_URL);
redis.on('error', (err) => console.error('Redis error:', err));

const metaplex = Metaplex.make(connection);

// Load data
const DATA_DIR = path.join(__dirname, 'data');
const LOCATIONS = safeJsonRead(path.join(DATA_DIR, 'locations.json'));
const QUESTS = safeJsonRead(path.join(DATA_DIR, 'quests.json'));
const MINTABLES = safeJsonRead(path.join(DATA_DIR, 'mintables.json'));
const NARRATIVE = loadNarrative(DATA_DIR);

const app = express();

app.use(morgan('combined'));

// Helmet with relaxed CSP for media, scripts, etc.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", SOLANA_RPC, "wss:", "https://unpkg.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        mediaSrc: ["'self'", "https://assets.codepen.io"], // ← Fixed audio from CodePen
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
  })
);

app.use(cors());
app.use(express.json({ limit: '100kb' }));

const globalLimiter = rateLimit({ windowMs: 60_000, max: 200 });
const actionLimiter = rateLimit({ windowMs: 60_000, max: 20 });
app.use(globalLimiter);
app.use('/find-loot', actionLimiter);
app.use('/shop/', actionLimiter);
app.use('/battle', actionLimiter);

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Core API routes
app.get('/locations', (req, res) => res.json(LOCATIONS));
app.get('/quests', (req, res) => res.json(QUESTS.length ? QUESTS : []));
app.get('/mintables', (req, res) => res.json(MINTABLES.length ? MINTABLES : []));

app.get('/player/:addr', async (req, res) => {
  const { addr } = req.params;
  try {
    new PublicKey(addr);
  } catch {
    return res.status(400).json({ error: 'Invalid address' });
  }

  let playerData = {
    lvl: 1,
    hp: 100,
    caps: 0,
    gear: [],
    found: [],
    xp: 0,
    xpToNext: 100,
    rads: 0,
  };

  const redisData = await redis.get(`player:${addr}`);
  if (redisData) playerData = JSON.parse(redisData);

  try {
    const nfts = await metaplex.nfts().findAllByOwner({ owner: new PublicKey(addr) });
    const gear = nfts
      .filter((nft) => nft.json?.attributes)
      .map((nft) => {
        const powerAttr = nft.json.attributes.find((a) => a.trait_type === 'Power');
        const rarityAttr = nft.json.attributes.find((a) => a.trait_type === 'Rarity');
        return {
          name: nft.name || 'Unknown Gear',
          power: powerAttr ? Number(powerAttr.value) : 10,
          rarity: rarityAttr ? rarityAttr.value : 'common',
        };
      });
    playerData.gear = gear.length ? gear : playerData.gear || [];
  } catch (e) {
    console.warn('NFT gear fetch failed:', e);
  }

  res.json(playerData);
});

// Protected player save (add signature check later)
app.post('/player/:addr', async (req, res) => {
  const { addr } = req.params;
  const data = req.body;
  await redis.set(`player:${addr}`, JSON.stringify(data));
  res.json({ success: true });
});

// Narrative API routes
app.get('/api/narrative/main', (req, res) => res.json(NARRATIVE.main || {}));
app.get('/api/narrative/dialog', (req, res) => {
  const summary = Object.entries(NARRATIVE.dialog || {}).map(([key, value]) => ({
    id: value?.id,
    npc: value?.npc,
    key,
  }));
  res.json(summary);
});
app.get('/api/narrative/dialog/:npc', (req, res) => {
  const dlg = NARRATIVE.dialog?.[req.params.npc];
  if (!dlg) return res.status(404).json({ error: 'NPC dialog not found' });
  res.json(dlg);
});
app.get('/api/narrative/terminals', (req, res) => res.json(NARRATIVE.terminals || {}));
app.get('/api/narrative/encounters', (req, res) => res.json(NARRATIVE.encounters || {}));
app.get('/api/narrative/collectibles', (req, res) => res.json(NARRATIVE.collectibles || {}));

// Battle endpoint
app.post('/battle', [
  body('wallet').notEmpty(),
  body('gearPower').isInt({ min: 1 }),
  body('signature').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { wallet, gearPower, signature, message } = req.body;

  if (!verifySolanaSignature(message, signature, wallet)) {
    return res.status(400).json({ error: 'Bad signature' });
  }

  const redisData = await redis.get(`player:${wallet}`);
  const playerData = redisData ? JSON.parse(redisData) : { lvl: 1, hp: 100, caps: 0, xp: 0, rads: 0 };

  const enemyPower = Math.floor(playerData.lvl * 8 + Math.random() * 40 + 20);
  let winChance = 0.5 + (gearPower - enemyPower) / 200;
  winChance = Math.max(0.1, Math.min(0.9, winChance));

  const isWin = Math.random() < winChance;
  let capsReward = 0;
  let txSignature = null;

  if (isWin) {
    capsReward = Math.floor(gearPower * 1.2 + Math.random() * 30 + 10);

    try {
      const playerATA = await getOrCreateAssociatedTokenAccount(
        connection,
        GAME_VAULT,
        MINT_PUBKEY,
        new PublicKey(wallet)
      );
      const vaultATA = await getOrCreateAssociatedTokenAccount(
        connection,
        GAME_VAULT,
        MINT_PUBKEY,
        GAME_VAULT.publicKey
      );

      const tx = new Transaction().add(
        createTransferInstruction(
          vaultATA.address,
          playerATA.address,
          GAME_VAULT.publicKey,
          capsReward * 1_000_000 // 6 decimals
        )
      );

      txSignature = await sendAndConfirmRawTransaction(
        connection,
        tx.serialize({ requireAllSignatures: false }),
        { commitment: 'confirmed' }
      );

      playerData.caps += capsReward;
      playerData.xp += Math.floor(capsReward / 2);
      playerData.hp = Math.max(0, playerData.hp - 5);
    } catch (e) {
      console.error('CAPS transfer failed:', e);
      return res.status(500).json({ error: 'Reward transfer failed' });
    }
  } else {
    playerData.hp = Math.max(0, playerData.hp - 20);
    playerData.rads += 50;
  }

  await redis.set(`player:${wallet}`, JSON.stringify(playerData));

  res.json({
    success: true,
    win: isWin,
    capsReward,
    enemyPower,
    gearPower,
    txSignature,
    player: playerData,
  });
});

// SPA catch-all (must be last)
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Atomic Fizz Caps LIVE on port ${PORT}`);
  console.log(`Vault: ${GAME_VAULT.publicKey.toBase58()}`);
});

module.exports = app;
