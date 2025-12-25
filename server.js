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

// === Narrative Loader (server-side) ===
function safeJsonRead(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('JSON load error:', filePath, e);
    return [];
  }
}

function loadNarrative(dataDir) {
  const narrative = {
    main: safeJsonRead(path.join(dataDir, 'narrative_main.json')),
    dialog: {},
    terminals: safeJsonRead(path.join(dataDir, 'terminals.json')),
    encounters: safeJsonRead(path.join(dataDir, 'encounters.json')),
    collectibles: safeJsonRead(path.join(dataDir, 'collectibles.json')),
  };

  // Load all dialog_*.json files dynamically
  fs.readdirSync(dataDir)
    .filter(file => file.startsWith('dialog_') && file.endsWith('.json'))
    .forEach(file => {
      const data = safeJsonRead(path.join(dataDir, file));
      if (data?.id) narrative.dialog[data.id] = data;
    });

  return narrative;
}

process.on('unhandledRejection', (r) => console.warn('Unhandled Rejection:', r));
process.on('uncaughtException', (e) => console.error('Uncaught Exception:', e));

// Environment variables validation
const requiredEnv = ['SOLANA_RPC', 'TOKEN_MINT', 'GAME_VAULT_SECRET', 'DEV_WALLET_SECRET', 'REDIS_URL'];
const missing = requiredEnv.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const {
  SOLANA_RPC,
  TOKEN_MINT,
  GAME_VAULT_SECRET,
  DEV_WALLET_SECRET,
  PORT = 3000,
  COOLDOWN_SECONDS = 60,
  REDIS_URL,
} = process.env;

const connection = new Connection(SOLANA_RPC, 'confirmed');
const MINT_PUBKEY = new PublicKey(TOKEN_MINT);
const GAME_VAULT = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(GAME_VAULT_SECRET)));
const COOLDOWN = Number(COOLDOWN_SECONDS);
const redis = new Redis(REDIS_URL);
redis.on('error', (err) => console.error('Redis connection error:', err));

const metaplex = Metaplex.make(connection);

// Load data
const DATA_DIR = path.join(__dirname, 'data');
const LOCATIONS = safeJsonRead(path.join(DATA_DIR, 'locations.json'));
const QUESTS = safeJsonRead(path.join(DATA_DIR, 'quests.json'));
const MINTABLES = safeJsonRead(path.join(DATA_DIR, 'mintables.json'));
const NARRATIVE = loadNarrative(DATA_DIR);

const app = express();

// Logging
app.use(morgan('combined'));

// Helmet CSP – relaxed for media (fixes CodePen audio), scripts, etc.
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
        mediaSrc: ["'self'", "https://assets.codepen.io"], // Fixes external audio
        objectSrc: ["'none'"],
      },
    },
  })
);

app.use(cors());
app.use(express.json({ limit: '100kb' }));

// Rate limiting
const globalLimiter = rateLimit({ windowMs: 60_000, max: 200 });
const actionLimiter = rateLimit({ windowMs: 60_000, max: 20 });
app.use(globalLimiter);
app.use(['/find-loot', '/shop', '/battle', '/terminal-reward'], actionLimiter);

// Serve static files from public/
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Core API routes
app.get('/locations', (req, res) => res.json(LOCATIONS));
app.get('/quests', (req, res) => res.json(QUESTS.length ? QUESTS : []));
app.get('/mintables', (req, res) => res.json(MINTABLES.length ? MINTABLES : []));

// Player data (GET)
app.get('/player/:addr', async (req, res) => {
  const { addr } = req.params;
  try {
    new PublicKey(addr);
  } catch {
    return res.status(400).json({ error: 'Invalid address' });
  }

  let playerData = { lvl: 1, hp: 100, caps: 0, gear: [], found: [], xp: 0, xpToNext: 100, rads: 0 };

  const redisData = await redis.get(`player:${addr}`);
  if (redisData) playerData = JSON.parse(redisData);

  try {
    const nfts = await metaplex.nfts().findAllByOwner({ owner: new PublicKey(addr) });
    const gear = nfts
      .filter(nft => nft.json?.attributes)
      .map(nft => {
        const powerAttr = nft.json.attributes.find(a => a.trait_type === 'Power');
        const rarityAttr = nft.json.attributes.find(a => a.trait_type === 'Rarity');
        return {
          name: nft.name || 'Unknown Gear',
          power: powerAttr ? Number(powerAttr.value) : 10,
          rarity: rarityAttr ? rarityAttr.value : 'common'
        };
      });
    playerData.gear = gear.length ? gear : playerData.gear || [];
  } catch (e) {
    console.warn("NFT gear fetch failed:", e);
  }

  res.json(playerData);
});

// Player save (POST) – add signature protection later
app.post('/player/:addr', async (req, res) => {
  const { addr } = req.params;
  const data = req.body;
  await redis.set(`player:${addr}`, JSON.stringify(data));
  res.json({ success: true });
});

// NEW: Terminal game reward endpoint (for overseer.js wins)
app.post('/api/terminal-reward', [
  body('wallet').isString().notEmpty(),
  body('amount').isInt({ min: 1 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { wallet, amount } = req.body;

  try {
    new PublicKey(wallet);
  } catch {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  let playerData = { caps: 0 };
  const redisData = await redis.get(`player:${wallet}`);
  if (redisData) playerData = JSON.parse(redisData);

  playerData.caps = (playerData.caps || 0) + Number(amount);

  await redis.set(`player:${wallet}`, JSON.stringify(playerData));

  res.json({ success: true, newCaps: playerData.caps });
});

// Battle endpoint (existing)
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
          capsReward * 1_000_000
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
      console.error("CAPS transfer failed:", e);
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

// Catch-all SPA – serve index.html for any unmatched route
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Atomic Fizz Caps LIVE on port ${PORT}`);
  console.log(`Vault: ${GAME_VAULT.publicKey.toBase58()}`);
});

// Signature verification helper (used in battle)
function verifySolanaSignature(message, signature, publicKey) {
  try {
    const messageUint8 = new TextEncoder().encode(message);
    const signatureUint8 = bs58.decode(signature);
    const publicKeyUint8 = new PublicKey(publicKey).toBytes();
    return nacl.sign.detached.verify(messageUint8, signatureUint8, publicKeyUint8);
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

module.exports = app;
