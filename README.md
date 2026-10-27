# Atomic Fizz Caps 🥤☢️

> **Canonical program:** [Unwrenchable/ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS](https://github.com/Unwrenchable/ATOMIC-FIZZ-CAPS-VAULT-77-WASTELAND-GPS).
> This repository is a **variant**. Localnet program id: `GDGexnGtZPoD1aHv6qg8hjeSspujwWnxJCtdrrj2gKpP`. Devnet: `35LPiBoJFQmxhWW7sA1rZzN3yZ5zK6NcSj3cCmub4961`. Mainnet: `3ZW9YUd1cEYnxRm8vwef71QfETgMGVZMF3zXM8xMQ6ht`.
> Fixes here are not a deployment of the canonical program, and nothing in this tree should be merged or deployed without a separate review.

**A Fallout-inspired real-world geo-location adventure game powered by Solana blockchain.**

Explore the Mojave Wasteland in real life: Use your phone's GPS to hunt for iconic Fallout locations (Hoover Dam, New Vegas Strip, hidden vaults, irradiated sites), claim loot when close enough, earn **CAPS** (in-game currency), accumulate radiation, level up, and mint rewards via your Phantom wallet.

Built with Leaflet maps, Solana web3.js, and a retro Pip-Boy 3000 interface – green glow, VT323 font, status bars for HP/RADS/CAPS.

Play now:(https://atomicfizzcaps.xyz/)

## 🌵 Gameplay Features

- **Real-World GPS Hunting**: Markers at real Fallout-inspired locations (Hoover Dam, Helios One, Vault sites, Chernobyl, Trinity Site, etc.). Get within ~50m to claim.
- **Pip-Boy UI**: Retro green glow, HP/Radiation bar, Level, CAPS counter, claimed count.
- **Quests System**: Deep main and side quests with multiple endings, objectives, and consequences (data loaded from `/quests` endpoint).
- **Loot & Rewards**: Claim CAPS, gear, radiation buildup. Wallet-signed claims for on-chain security.
- **Scavenger's Exchange**: Shop for NFTs/CAPS using in-game currency or direct SOL payments (QR code support).
- **Solana Integration**: Phantom wallet connect, signed messages for claims/purchases.
- **Progression**: Level up, manage radiation, collect gear.

## On-chain variant (`programs/fizzcaps-onchain`)

`claim_loot` rebuilds a 169-byte `LootVoucherV1` message and checks the Ed25519 precompile instruction immediately before it. The signer must be `FizzConfig.server_key`. The player, program id, and cluster tag are inside that message. Replay is two PDAs: `voucher-claim` (one per `voucher_id`) and `loot-claim` (one per `loot_id`). A second use fails with the system program's "already in use". Each claim also pays rent for both accounts.

`fizz_init` can only be signed by the program's upgrade authority. The instruction reads the upgradeable loader's `ProgramData` account (seeds `[program id]`, loader `BPFLoaderUpgradeab1e...`) and rejects every other signer. The signer passes an existing SPL mint with **9 decimals**; the program stores that address on `FizzConfig` and `claim_loot` burns from it. `fizz_set_paused(true)` stops claims. `fizz_set_server_key` rotates the voucher signer; it is signed by `config.authority` (the upgrade authority recorded at init).

Vouchers live at most **300 seconds** (`issued_at` / `expires_at`). The backend draws `voucher_id` from `crypto.randomBytes(16)`.

There is no default cluster feature. Pass exactly one of `--features localnet`, `--features devnet`, or `--features mainnet` (and `--no-default-features`). Enabling zero or two or more features is a compile error. `node scripts/check-declare-id.js` checks that each `declare_id!` matches `Anchor.toml`. The three ids are different. The mainnet table is `[programs.mainnet]`: Anchor CLI 0.32 parses those keys as clusters and rejects `mainnet-beta`. The backend cluster name stays `mainnet-beta`.

`/claim-nonce` stores a 120-second SIWS nonce in Redis. `/claim-voucher` checks a wallet signature over `domain`, `wallet`, `loot_id`, `nonce`, and `issued_at` with tweetnacl, consumes the nonce with `GETDEL`, ignores any wallet in the body, looks the hint and coordinates up from `data/locations.json` (`loot_id` is the 1-based index), and rejects positions outside `CLAIM_RADIUS_METERS` (default 50). The cooldown is `SET key value EX seconds NX`. Both claim routes are rate-limited per IP. `CORS_ORIGINS` defaults to `https://atomicfizzcaps.xyz,http://localhost:3000`; a missing `Origin` is allowed and any other origin is rejected.

Required server env for `/claim-voucher`: `SOLANA_CLUSTER` (`localnet`, `devnet`, or `mainnet-beta`) and `FIZZCAPS_PROGRAM_ID`. Optional `VOUCHER_TTL_SECONDS` is clamped to 300. Optional `SIWS_DOMAIN` defaults to `atomicfizzcaps.xyz`. The client puts `Ed25519Program.createInstructionWithPublicKey` (default instruction index `0xffff`) immediately before `claim_loot`.

Server-key rotation: generate a fresh Ed25519 key that has never lived in `.env`, CI, or logs; call `fizz_set_server_key` as `config.authority`; then point the backend at the new secret. Old vouchers stop verifying immediately.

SBF builds need platform-tools v1.58. Agave CLI 2.3.0's default tools are v1.48 (rustc 1.84.1) and cannot parse this crate's edition2024 dependencies. Put `scripts/` first on `PATH` so `anchor build` hits `scripts/cargo-build-sbf`, which passes `--tools-version v1.58`.

```bash
export PATH="$(pwd)/scripts:$PATH"
node scripts/check-declare-id.js
bash scripts/check-cluster-features.sh
cargo test -p fizzcaps_onchain --lib --no-default-features --features localnet
cargo test -p fizzcaps_onchain --lib --no-default-features --features devnet
cargo test -p fizzcaps_onchain --lib --no-default-features --features mainnet
node --test tests/voucherV1.test.js tests/claimAuth.test.js
cargo-build-sbf --manifest-path programs/fizzcaps-onchain/Cargo.toml --no-default-features --features localnet -- --locked
anchor build -- --no-default-features --features localnet
cargo test -p fizzcaps_onchain --test claim_flow --no-default-features --features localnet -- --nocapture
anchor test --skip-build
```

## 🛠️ Tech Stack

- Frontend: Pure HTML/CSS/JS with Leaflet for maps, QRCode.js
- Backend: Node.js + Express (server.js)
- Blockchain: @solana/web3.js, bs58, Phantom wallet
- Database: Redis (ioredis) for player data
- Security: CORS allowlist, Helmet, per-IP rate-limiting, Morgan logging
- License: MIT

## 📢 Roadmap

- More real-world locations & dynamic events
- On-chain NFT minting for rare loot
- Leaderboards & multiplayer challenges
- Mobile PWA support

**Survive the Wasteland. Claim your CAPS. War... war never changes.** ☢️

Developed by **Unwrenchable** | Powered by Solana
