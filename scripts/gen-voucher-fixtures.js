"use strict";

const fs = require("fs");
const path = require("path");
const nacl = require("tweetnacl");
const { Ed25519Program } = require("@solana/web3.js");
const { buildVoucherMessageV1 } = require("../lib/voucherV1");

const outDir = path.join(__dirname, "..", "programs/fizzcaps-onchain/fixtures");
fs.mkdirSync(outDir, { recursive: true });

const inputs = {
  program_id: "GDGexnGtZPoD1aHv6qg8hjeSspujwWnxJCtdrrj2gKpP",
  player: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  voucher_id_hex: "00112233445566778899aabbccddeeff",
  loot_id: 42,
  lat_e6: 36012345,
  lng_e6: -115139000,
  location_hint: "vault-77",
  issued_at: 1760000000,
  expires_at: 1760000300,
  cluster: "localnet",
  cluster_tag: 3,
};

const message = buildVoucherMessageV1({
  cluster: inputs.cluster,
  programId: inputs.program_id,
  player: inputs.player,
  voucherId: Buffer.from(inputs.voucher_id_hex, "hex"),
  lootId: inputs.loot_id,
  latE6: inputs.lat_e6,
  lngE6: inputs.lng_e6,
  locationHint: inputs.location_hint,
  issuedAt: inputs.issued_at,
  expiresAt: inputs.expires_at,
});
if (message.length !== 169) throw new Error("message length");

const golden = { ...inputs, message_hex: message.toString("hex") };
fs.writeFileSync(
  path.join(outDir, "voucher_v1_golden.json"),
  JSON.stringify(golden, null, 2) + "\n",
);

const seed = Buffer.alloc(32, 7);
const kp = nacl.sign.keyPair.fromSeed(seed);
const signature = nacl.sign.detached(message, kp.secretKey);
const ix = Ed25519Program.createInstructionWithPublicKey({
  publicKey: kp.publicKey,
  message,
  signature,
});
const data = Buffer.from(ix.data);
if (data[0] !== 1) throw new Error("num sigs");
const sigOff = data.readUInt16LE(2);
const pkOff = data.readUInt16LE(6);
const msgOff = data.readUInt16LE(10);
if (pkOff !== 16 || sigOff !== 48 || msgOff !== 112) {
  throw new Error(`unexpected web3.js layout pk=${pkOff} sig=${sigOff} msg=${msgOff}`);
}

const ed = {
  public_key_hex: Buffer.from(kp.publicKey).toString("hex"),
  signature_hex: Buffer.from(signature).toString("hex"),
  message_hex: message.toString("hex"),
  instruction_data_hex: data.toString("hex"),
};
fs.writeFileSync(
  path.join(outDir, "ed25519_ix_fixture.json"),
  JSON.stringify(ed, null, 2) + "\n",
);
console.log("wrote fixtures to", outDir);
