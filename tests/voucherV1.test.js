"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nacl = require("tweetnacl");
const { Ed25519Program, Keypair, PublicKey } = require("@solana/web3.js");
const {
  CLUSTER_TAG,
  MAX_VOUCHER_TTL_SECS,
  VOUCHER_MSG_LEN,
  buildClaimFromRequest,
  buildVoucherMessageV1,
  createClaimVoucher,
  randomVoucherId,
  toE6,
} = require("../lib/voucherV1");
const { checkDeclareIds } = require("../scripts/check-declare-id");

const root = path.join(__dirname, "..");
const golden = JSON.parse(
  fs.readFileSync(
    path.join(root, "programs/fizzcaps-onchain/fixtures/voucher_v1_golden.json"),
    "utf8",
  ),
);
const edFixture = JSON.parse(
  fs.readFileSync(
    path.join(root, "programs/fizzcaps-onchain/fixtures/ed25519_ix_fixture.json"),
    "utf8",
  ),
);

test("golden message matches the committed fixture", () => {
  const message = buildVoucherMessageV1({
    cluster: golden.cluster,
    programId: golden.program_id,
    player: golden.player,
    voucherId: Buffer.from(golden.voucher_id_hex, "hex"),
    lootId: golden.loot_id,
    latE6: golden.lat_e6,
    lngE6: golden.lng_e6,
    locationHint: golden.location_hint,
    issuedAt: golden.issued_at,
    expiresAt: golden.expires_at,
  });
  assert.equal(message.length, VOUCHER_MSG_LEN);
  assert.equal(message.toString("hex"), golden.message_hex);
  assert.equal(message[24], CLUSTER_TAG.localnet);
  assert.equal(MAX_VOUCHER_TTL_SECS, 300);
  assert.equal(golden.expires_at - golden.issued_at, 300);
});

test("message binds the player and the cluster", () => {
  const other = Keypair.generate().publicKey.toBase58();
  const base = {
    cluster: "localnet",
    programId: golden.program_id,
    player: golden.player,
    voucherId: Buffer.from(golden.voucher_id_hex, "hex"),
    lootId: golden.loot_id,
    latE6: golden.lat_e6,
    lngE6: golden.lng_e6,
    locationHint: golden.location_hint,
    issuedAt: golden.issued_at,
    expiresAt: golden.expires_at,
  };
  const bound = buildVoucherMessageV1(base);
  const otherPlayer = buildVoucherMessageV1({ ...base, player: other });
  const devnet = buildVoucherMessageV1({ ...base, cluster: "devnet" });
  assert.notEqual(bound.toString("hex"), otherPlayer.toString("hex"));
  assert.ok(otherPlayer.subarray(57, 89).equals(new PublicKey(other).toBuffer()));
  assert.equal(devnet[24], 2);
  assert.notEqual(devnet[24], bound[24]);
});

test("toE6 rounds half away from zero", () => {
  assert.equal(toE6(36.012345), 36012345);
  assert.equal(toE6(0.0000015), 2);
  assert.equal(toE6(-0.0000015), -2);
  assert.equal(toE6(-115.5), -115500000);
});

test("voucher id comes from a 16-byte CSPRNG", () => {
  const src = fs.readFileSync(require.resolve("../lib/voucherV1"), "utf8");
  assert.match(src, /crypto\.randomBytes\(n\)/);
  assert.match(src, /rng\(16\)/);
  assert.doesNotMatch(src, /Math\.random/);
  let seen = 0;
  const id = randomVoucherId((n) => {
    seen = n;
    return Buffer.alloc(16, 9);
  });
  assert.equal(seen, 16);
  assert.equal(id.length, 16);
  const a = randomVoucherId();
  const b = randomVoucherId();
  assert.equal(a.length, 16);
  assert.equal(b.length, 16);
  assert.notDeepEqual(a, b);
});

test("claim voucher signs the v1 message for the wallet and clamps ttl to 300", () => {
  const secret = nacl.sign.keyPair.fromSeed(Buffer.alloc(32, 4));
  const issued = createClaimVoucher({
    cluster: "localnet",
    programId: golden.program_id,
    player: golden.player,
    lootId: "42",
    latitude: 36.012345,
    longitude: -115.139,
    locationHint: "vault-77",
    nowSeconds: 1_760_000_000,
    ttlSeconds: 900,
    secretKey: secret.secretKey,
    voucherId: Buffer.from(golden.voucher_id_hex, "hex"),
  });
  assert.equal(issued.ttlSeconds, 300);
  assert.equal(issued.voucher.expiresAt - issued.voucher.issuedAt, 300);
  assert.equal(issued.voucher.issuedAt, 1_760_000_000);
  assert.equal(issued.signature.length, 64);
  assert.ok(nacl.sign.detached.verify(issued.message, issued.signature, secret.publicKey));
  assert.ok(issued.message.subarray(57, 89).equals(new PublicKey(golden.player).toBuffer()));
});

test("request body player and timestamp are ignored", () => {
  const secret = nacl.sign.keyPair.fromSeed(Buffer.alloc(32, 5));
  const wallet = golden.player;
  const imposter = Keypair.generate().publicKey.toBase58();
  const issued = buildClaimFromRequest(
    {
      wallet,
      player: imposter,
      timestamp: 1,
      loot_id: "42",
      latitude: 36.012345,
      longitude: -115.139,
      location_hint: "vault-77",
    },
    {
      cluster: "localnet",
      programId: golden.program_id,
      nowSeconds: 1_760_000_100,
      ttlSeconds: 300,
      secretKey: secret.secretKey,
      voucherId: Buffer.from(golden.voucher_id_hex, "hex"),
    },
  );
  assert.equal(issued.voucher.issuedAt, 1_760_000_100);
  assert.notEqual(issued.voucher.issuedAt, 1);
  assert.ok(issued.message.subarray(57, 89).equals(new PublicKey(wallet).toBuffer()));
  assert.ok(!issued.message.subarray(57, 89).equals(new PublicKey(imposter).toBuffer()));
});

test("ed25519 fixture is the real web3.js layout", () => {
  const message = Buffer.from(edFixture.message_hex, "hex");
  const signature = Buffer.from(edFixture.signature_hex, "hex");
  const publicKey = Buffer.from(edFixture.public_key_hex, "hex");
  const ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey,
    message,
    signature,
  });
  assert.equal(Buffer.from(ix.data).toString("hex"), edFixture.instruction_data_hex);
  const data = Buffer.from(ix.data);
  assert.equal(data.readUInt16LE(2), 48);
  assert.equal(data.readUInt16LE(4), 0xffff);
  assert.equal(data.readUInt16LE(6), 16);
  assert.equal(data.readUInt16LE(8), 0xffff);
  assert.equal(data.readUInt16LE(10), 112);
  assert.equal(data.readUInt16LE(14), 0xffff);
  assert.ok(data.subarray(16, 48).equals(publicKey));
  assert.ok(data.subarray(48, 112).equals(signature));
  assert.ok(data.subarray(112).equals(message));
  assert.ok(nacl.sign.detached.verify(message, signature, publicKey));
});

test("declare_id matches Anchor.toml", () => {
  const libSrc = fs.readFileSync(
    path.join(root, "programs/fizzcaps-onchain/src/lib.rs"),
    "utf8",
  );
  const anchorSrc = fs.readFileSync(path.join(root, "Anchor.toml"), "utf8");
  const result = checkDeclareIds(libSrc, anchorSrc);
  assert.equal(result.declared.localnet, golden.program_id);
  const ids = [result.declared.localnet, result.declared.devnet, result.declared.mainnet];
  assert.equal(new Set(ids).size, 3);
  assert.notEqual(result.anchor.mainnet, result.anchor.devnet);
  assert.throws(() => checkDeclareIds(libSrc.replaceAll(golden.program_id, "11111111111111111111111111111111"), anchorSrc));
});

test("rng output that is not 16 bytes is rejected", () => {
  assert.throws(() => randomVoucherId(() => crypto.randomBytes(8)));
});
