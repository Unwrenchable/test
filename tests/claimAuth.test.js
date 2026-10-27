"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const nacl = require("tweetnacl");
const { Keypair, PublicKey } = require("@solana/web3.js");
const {
  ClaimAuthError,
  authorizeClaim,
  buildSiwsMessage,
  corsAllowlist,
  haversineMeters,
  issueNonce,
} = require("../lib/claimAuth");

const locations = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../data/locations.json"), "utf8"),
);
const secret = nacl.sign.keyPair.fromSeed(Buffer.alloc(32, 9));
const domain = "atomicfizzcaps.xyz";
const programId = "GDGexnGtZPoD1aHv6qg8hjeSspujwWnxJCtdrrj2gKpP";

class MemoryRedis {
  constructor() {
    this.map = new Map();
  }
  async set(key, value, ...rest) {
    if (rest.includes("NX") && this.map.has(key)) return null;
    this.map.set(key, String(value));
    return "OK";
  }
  async getdel(key) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    this.map.delete(key);
    return value;
  }
  async del(key) {
    this.map.delete(key);
    return 1;
  }
}

function signClaim(wallet, { lootId, nonce, issuedAt }) {
  const message = buildSiwsMessage({
    domain,
    wallet: wallet.publicKey.toBase58(),
    lootId,
    nonce,
    issuedAt,
  });
  const signature = Buffer.from(
    nacl.sign.detached(Buffer.from(message, "utf8"), wallet.secretKey),
  );
  return { message, signature: signature.toString("base64") };
}

async function claim(redis, fields, overrides = {}) {
  return authorizeClaim({
    redis,
    locations,
    nowSeconds: 1_760_000_000,
    domain,
    radiusMeters: 50,
    cooldownSeconds: 60,
    cluster: "localnet",
    programId,
    ttlSeconds: 300,
    secretKey: secret.secretKey,
    voucherId: Buffer.alloc(16, 3),
    ...fields,
    ...overrides,
  });
}

test("cors allowlist defaults to the site and localhost", () => {
  assert.deepEqual(corsAllowlist(undefined), [
    "https://atomicfizzcaps.xyz",
    "http://localhost:3000",
  ]);
  assert.deepEqual(corsAllowlist(" https://a.example , http://b "), [
    "https://a.example",
    "http://b",
  ]);
});

test("nonce is single use and proximity uses the location file", async () => {
  const redis = new MemoryRedis();
  const wallet = Keypair.generate();
  const issued = await issueNonce(redis, {
    domain,
    randomBytes: () => Buffer.alloc(16, 4),
  });
  assert.equal(issued.ttl, 120);
  assert.equal(issued.nonce, "04".repeat(16));
  const spot = locations[0];
  const signed = signClaim(wallet, {
    lootId: 1,
    nonce: issued.nonce,
    issuedAt: 1_760_000_000,
  });
  const voucher = await claim(redis, {
    ...signed,
    latitude: spot.lat,
    longitude: spot.lng,
  });
  assert.equal(voucher.voucher.locationHint, spot.n);
  assert.equal(voucher.voucher.lootId, "1");
  assert.ok(
    voucher.message
      .subarray(57, 89)
      .equals(wallet.publicKey.toBuffer()),
  );
  await assert.rejects(
    () => claim(redis, { ...signed, latitude: spot.lat, longitude: spot.lng }),
    (err) => err instanceof ClaimAuthError && err.status === 401 && err.code === "nonce",
  );
});

test("body wallet is not an input and a far position is rejected", async () => {
  const redis = new MemoryRedis();
  const wallet = Keypair.generate();
  const imposter = Keypair.generate().publicKey.toBase58();
  const issued = await issueNonce(redis, { domain, randomBytes: () => Buffer.alloc(16, 5) });
  const signed = signClaim(wallet, {
    lootId: 1,
    nonce: issued.nonce,
    issuedAt: 1_760_000_010,
  });
  const spot = locations[0];
  const voucher = await claim(redis, signed, {
    nowSeconds: 1_760_000_010,
    latitude: spot.lat + 0.0001,
    longitude: spot.lng,
    bodyWallet: imposter,
  });
  assert.ok(voucher.message.subarray(57, 89).equals(wallet.publicKey.toBuffer()));
  assert.ok(!voucher.message.subarray(57, 89).equals(new PublicKey(imposter).toBuffer()));

  const redis2 = new MemoryRedis();
  const again = await issueNonce(redis2, { domain, randomBytes: () => Buffer.alloc(16, 6) });
  const far = signClaim(wallet, {
    lootId: 1,
    nonce: again.nonce,
    issuedAt: 1_760_000_000,
  });
  await assert.rejects(
    () => claim(redis2, { ...far, latitude: spot.lat + 0.01, longitude: spot.lng }),
    (err) => err instanceof ClaimAuthError && err.status === 403,
  );
  assert.ok(haversineMeters(spot.lat, spot.lng, spot.lat + 0.01, spot.lng) > 50);
});

test("cooldown is a single NX reservation and stale signatures fail", async () => {
  const redis = new MemoryRedis();
  const wallet = Keypair.generate();
  const first = await issueNonce(redis, { domain, randomBytes: () => Buffer.alloc(16, 7) });
  const second = await issueNonce(redis, { domain, randomBytes: () => Buffer.alloc(16, 8) });
  const spot = locations[3];
  const ok = signClaim(wallet, {
    lootId: 4,
    nonce: first.nonce,
    issuedAt: 1_760_000_000,
  });
  await claim(redis, { ...ok, latitude: spot.lat, longitude: spot.lng });
  const blocked = signClaim(wallet, {
    lootId: 4,
    nonce: second.nonce,
    issuedAt: 1_760_000_000,
  });
  await assert.rejects(
    () => claim(redis, { ...blocked, latitude: spot.lat, longitude: spot.lng }),
    (err) => err instanceof ClaimAuthError && err.status === 429,
  );

  const redis3 = new MemoryRedis();
  const old = await issueNonce(redis3, { domain, randomBytes: () => Buffer.alloc(16, 1) });
  const stale = signClaim(wallet, {
    lootId: 4,
    nonce: old.nonce,
    issuedAt: 1_760_000_000 - 121,
  });
  await assert.rejects(
    () =>
      claim(redis3, stale, {
        latitude: spot.lat,
        longitude: spot.lng,
      }),
    (err) => err instanceof ClaimAuthError && err.status === 401,
  );
});

test("a bad signature and an unknown loot id are rejected", async () => {
  const redis = new MemoryRedis();
  const wallet = Keypair.generate();
  const issued = await issueNonce(redis, { domain, randomBytes: () => Buffer.alloc(16, 2) });
  const signed = signClaim(wallet, {
    lootId: 1,
    nonce: issued.nonce,
    issuedAt: 1_760_000_000,
  });
  const flipped = Buffer.from(signed.signature, "base64");
  flipped[0] ^= 0xff;
  await assert.rejects(
    () =>
      claim(redis, {
        message: signed.message,
        signature: flipped.toString("base64"),
        latitude: locations[0].lat,
        longitude: locations[0].lng,
      }),
    (err) => err instanceof ClaimAuthError && err.code === "unauthorized",
  );
  const redis4 = new MemoryRedis();
  const other = await issueNonce(redis4, { domain, randomBytes: () => Buffer.alloc(16, 3) });
  const missing = signClaim(wallet, {
    lootId: locations.length + 1,
    nonce: other.nonce,
    issuedAt: 1_760_000_000,
  });
  await assert.rejects(
    () =>
      claim(redis4, {
        ...missing,
        latitude: locations[0].lat,
        longitude: locations[0].lng,
      }),
    (err) => err instanceof ClaimAuthError && err.status === 404,
  );
});

test("claim route wires SIWS and ignores the body wallet", () => {
  const src = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = src.indexOf("app.post('/claim-voucher'");
  const route = src.slice(start, src.indexOf("app.get('*'", start));
  assert.match(route, /authorizeClaim\(/);
  assert.match(route, /req\.body\.message/);
  assert.doesNotMatch(route, /req\.body\.wallet/);
  assert.doesNotMatch(route, /buildClaimFromRequest/);
  assert.match(src, /app\.post\('\/claim-nonce'/);
  assert.match(src, /'\/api\/terminal-reward'/);
  assert.match(src, /claimIpLimiter/);
});
