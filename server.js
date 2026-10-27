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
const {
  CLUSTER_TAG,
  MAX_VOUCHER_TTL_SECS,
} = require('./lib/voucherV1');
const {
  DEFAULT_DOMAIN,
  DEFAULT_RADIUS_METERS,
  authorizeClaim,
  corsAllowlist,
  issueNonce,
} = require('./lib/claimAuth');

// === Config & Validation ===
const requiredEnv = [
  'SOLANA_RPC',
  'TOKEN_MINT',
  'GAME_VAULT_SECRET',
  'REDIS_URL',
  'SERVER_SECRET_KEY',
  'SOLANA_CLUSTER',
  'FIZZCAPS_PROGRAM_ID',
];
const missing = requiredEnv.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const {
  SOLANA_RPC,
  TOKEN_MINT,
  GAME_VAULT_SECRET,
  REDIS_URL,
  SERVER_SECRET_KEY,        // 64-byte base58 secret key for Ed25519 signing
  SOLANA_CLUSTER,
  FIZZCAPS_PROGRAM_ID,
  PORT = 3000,
  COOLDOWN_SECONDS = 60,
} = process.env;

if (!CLUSTER_TAG[SOLANA_CLUSTER]) {
  console.error('SOLANA_CLUSTER must be mainnet-beta, devnet, or localnet');
  process.exit(1);
}
try {
  // Validate before any voucher is signed. The program id is bound into the message.
  new PublicKey(FIZZCAPS_PROGRAM_ID);
} catch {
  console.error('FIZZCAPS_PROGRAM_ID is not a valid pubkey');
  process.exit(1);
}
let voucherTtl = Number(process.env.VOUCHER_TTL_SECONDS || MAX_VOUCHER_TTL_SECS);
if (!Number.isFinite(voucherTtl) || voucherTtl <= 0) {
  console.error('VOUCHER_TTL_SECONDS must be a positive number');
  process.exit(1);
}
if (voucherTtl > MAX_VOUCHER_TTL_SECS) voucherTtl = MAX_VOUCHER_TTL_SECS;

const connection = new Connection(SOLANA_RPC, 'confirmed');
const MINT_PUBKEY = new PublicKey(TOKEN_MINT);
const GAME_VAULT = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(GAME_VAULT_SECRET)));
const COOLDOWN = Number(COOLDOWN_SECONDS);
if (!Number.isInteger(COOLDOWN) || COOLDOWN <= 0) {
  console.error('COOLDOWN_SECONDS must be a positive integer');
  process.exit(1);
}
const SIWS_DOMAIN = process.env.SIWS_DOMAIN || DEFAULT_DOMAIN;
const CLAIM_RADIUS_METERS = Number(process.env.CLAIM_RADIUS_METERS || DEFAULT_RADIUS_METERS);
if (!Number.isFinite(CLAIM_RADIUS_METERS) || CLAIM_RADIUS_METERS <= 0) {
  console.error('CLAIM_RADIUS_METERS must be a positive number');
  process.exit(1);
}
const redis = new Redis(REDIS_URL);

redis.on('error', (err) => console.error('Redis error:', err));

// === Ed25519 Server Keypair for Voucher Signing ===
const serverSecretKeyUint8 = bs58.decode(SERVER_SECRET_KEY);
if (serverSecretKeyUint8.length !== 64) {
  console.error('SERVER_SECRET_KEY must be a 64-byte Ed25519 secret key (base58)');
  process.exit(1);
}
const serverKeypair = nacl.sign.keyPair.fromSecretKey(serverSecretKeyUint8);
const SERVER_PUBKEY = bs58.encode(serverKeypair.publicKey);
console.log(`Server signing pubkey: ${SERVER_PUBKEY}`);

// === Data Loading ===
function safeJsonRead(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('JSON load error:', filePath, e);
    return [];
  }
}

const DATA_DIR = path.join(__dirname, 'data');
const LOCATIONS = safeJsonRead(path.join(DATA_DIR, 'locations.json'));
const QUESTS = safeJsonRead(path.join(DATA_DIR, 'quests.json'));
const MINTABLES = safeJsonRead(path.join(DATA_DIR, 'mintables.json'));

// === App Setup ===
const app = express();
app.use(morgan('combined'));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", SOLANA_RPC, "wss:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      mediaSrc: ["'self'", "https://assets.codepen.io"],
      objectSrc: ["'none'"],
    },
  },
}));
const corsAllowed = new Set(corsAllowlist(process.env.CORS_ORIGINS));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !corsAllowed.has(origin)) {
    return res.status(403).json({ error: 'origin' });
  }
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsAllowed.has(origin)) callback(null, true);
    else callback(null, false);
  },
}));
app.use(express.json({ limit: '100kb' }));

const globalLimiter = rateLimit({ windowMs: 60_000, max: 200 });
const actionLimiter = rateLimit({ windowMs: 60_000, max: 20 });
// Default key is the client IP. /api/terminal-reward is the live route.
const claimIpLimiter = rateLimit({ windowMs: 60_000, max: 10 });
app.use(globalLimiter);
app.use(
  ['/find-loot', '/shop', '/battle', '/api/terminal-reward', '/claim-voucher', '/claim-nonce'],
  actionLimiter,
);
app.use(['/claim-voucher', '/claim-nonce'], claimIpLimiter);

// === Static & API Routes ===
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/locations', (req, res) => res.json(LOCATIONS));
app.get('/quests', (req, res) => res.json(QUESTS));
app.get('/mintables', (req, res) => res.json(MINTABLES));

// === Player Data ===
app.get('/player/:addr', async (req, res) => {
  const { addr } = req.params;
  try { new PublicKey(addr); } catch { return res.status(400).json({ error: 'Invalid address' }); }

  let playerData = { lvl: 1, hp: 100, caps: 0, gear: [], found: [], xp: 0, xpToNext: 100, rads: 0 };
  const redisData = await redis.get(`player:${addr}`);
  if (redisData) playerData = JSON.parse(redisData);

  // Optional: fetch NFTs for gear (keep if you want)
  try {
    const metaplex = Metaplex.make(connection);
    const nfts = await metaplex.nfts().findAllByOwner({ owner: new PublicKey(addr) });
    // ... your gear parsing logic
  } catch (e) {
    console.warn('NFT fetch failed:', e);
  }

  res.json(playerData);
});

app.post('/player/:addr', async (req, res) => {
  const { addr } = req.params;
  await redis.set(`player:${addr}`, JSON.stringify(req.body));
  res.json({ success: true });
});

// === Terminal Reward (unchanged) ===
app.post('/api/terminal-reward', [
  body('wallet').isString().notEmpty(),
  body('amount').isInt({ min: 1 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { wallet, amount } = req.body;
  try { new PublicKey(wallet); } catch { return res.status(400).json({ error: 'Invalid wallet' }); }

  let playerData = { caps: 0 };
  const data = await redis.get(`player:${wallet}`);
  if (data) playerData = JSON.parse(data);

  playerData.caps = (playerData.caps || 0) + Number(amount);
  await redis.set(`player:${wallet}`, JSON.stringify(playerData));

  res.json({ success: true, newCaps: playerData.caps });
});

// === Battle Endpoint (unchanged, just cleaned) ===
app.post('/battle', [
  body('wallet').notEmpty(),
  body('gearPower').isInt({ min: 1 }),
  body('signature').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  // ... keep your existing battle logic
});

// === SIWS nonce. Redis TTL is 120s. claim-voucher consumes it with GETDEL. ===
app.post('/claim-nonce', async (_req, res) => {
  try {
    const issued = await issueNonce(redis, { domain: SIWS_DOMAIN });
    res.json(issued);
  } catch {
    console.warn('claim-nonce rejected');
    res.status(500).json({ error: 'nonce' });
  }
});

// Wallet, loot id, hint, and coordinates in the body are not trusted.
// The signed SIWS message supplies wallet, loot_id, and nonce. The server
// looks the hint and coordinates up from locations.json.
app.post('/claim-voucher', [
  body('message').isString().isLength({ min: 1, max: 512 }),
  body('signature').isString().notEmpty(),
  body('latitude').isFloat({ min: -90, max: 90 }),
  body('longitude').isFloat({ min: -180, max: 180 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  let issued;
  try {
    issued = await authorizeClaim({
      redis,
      message: req.body.message,
      signature: req.body.signature,
      latitude: Number(req.body.latitude),
      longitude: Number(req.body.longitude),
      locations: LOCATIONS,
      nowSeconds: Math.floor(Date.now() / 1000),
      domain: SIWS_DOMAIN,
      radiusMeters: CLAIM_RADIUS_METERS,
      cooldownSeconds: COOLDOWN,
      cluster: SOLANA_CLUSTER,
      programId: FIZZCAPS_PROGRAM_ID,
      ttlSeconds: voucherTtl,
      secretKey: serverKeypair.secretKey,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.code });
    console.warn('claim-voucher rejected');
    return res.status(400).json({ error: 'Invalid voucher request' });
  }

  // ed25519Message is for the client to build the precompile instruction.
  // claim_loot rebuilds the message and rejects a mismatch. Do not log it.
  res.json({
    ok: true,
    voucher: issued.voucher,
    signature: issued.signature.toString('base64'),
    ed25519Message: issued.message.toString('base64'),
    serverPubkey: SERVER_PUBKEY,
    programId: issued.programId,
    cluster: issued.cluster,
  });
});

// === Catch-all for SPA ===
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// === Start Server ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Atomic Fizz Caps Server LIVE on port ${PORT}`);
  console.log(`Vault: ${GAME_VAULT.publicKey.toBase58()}`);
  console.log(`Server signing key: ${SERVER_PUBKEY}`);
  console.log(`MERRY CHRISTMAS 2025 — THE WASTELAND IS OPEN ☢️🌵🥤`);
});

process.on('unhandledRejection', (r) => console.warn('Unhandled Rejection:', r));
process.on('uncaughtException', (e) => console.error('Uncaught Exception:', e));
