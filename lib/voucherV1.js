"use strict";

const crypto = require("crypto");
const { PublicKey } = require("@solana/web3.js");
const nacl = require("tweetnacl");

const DOMAIN = Buffer.from("FIZZCAPS:LOOT_VOUCHER:v1", "ascii");
const VOUCHER_MSG_LEN = 169;
const MAX_HINT_LEN = 64;
const MAX_VOUCHER_TTL_SECS = 300;
const CLUSTER_TAG = { "mainnet-beta": 1, devnet: 2, localnet: 3 };
const U64_MAX = 18446744073709551615n;

function randomVoucherId(rng = (n) => crypto.randomBytes(n)) {
  const id = Buffer.from(rng(16));
  if (id.length !== 16) throw new Error("voucherId");
  return id;
}

function toE6(deg) {
  if (typeof deg !== "number" || !Number.isFinite(deg)) throw new Error("coordinate");
  const scaled = deg * 1e6;
  if (!Number.isFinite(scaled)) throw new Error("coordinate");
  // Half away from zero. Math.round is not that for negatives.
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  if (!Number.isSafeInteger(rounded)) throw new Error("coordinate");
  return rounded;
}

function parseLootId(lootId) {
  const text = typeof lootId === "bigint" ? lootId.toString() : String(lootId).trim();
  if (!/^\d+$/.test(text)) throw new Error("lootId");
  const value = BigInt(text);
  if (value > U64_MAX) throw new Error("lootId");
  return value;
}

function asVoucherId(voucherId) {
  const vid = Buffer.isBuffer(voucherId) ? voucherId : Buffer.from(voucherId, "hex");
  if (vid.length !== 16) throw new Error("voucherId");
  return vid;
}

function w64(value, signed) {
  const buf = Buffer.alloc(8);
  const n = BigInt(value);
  if (signed) buf.writeBigInt64LE(n);
  else buf.writeBigUInt64LE(n);
  return buf;
}

function w32(value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value);
  return buf;
}

function buildVoucherMessageV1({
  cluster,
  programId,
  player,
  voucherId,
  lootId,
  latE6,
  lngE6,
  locationHint,
  issuedAt,
  expiresAt,
}) {
  const tag = CLUSTER_TAG[cluster];
  if (!tag) throw new Error("unknown cluster");
  const hint = Buffer.from(locationHint, "utf8");
  if (hint.length > MAX_HINT_LEN) throw new Error("hint");
  const buf = Buffer.alloc(VOUCHER_MSG_LEN);
  let o = 0;
  const put = (part) => {
    part.copy(buf, o);
    o += part.length;
  };
  put(DOMAIN);
  put(Buffer.from([tag]));
  put(new PublicKey(programId).toBuffer());
  put(new PublicKey(player).toBuffer());
  put(asVoucherId(voucherId));
  put(w64(parseLootId(lootId), false));
  put(w32(latE6));
  put(w32(lngE6));
  put(crypto.createHash("sha256").update(hint).digest());
  put(w64(issuedAt, true));
  put(w64(expiresAt, true));
  if (o !== VOUCHER_MSG_LEN) throw new Error("layout drift");
  return buf;
}

function createClaimVoucher({
  cluster,
  programId,
  player,
  lootId,
  latitude,
  longitude,
  locationHint,
  nowSeconds,
  ttlSeconds,
  secretKey,
  voucherId,
  rng,
}) {
  if (!Number.isInteger(nowSeconds)) throw new Error("now");
  const requested = ttlSeconds == null ? MAX_VOUCHER_TTL_SECS : Number(ttlSeconds);
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("ttl");
  const effectiveTtl = Math.min(requested, MAX_VOUCHER_TTL_SECS);
  const issuedAt = nowSeconds;
  const expiresAt = issuedAt + effectiveTtl;
  const latE6 = toE6(latitude);
  const lngE6 = toE6(longitude);
  if (latE6 < -90_000_000 || latE6 > 90_000_000) throw new Error("lat");
  if (lngE6 < -180_000_000 || lngE6 > 180_000_000) throw new Error("lng");
  if (typeof locationHint !== "string") throw new Error("hint");
  const hintBytes = Buffer.from(locationHint, "utf8");
  if (hintBytes.length === 0 || hintBytes.length > MAX_HINT_LEN) throw new Error("hint");
  const id = voucherId ? asVoucherId(voucherId) : randomVoucherId(rng);
  const loot = parseLootId(lootId);
  const message = buildVoucherMessageV1({
    cluster,
    programId,
    player,
    voucherId: id,
    lootId: loot,
    latE6,
    lngE6,
    locationHint,
    issuedAt,
    expiresAt,
  });
  if (!secretKey || secretKey.length !== 64) throw new Error("secretKey");
  const signature = Buffer.from(nacl.sign.detached(message, secretKey));
  return {
    voucher: {
      v: 1,
      voucherId: id.toString("hex"),
      lootId: loot.toString(),
      latE6,
      lngE6,
      locationHint,
      issuedAt,
      expiresAt,
    },
    message,
    signature,
    programId: new PublicKey(programId).toBase58(),
    cluster,
    ttlSeconds: effectiveTtl,
  };
}

// `timestamp` and `player` on the request body are ignored. The signed player
// is the authenticated wallet field, and the clock is the server clock.
function buildClaimFromRequest(body, deps) {
  return createClaimVoucher({
    cluster: deps.cluster,
    programId: deps.programId,
    player: body.wallet,
    lootId: body.loot_id,
    latitude: Number(body.latitude),
    longitude: Number(body.longitude),
    locationHint: body.location_hint,
    nowSeconds: deps.nowSeconds,
    ttlSeconds: deps.ttlSeconds,
    secretKey: deps.secretKey,
    voucherId: deps.voucherId,
    rng: deps.rng,
  });
}

module.exports = {
  DOMAIN,
  VOUCHER_MSG_LEN,
  MAX_HINT_LEN,
  MAX_VOUCHER_TTL_SECS,
  CLUSTER_TAG,
  randomVoucherId,
  toE6,
  buildVoucherMessageV1,
  createClaimVoucher,
  buildClaimFromRequest,
};
