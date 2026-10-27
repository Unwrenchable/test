//! Executes the localnet SBF build and the Metaplex token-metadata ELF
//! inside solana-program-test.
//!
//! Covers a 0-decimal mint rejection, a 9-decimal fizz_init, a claim, a
//! voucher replay, a player that does not match the voucher, and a claim
//! with no Ed25519 instruction.

use std::path::PathBuf;

use sha2::{Digest, Sha256};
use solana_program_test::*;
use solana_sdk::{
    account::Account,
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    compute_budget::ComputeBudgetInstruction,
    ed25519_program,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    rent::Rent,
    signature::{Keypair, Signer},
    program_pack::Pack,
    system_instruction, system_program, sysvar,
    transaction::Transaction,
};
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account,
};
use spl_token::{
    instruction::{initialize_mint2, mint_to},
    state::{Account as TokenAccount, Mint},
    ID as TOKEN_PROGRAM_ID,
};

const METADATA_ID: Pubkey = solana_sdk::pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const ATA_PROGRAM_ID: Pubkey = spl_associated_token_account::ID;
const NOW: i64 = 1_760_000_000;
const FEE: u64 = 100 * 1_000_000_000;

fn workspace_file(rel: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()))
}

fn disc(name: &str) -> [u8; 8] {
    let hash = Sha256::digest(format!("global:{name}"));
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash[..8]);
    out
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &fizzcaps_onchain::ID).0
}

fn meta(key: Pubkey, writable: bool, signer: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(key, signer)
    } else {
        AccountMeta::new_readonly(key, signer)
    }
}

fn upgradeable_program(program_id: &Pubkey, elf: &[u8], authority: &Pubkey) -> [(Pubkey, Account); 2] {
    let program_data =
        Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::id()).0;
    let program_state = bincode::serialize(&UpgradeableLoaderState::Program {
        programdata_address: program_data,
    })
    .unwrap();
    let mut data_state = bincode::serialize(&UpgradeableLoaderState::ProgramData {
        slot: 0,
        upgrade_authority_address: Some(*authority),
    })
    .unwrap();
    data_state.extend_from_slice(elf);
    let rent = Rent::default();
    [
        (
            *program_id,
            Account {
                lamports: rent.minimum_balance(program_state.len()).max(1),
                data: program_state,
                owner: bpf_loader_upgradeable::id(),
                executable: true,
                rent_epoch: 0,
            },
        ),
        (
            program_data,
            Account {
                lamports: rent.minimum_balance(data_state.len()).max(1),
                data: data_state,
                owner: bpf_loader_upgradeable::id(),
                executable: false,
                rent_epoch: 0,
            },
        ),
    ]
}

async fn send(
    ctx: &mut ProgramTestContext,
    payer: &Keypair,
    ixs: &[Instruction],
    extra: &[&Keypair],
) -> Result<(), String> {
    let mut signers = vec![payer];
    signers.extend_from_slice(extra);
    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &signers, blockhash);
    let meta = ctx
        .banks_client
        .process_transaction_with_metadata(tx)
        .await
        .map_err(|err| format!("{err:?}"))?;
    match meta.result {
        Ok(()) => Ok(()),
        Err(err) => {
            let logs = meta
                .metadata
                .map(|m| m.log_messages.join("\n"))
                .unwrap_or_default();
            Err(format!("{err:?}\n{logs}"))
        }
    }
}

async fn must(result: Result<(), String>, what: &str) {
    if let Err(err) = result {
        panic!("{what} failed:\n{err}");
    }
}

async fn create_mint(ctx: &mut ProgramTestContext, payer: &Keypair, decimals: u8) -> Keypair {
    let mint = Keypair::new();
    let rent = Rent::default().minimum_balance(Mint::LEN);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        rent,
        Mint::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init = initialize_mint2(
        &TOKEN_PROGRAM_ID,
        &mint.pubkey(),
        &payer.pubkey(),
        None,
        decimals,
    )
    .unwrap();
    must(send(ctx, payer, &[create, init], &[&mint]).await, "initialize mint").await;
    mint
}

async fn fund_ata(
    ctx: &mut ProgramTestContext,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) {
    let create = create_associated_token_account(&payer.pubkey(), owner, mint, &TOKEN_PROGRAM_ID);
    let ata = get_associated_token_address(owner, mint);
    let mint_ix = mint_to(&TOKEN_PROGRAM_ID, mint, &ata, &payer.pubkey(), &[], amount).unwrap();
    must(send(ctx, payer, &[create, mint_ix], &[]).await, "fund ata").await;
}

async fn token_amount(ctx: &mut ProgramTestContext, address: &Pubkey) -> u64 {
    let account = ctx
        .banks_client
        .get_account(*address)
        .await
        .unwrap()
        .expect("token account");
    TokenAccount::unpack(&account.data).unwrap().amount
}

fn fizz_init_ix(authority: &Pubkey, mint: &Pubkey, server: &Pubkey) -> Instruction {
    let mut data = disc("fizz_init").to_vec();
    data.extend_from_slice(server.as_ref());
    let program_data = Pubkey::find_program_address(
        &[fizzcaps_onchain::ID.as_ref()],
        &bpf_loader_upgradeable::id(),
    )
    .0;
    Instruction {
        program_id: fizzcaps_onchain::ID,
        accounts: vec![
            meta(*authority, true, true),
            meta(fizzcaps_onchain::ID, false, false),
            meta(program_data, false, false),
            meta(pda(&[b"fizz-config"]), true, false),
            meta(*mint, false, false),
            meta(system_program::ID, false, false),
        ],
        data,
    }
}

fn voucher_message(player: &Pubkey, voucher_id: &[u8; 16], loot_id: u64) -> [u8; 169] {
    let mut message = [0u8; 169];
    let mut offset = 0;
    let mut put = |bytes: &[u8]| {
        message[offset..offset + bytes.len()].copy_from_slice(bytes);
        offset += bytes.len();
    };
    put(b"FIZZCAPS:LOOT_VOUCHER:v1");
    put(&[3]);
    put(fizzcaps_onchain::ID.as_ref());
    put(player.as_ref());
    put(voucher_id);
    put(&loot_id.to_le_bytes());
    put(&36_012_345i32.to_le_bytes());
    put(&(-115_139_000i32).to_le_bytes());
    put(Sha256::digest(b"vault-77").as_slice());
    put(&NOW.to_le_bytes());
    put(&(NOW + 300).to_le_bytes());
    assert_eq!(offset, 169);
    message
}

fn voucher_data(voucher_id: &[u8; 16], loot_id: u64) -> Vec<u8> {
    let hint = b"vault-77";
    let mut data = disc("claim_loot").to_vec();
    data.extend_from_slice(voucher_id);
    data.extend_from_slice(&loot_id.to_le_bytes());
    data.extend_from_slice(&36_012_345i32.to_le_bytes());
    data.extend_from_slice(&(-115_139_000i32).to_le_bytes());
    data.extend_from_slice(&(hint.len() as u32).to_le_bytes());
    data.extend_from_slice(hint);
    data.extend_from_slice(&NOW.to_le_bytes());
    data.extend_from_slice(&(NOW + 300).to_le_bytes());
    data
}

fn ed25519_ix(pubkey: &[u8], signature: &[u8], message: &[u8]) -> Instruction {
    let mut data = vec![0u8; 112 + message.len()];
    data[0] = 1;
    data[2..4].copy_from_slice(&48u16.to_le_bytes());
    data[4..6].copy_from_slice(&u16::MAX.to_le_bytes());
    data[6..8].copy_from_slice(&16u16.to_le_bytes());
    data[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
    data[10..12].copy_from_slice(&112u16.to_le_bytes());
    data[12..14].copy_from_slice(&(message.len() as u16).to_le_bytes());
    data[14..16].copy_from_slice(&u16::MAX.to_le_bytes());
    data[16..48].copy_from_slice(pubkey);
    data[48..112].copy_from_slice(signature);
    data[112..].copy_from_slice(message);
    Instruction {
        program_id: ed25519_program::id(),
        accounts: vec![],
        data,
    }
}

fn claim_ix(
    player: &Pubkey,
    caps_mint: &Pubkey,
    loot_mint: &Pubkey,
    voucher_id: &[u8; 16],
    loot_id: u64,
) -> Instruction {
    let metadata = Pubkey::find_program_address(
        &[b"metadata", METADATA_ID.as_ref(), loot_mint.as_ref()],
        &METADATA_ID,
    )
    .0;
    let edition = Pubkey::find_program_address(
        &[
            b"metadata",
            METADATA_ID.as_ref(),
            loot_mint.as_ref(),
            b"edition",
        ],
        &METADATA_ID,
    )
    .0;
    Instruction {
        program_id: fizzcaps_onchain::ID,
        accounts: vec![
            meta(*player, true, true),
            meta(pda(&[b"fizz-config"]), false, false),
            meta(*caps_mint, true, false),
            meta(get_associated_token_address(player, caps_mint), true, false),
            meta(*loot_mint, true, true),
            meta(get_associated_token_address(player, loot_mint), true, false),
            meta(pda(&[b"loot-mint-auth"]), false, false),
            meta(metadata, true, false),
            meta(edition, true, false),
            meta(pda(&[b"voucher-claim", voucher_id]), true, false),
            meta(pda(&[b"loot-claim", &loot_id.to_le_bytes()]), true, false),
            meta(TOKEN_PROGRAM_ID, false, false),
            meta(ATA_PROGRAM_ID, false, false),
            meta(system_program::ID, false, false),
            meta(METADATA_ID, false, false),
            meta(sysvar::instructions::id(), false, false),
        ],
        data: voucher_data(voucher_id, loot_id),
    }
}

fn signed_claim(
    server: &Keypair,
    player_in_message: &Pubkey,
    tx_player: &Pubkey,
    caps_mint: &Pubkey,
    loot_mint: &Pubkey,
    voucher_id: &[u8; 16],
    loot_id: u64,
) -> Vec<Instruction> {
    let message = voucher_message(player_in_message, voucher_id, loot_id);
    let signature = server.sign_message(&message);
    vec![
        ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
        ed25519_ix(server.pubkey().as_ref(), signature.as_ref(), &message),
        claim_ix(tx_player, caps_mint, loot_mint, voucher_id, loot_id),
    ]
}

#[tokio::test]
async fn claim_flow_runs_on_the_local_validator() {
    assert_eq!(
        fizzcaps_onchain::ID.to_string(),
        "GDGexnGtZPoD1aHv6qg8hjeSspujwWnxJCtdrrj2gKpP"
    );
    let authority = Keypair::new();
    let mut program_test = ProgramTest::default();
    program_test.prefer_bpf(true);
    for (key, account) in upgradeable_program(
        &fizzcaps_onchain::ID,
        &workspace_file("../../target/deploy/fizzcaps_onchain.so"),
        &authority.pubkey(),
    ) {
        program_test.add_genesis_account(key, account);
    }
    for (key, account) in upgradeable_program(
        &METADATA_ID,
        &workspace_file("../../tests/fixtures/mpl_token_metadata.so"),
        &authority.pubkey(),
    ) {
        program_test.add_genesis_account(key, account);
    }
    program_test.set_compute_max_units(1_400_000);
    let mut ctx = program_test.start_with_context().await;

    let mut clock = ctx.banks_client.get_sysvar::<Clock>().await.unwrap();
    clock.unix_timestamp = NOW;
    ctx.set_sysvar(&clock);

    let player = Keypair::new();
    let imposter = Keypair::new();
    let server = Keypair::new();
    let funder = ctx.payer.insecure_clone();
    for key in [&authority, &player, &imposter] {
        let tx = system_instruction::transfer(&funder.pubkey(), &key.pubkey(), 20_000_000_000);
        must(send(&mut ctx, &funder, &[tx], &[]).await, "airdrop").await;
    }

    let wrong_decimals = create_mint(&mut ctx, &authority, 0).await;
    let rejected = send(
        &mut ctx,
        &authority,
        &[fizz_init_ix(
            &authority.pubkey(),
            &wrong_decimals.pubkey(),
            &server.pubkey(),
        )],
        &[],
    )
    .await
    .expect_err("0 decimals must fail");
    assert!(
        rejected.contains("caps mint must use 9 decimals")
            || rejected.contains("InvalidCapsDecimals"),
        "{rejected}"
    );

    let caps = create_mint(&mut ctx, &authority, 9).await;
    must(
        send(
            &mut ctx,
            &authority,
            &[fizz_init_ix(
                &authority.pubkey(),
                &caps.pubkey(),
                &server.pubkey(),
            )],
            &[],
        )
        .await,
        "fizz_init",
    )
    .await;
    fund_ata(&mut ctx, &authority, &caps.pubkey(), &player.pubkey(), FEE * 10).await;
    fund_ata(
        &mut ctx,
        &authority,
        &caps.pubkey(),
        &imposter.pubkey(),
        FEE * 10,
    )
    .await;

    let caps_before = token_amount(
        &mut ctx,
        &get_associated_token_address(&player.pubkey(), &caps.pubkey()),
    )
    .await;
    let loot_mint = Keypair::new();
    let voucher_id = [9u8; 16];
    let loot_id = 7u64;
    must(
        send(
            &mut ctx,
            &player,
            &signed_claim(
                &server,
                &player.pubkey(),
                &player.pubkey(),
                &caps.pubkey(),
                &loot_mint.pubkey(),
                &voucher_id,
                loot_id,
            ),
            &[&loot_mint],
        )
        .await,
        "claim",
    )
    .await;
    assert_eq!(
        token_amount(
            &mut ctx,
            &get_associated_token_address(&player.pubkey(), &caps.pubkey()),
        )
        .await,
        caps_before - FEE
    );
    assert_eq!(
        token_amount(
            &mut ctx,
            &get_associated_token_address(&player.pubkey(), &loot_mint.pubkey()),
        )
        .await,
        1
    );
    let metadata = Pubkey::find_program_address(
        &[
            b"metadata",
            METADATA_ID.as_ref(),
            loot_mint.pubkey().as_ref(),
        ],
        &METADATA_ID,
    )
    .0;
    let metadata_account = ctx
        .banks_client
        .get_account(metadata)
        .await
        .unwrap()
        .expect("metadata");
    assert_eq!(metadata_account.owner, METADATA_ID);
    assert!(metadata_account.data.len() > 32);

    let replay_mint = Keypair::new();
    let replay = send(
        &mut ctx,
        &player,
        &signed_claim(
            &server,
            &player.pubkey(),
            &player.pubkey(),
            &caps.pubkey(),
            &replay_mint.pubkey(),
            &voucher_id,
            loot_id,
        ),
        &[&replay_mint],
    )
    .await
    .expect_err("replay must fail");
    assert!(
        replay.to_lowercase().contains("already in use"),
        "{replay}"
    );

    let wrong_mint = Keypair::new();
    let wrong = send(
        &mut ctx,
        &imposter,
        &signed_claim(
            &server,
            &player.pubkey(),
            &imposter.pubkey(),
            &caps.pubkey(),
            &wrong_mint.pubkey(),
            &[4u8; 16],
            8,
        ),
        &[&wrong_mint],
    )
    .await
    .expect_err("wrong signer must fail");
    assert!(
        wrong.contains("Wrong message") || wrong.contains("WrongMessage"),
        "{wrong}"
    );

    let bare_mint = Keypair::new();
    let missing = send(
        &mut ctx,
        &player,
        &[claim_ix(
            &player.pubkey(),
            &caps.pubkey(),
            &bare_mint.pubkey(),
            &[5u8; 16],
            9,
        )],
        &[&bare_mint],
    )
    .await
    .expect_err("missing ed25519 must fail");
    assert!(
        missing.contains("No Ed25519") || missing.contains("NoEd25519Ix"),
        "{missing}"
    );
}
