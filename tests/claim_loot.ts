/**
 * Anchor local-validator coverage for claim_loot.
 * Metaplex is loaded by Anchor.toml genesis (upgradeable, pinned address).
 */
import * as assert from "assert";
import { createHash } from "crypto";
import * as fs from "fs";
import * as nacl from "tweetnacl";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("GDGexnGtZPoD1aHv6qg8hjeSspujwWnxJCtdrrj2gKpP");
const METADATA_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const FEE = 100n * 1_000_000_000n;

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function pda(seeds: Array<Buffer | Uint8Array>): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

function loadPayer(): Keypair {
  const file = process.env.ANCHOR_WALLET;
  if (!file) throw new Error("ANCHOR_WALLET is unset");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

function voucherMessage(player: PublicKey, voucherId: Buffer, lootId: bigint, now: number): Buffer {
  const buf = Buffer.alloc(169);
  let offset = 0;
  const put = (part: Buffer) => {
    part.copy(buf, offset);
    offset += part.length;
  };
  put(Buffer.from("FIZZCAPS:LOOT_VOUCHER:v1", "ascii"));
  put(Buffer.from([3]));
  put(PROGRAM_ID.toBuffer());
  put(player.toBuffer());
  put(voucherId);
  const loot = Buffer.alloc(8);
  loot.writeBigUInt64LE(lootId);
  put(loot);
  const lat = Buffer.alloc(4);
  lat.writeInt32LE(36_012_345);
  put(lat);
  const lng = Buffer.alloc(4);
  lng.writeInt32LE(-115_139_000);
  put(lng);
  put(createHash("sha256").update("vault-77").digest());
  const issued = Buffer.alloc(8);
  issued.writeBigInt64LE(BigInt(now));
  put(issued);
  const expires = Buffer.alloc(8);
  expires.writeBigInt64LE(BigInt(now + 300));
  put(expires);
  if (offset !== 169) throw new Error("layout");
  return buf;
}

function voucherData(voucherId: Buffer, lootId: bigint, now: number): Buffer {
  const hint = Buffer.from("vault-77");
  const parts = [disc("claim_loot"), voucherId];
  const loot = Buffer.alloc(8);
  loot.writeBigUInt64LE(lootId);
  parts.push(loot);
  const lat = Buffer.alloc(4);
  lat.writeInt32LE(36_012_345);
  parts.push(lat);
  const lng = Buffer.alloc(4);
  lng.writeInt32LE(-115_139_000);
  parts.push(lng);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(hint.length);
  parts.push(len, hint);
  const issued = Buffer.alloc(8);
  issued.writeBigInt64LE(BigInt(now));
  parts.push(issued);
  const expires = Buffer.alloc(8);
  expires.writeBigInt64LE(BigInt(now + 300));
  parts.push(expires);
  return Buffer.concat(parts);
}

function claimIx(
  player: PublicKey,
  capsMint: PublicKey,
  lootMint: PublicKey,
  voucherId: Buffer,
  lootId: bigint,
  now: number,
): TransactionInstruction {
  const metadata = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_ID.toBuffer(), lootMint.toBuffer()],
    METADATA_ID,
  )[0];
  const edition = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_ID.toBuffer(), lootMint.toBuffer(), Buffer.from("edition")],
    METADATA_ID,
  )[0];
  const lootSeed = Buffer.alloc(8);
  lootSeed.writeBigUInt64LE(lootId);
  const keys = [
    { pubkey: player, isSigner: true, isWritable: true },
    { pubkey: pda([Buffer.from("fizz-config")]), isSigner: false, isWritable: false },
    { pubkey: capsMint, isSigner: false, isWritable: true },
    {
      pubkey: getAssociatedTokenAddressSync(capsMint, player),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: lootMint, isSigner: true, isWritable: true },
    {
      pubkey: getAssociatedTokenAddressSync(lootMint, player),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: pda([Buffer.from("loot-mint-auth")]), isSigner: false, isWritable: false },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: edition, isSigner: false, isWritable: true },
    {
      pubkey: pda([Buffer.from("voucher-claim"), voucherId]),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: pda([Buffer.from("loot-claim"), lootSeed]),
      isSigner: false,
      isWritable: true,
    },
  ];
  keys.push(
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: METADATA_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  );
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: voucherData(voucherId, lootId, now),
  });
}

function signedClaim(
  server: nacl.SignKeyPair,
  messagePlayer: PublicKey,
  txPlayer: PublicKey,
  capsMint: PublicKey,
  lootMint: PublicKey,
  voucherId: Buffer,
  lootId: bigint,
  now: number,
): TransactionInstruction[] {
  const message = voucherMessage(messagePlayer, voucherId, lootId, now);
  const signature = nacl.sign.detached(message, server.secretKey);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: Buffer.from(server.publicKey),
      message,
      signature: Buffer.from(signature),
    }),
    claimIx(txPlayer, capsMint, lootMint, voucherId, lootId, now),
  ];
}

async function send(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  extra: Keypair[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, [payer, ...extra], {
    commitment: "confirmed",
  });
}

describe("claim_loot", () => {
  const connection = new Connection(process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899", "confirmed");
  const payer = loadPayer();
  const server = nacl.sign.keyPair();
  let capsMint: PublicKey;

  before(async () => {
    const metadata = await connection.getAccountInfo(METADATA_ID);
    assert.ok(metadata?.executable, "Metaplex genesis program is not executable");
    capsMint = await createMint(connection, payer, payer.publicKey, null, 9);
    const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER)[0];
    const data = Buffer.concat([disc("fizz_init"), Buffer.from(server.publicKey)]);
    await send(
      connection,
      payer,
      [
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: programData, isSigner: false, isWritable: false },
            { pubkey: pda([Buffer.from("fizz-config")]), isSigner: false, isWritable: true },
            { pubkey: capsMint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        }),
      ],
      [],
    );
    const ata = await createAssociatedTokenAccount(connection, payer, capsMint, payer.publicKey);
    await mintTo(connection, payer, capsMint, ata, payer, FEE * 10n);
  });

  it("mints loot, rejects replay, a wrong signer, and a missing ed25519 ix", async () => {
    const now = Math.floor(Date.now() / 1000);
    const before = await getAccount(
      connection,
      getAssociatedTokenAddressSync(capsMint, payer.publicKey),
    );
    const lootMint = Keypair.generate();
    const voucherId = Buffer.alloc(16, 9);
    await send(
      connection,
      payer,
      signedClaim(server, payer.publicKey, payer.publicKey, capsMint, lootMint.publicKey, voucherId, 7n, now),
      [lootMint],
    );
    const after = await getAccount(
      connection,
      getAssociatedTokenAddressSync(capsMint, payer.publicKey),
    );
    assert.equal(before.amount - after.amount, FEE);
    const lootAta = await getAccount(
      connection,
      getAssociatedTokenAddressSync(lootMint.publicKey, payer.publicKey),
    );
    assert.equal(lootAta.amount, 1n);
    const metadata = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_ID.toBuffer(), lootMint.publicKey.toBuffer()],
      METADATA_ID,
    )[0];
    const metadataInfo = await connection.getAccountInfo(metadata);
    assert.equal(metadataInfo?.owner.toBase58(), METADATA_ID.toBase58());
    assert.ok((metadataInfo?.data.length || 0) > 32);

    const replayMint = Keypair.generate();
    await assert.rejects(() =>
      send(
        connection,
        payer,
        signedClaim(
          server,
          payer.publicKey,
          payer.publicKey,
          capsMint,
          replayMint.publicKey,
          voucherId,
          7n,
          now,
        ),
        [replayMint],
      ),
    );

    const imposter = Keypair.generate();
    const fund = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: imposter.publicKey,
        lamports: 2_000_000_000,
      }),
    );
    await sendAndConfirmTransaction(connection, fund, [payer]);
    const imposterAta = await createAssociatedTokenAccount(
      connection,
      payer,
      capsMint,
      imposter.publicKey,
    );
    await mintTo(connection, payer, capsMint, imposterAta, payer, FEE);
    const wrongMint = Keypair.generate();
    await assert.rejects(() =>
      send(
        connection,
        imposter,
        signedClaim(
          server,
          payer.publicKey,
          imposter.publicKey,
          capsMint,
          wrongMint.publicKey,
          Buffer.alloc(16, 4),
          8n,
          now,
        ),
        [wrongMint],
      ),
    );

    const bareMint = Keypair.generate();
    await assert.rejects(() =>
      send(
        connection,
        payer,
        [claimIx(payer.publicKey, capsMint, bareMint.publicKey, Buffer.alloc(16, 5), 9n, now)],
        [bareMint],
      ),
    );
  });
});
