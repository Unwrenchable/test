"use strict";

const crypto = require("crypto");
const { PublicKey } = require("@solana/web3.js");
const nacl = require("tweetnacl");
const { createClaimVoucher } = require("./voucherV1");

const SIWS_PREFIX = "FIZZCAPS:CLAIM:v1";
const NONCE_TTL_SECONDS = 120;
const ISSUED_AT_TTL_SECONDS = 120;
const MAX_FUTURE_SKEW_SECONDS = 30;
const DEFAULT_DOMAIN = "atomicfizzcaps.xyz";
const DEFAULT_RADIUS_METERS = 50;
const DEFAULT_CORS_ORIGINS = "https://atomicfizzcaps.xyz,http://localhost:3000";

class ClaimAuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function corsAllowlist(raw) {
  return (raw == null || raw === "" ? DEFAULT_CORS_ORIGINS : raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSiwsMessage({ domain, wallet, lootId, nonce, issuedAt }) {
  if (typeof domain !== "string" || domain.length === 0 || domain.includes("\n")) {
    throw new ClaimAuthError(400, "unauthorized");
  }
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new ClaimAuthError(400, "unauthorized");
  if (!/^\d+$/.test(String(lootId))) throw new ClaimAuthError(400, "unauthorized");
  if (!/^\d+$/.test(String(issuedAt))) throw new ClaimAuthError(400, "unauthorized");
  let walletText;
  try {
    walletText = new PublicKey(wallet).toBase58();
  } catch {
    throw new ClaimAuthError(400, "unauthorized");
  }
  return [
    SIWS_PREFIX,
    `domain:${domain}`,
    `wallet:${walletText}`,
    `loot_id:${String(lootId)}`,
    `nonce:${nonce}`,
    `issued_at:${String(issuedAt)}`,
  ].join("\n");
}

function parseSiwsMessage(text, expectedDomain) {
  if (typeof text !== "string" || text.length > 512) {
    throw new ClaimAuthError(401, "unauthorized");
  }
  const lines = text.split("\n");
  if (lines.length !== 6 || lines[0] !== SIWS_PREFIX) {
    throw new ClaimAuthError(401, "unauthorized");
  }
  const take = (prefix, line) => {
    if (!line.startsWith(prefix)) throw new ClaimAuthError(401, "unauthorized");
    return line.slice(prefix.length);
  };
  const domain = take("domain:", lines[1]);
  const wallet = take("wallet:", lines[2]);
  const lootId = take("loot_id:", lines[3]);
  const nonce = take("nonce:", lines[4]);
  const issuedAt = take("issued_at:", lines[5]);
  if (domain !== expectedDomain) throw new ClaimAuthError(401, "unauthorized");
  if (!/^\d+$/.test(lootId)) throw new ClaimAuthError(401, "unauthorized");
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new ClaimAuthError(401, "unauthorized");
  if (!/^\d+$/.test(issuedAt)) throw new ClaimAuthError(401, "unauthorized");
  let walletKey;
  try {
    walletKey = new PublicKey(wallet);
  } catch {
    throw new ClaimAuthError(401, "unauthorized");
  }
  if (walletKey.toBase58() !== wallet) throw new ClaimAuthError(401, "unauthorized");
  const issued = Number(issuedAt);
  if (!Number.isSafeInteger(issued)) throw new ClaimAuthError(401, "unauthorized");
  return { domain, wallet, lootId, nonce, issuedAt: issued };
}

function verifySiwsSignature(message, signature, wallet) {
  const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(signature, "base64");
  if (sig.length !== 64) throw new ClaimAuthError(401, "unauthorized");
  const ok = nacl.sign.detached.verify(
    Buffer.from(message, "utf8"),
    sig,
    new PublicKey(wallet).toBytes(),
  );
  if (!ok) throw new ClaimAuthError(401, "unauthorized");
}

function assertIssuedAt(issuedAt, nowSeconds) {
  if (!Number.isInteger(nowSeconds)) throw new ClaimAuthError(400, "unauthorized");
  if (issuedAt - nowSeconds > MAX_FUTURE_SKEW_SECONDS) {
    throw new ClaimAuthError(401, "unauthorized");
  }
  if (nowSeconds - issuedAt > ISSUED_AT_TTL_SECONDS) {
    throw new ClaimAuthError(401, "unauthorized");
  }
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const radius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

function locationForLoot(locations, lootId) {
  const id = Number(lootId);
  if (!Number.isInteger(id) || id < 1 || id > locations.length) {
    throw new ClaimAuthError(404, "unknown loot");
  }
  const loc = locations[id - 1];
  if (
    !loc ||
    typeof loc.n !== "string" ||
    typeof loc.lat !== "number" ||
    typeof loc.lng !== "number" ||
    !Number.isFinite(loc.lat) ||
    !Number.isFinite(loc.lng)
  ) {
    throw new ClaimAuthError(404, "unknown loot");
  }
  const hintBytes = Buffer.byteLength(loc.n, "utf8");
  if (hintBytes === 0 || hintBytes > 64) throw new ClaimAuthError(400, "hint");
  return loc;
}

function assertProximity(latitude, longitude, loc, radiusMeters) {
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    throw new ClaimAuthError(400, "coordinates");
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new ClaimAuthError(400, "coordinates");
  }
  const distance = haversineMeters(latitude, longitude, loc.lat, loc.lng);
  if (distance > radiusMeters) throw new ClaimAuthError(403, "too far");
  return distance;
}

async function issueNonce(redis, { domain = DEFAULT_DOMAIN, randomBytes } = {}) {
  const bytes = randomBytes ? randomBytes(16) : crypto.randomBytes(16);
  const nonce = Buffer.from(bytes).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new ClaimAuthError(500, "nonce");
  await redis.set(nonceKey(nonce), "1", "EX", NONCE_TTL_SECONDS);
  return { nonce, ttl: NONCE_TTL_SECONDS, domain };
}

function nonceKey(nonce) {
  return `siws:nonce:${nonce}`;
}

function cooldownKey(wallet) {
  return `claim_cooldown:${wallet}`;
}

/**
 * Wallet, loot id, and nonce come from the signed message. A wallet field on
 * the HTTP body is not an argument here and is ignored by the route.
 */
async function authorizeClaim({
  redis,
  message,
  signature,
  latitude,
  longitude,
  locations,
  nowSeconds,
  domain,
  radiusMeters,
  cooldownSeconds,
  cluster,
  programId,
  ttlSeconds,
  secretKey,
  voucherId,
  rng,
}) {
  const parsed = parseSiwsMessage(message, domain);
  verifySiwsSignature(message, signature, parsed.wallet);
  assertIssuedAt(parsed.issuedAt, nowSeconds);

  const consumed = await redis.getdel(nonceKey(parsed.nonce));
  if (consumed !== "1") throw new ClaimAuthError(401, "nonce");

  const loc = locationForLoot(locations, parsed.lootId);
  assertProximity(latitude, longitude, loc, radiusMeters);

  const reserved = await redis.set(
    cooldownKey(parsed.wallet),
    "1",
    "EX",
    cooldownSeconds,
    "NX",
  );
  if (reserved !== "OK") throw new ClaimAuthError(429, "cooldown");

  try {
    return createClaimVoucher({
      cluster,
      programId,
      player: parsed.wallet,
      lootId: parsed.lootId,
      latitude: loc.lat,
      longitude: loc.lng,
      locationHint: loc.n,
      nowSeconds,
      ttlSeconds,
      secretKey,
      voucherId,
      rng,
    });
  } catch (err) {
    await redis.del(cooldownKey(parsed.wallet));
    throw err;
  }
}

module.exports = {
  ClaimAuthError,
  DEFAULT_CORS_ORIGINS,
  DEFAULT_DOMAIN,
  DEFAULT_RADIUS_METERS,
  ISSUED_AT_TTL_SECONDS,
  NONCE_TTL_SECONDS,
  SIWS_PREFIX,
  assertProximity,
  authorizeClaim,
  buildSiwsMessage,
  corsAllowlist,
  haversineMeters,
  issueNonce,
  locationForLoot,
  parseSiwsMessage,
};
