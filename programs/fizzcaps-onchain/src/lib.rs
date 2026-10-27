use anchor_lang::prelude::*;
use anchor_lang::solana_program::{bpf_loader_upgradeable, sysvar};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{burn, Burn, Mint, MintTo, Token, TokenAccount},
};
use mpl_token_metadata::{
    instructions::CreateV1CpiBuilder, types::TokenStandard, ID as METADATA_PROGRAM_ID,
};

mod admin;
mod voucher;

use admin::assert_upgrade_authority;
use voucher::*;

#[cfg(not(any(feature = "localnet", feature = "devnet", feature = "mainnet")))]
compile_error!("exactly one of the `localnet`, `devnet`, or `mainnet` features must be enabled");

#[cfg(any(
    all(feature = "localnet", feature = "devnet"),
    all(feature = "localnet", feature = "mainnet"),
    all(feature = "devnet", feature = "mainnet"),
))]
compile_error!("exactly one of the `localnet`, `devnet`, or `mainnet` features must be enabled");

// Keep these in lockstep with Anchor.toml. `scripts/check-declare-id.js` fails
// the build when a feature's declare_id! disagrees with that file.
// Do not run `anchor keys sync` before a cluster build; it rewrites this id.
#[cfg(feature = "localnet")]
declare_id!("GDGexnGtZPoD1aHv6qg8hjeSspujwWnxJCtdrrj2gKpP");
#[cfg(feature = "devnet")]
declare_id!("GDGexnGtZPoD1aHv6qg8hjeSspujwWnxJCtdrrj2gKpP");
#[cfg(feature = "mainnet")]
declare_id!("GDGexnGtZPoD1aHv6qg8hjeSspujwWnxJCtdrrj2gKpP");

const CAPS_MINT_SEEDS: &[u8] = b"caps-mint";
const LOOT_MINT_AUTHORITY_SEEDS: &[u8] = b"loot-mint-auth";
const FIZZ_CONFIG_SEEDS: &[u8] = b"fizz-config";

const LOOT_CLAIM_FEE: u64 = 100 * 1_000_000_000;

#[program]
pub mod fizzcaps_onchain {
    use super::*;

    /// Creates the config PDA. The signer must be the program's current
    /// upgrade authority, proven from the loader's ProgramData account.
    pub fn fizz_init(ctx: Context<FizzInit>, server_key: Pubkey) -> Result<()> {
        assert_upgrade_authority(
            &crate::ID,
            &ctx.accounts.program_data.to_account_info(),
            &ctx.accounts.authority.key(),
        )?;
        require!(server_key != Pubkey::default(), ErrorCode::InvalidServerKey);

        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.server_key = server_key;
        cfg.caps_mint = ctx.accounts.caps_mint.key();
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn fizz_set_server_key(ctx: Context<FizzAdmin>, new_key: Pubkey) -> Result<()> {
        require!(new_key != Pubkey::default(), ErrorCode::InvalidServerKey);
        let old = ctx.accounts.config.server_key;
        ctx.accounts.config.server_key = new_key;
        emit!(ServerKeyRotated { old, new: new_key });
        Ok(())
    }

    pub fn fizz_set_paused(ctx: Context<FizzAdmin>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedSet {
            paused,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    pub fn claim_loot(ctx: Context<ClaimLoot>, voucher: LootVoucherV1) -> Result<()> {
        ensure_claims_open(ctx.accounts.config.paused)?;

        let now = Clock::get()?.unix_timestamp;
        voucher.check_shape_and_time(now)?;

        let msg = voucher.message(&crate::ID, &ctx.accounts.player.key());
        verify_voucher_ed25519(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &ctx.accounts.config.server_key,
            &msg,
        )?;

        let player = ctx.accounts.player.key();
        let vc = &mut ctx.accounts.voucher_claim;
        vc.voucher_id = voucher.voucher_id;
        vc.player = player;
        vc.loot_id = voucher.loot_id;
        vc.claimed_at = now;
        vc.bump = ctx.bumps.voucher_claim;

        let lc = &mut ctx.accounts.loot_claim;
        lc.loot_id = voucher.loot_id;
        lc.player = player;
        lc.voucher_id = voucher.voucher_id;
        lc.claimed_at = now;
        lc.bump = ctx.bumps.loot_claim;

        burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.caps_mint.to_account_info(),
                    from: ctx.accounts.player_caps_ata.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            LOOT_CLAIM_FEE,
        )?;

        anchor_spl::token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.loot_mint.to_account_info(),
                    to: ctx.accounts.player_loot_ata.to_account_info(),
                    authority: ctx.accounts.loot_mint_authority.to_account_info(),
                },
                &[&[
                    LOOT_MINT_AUTHORITY_SEEDS,
                    &[ctx.bumps.loot_mint_authority],
                ]],
            ),
            1,
        )?;

        let name = loot_display_name(voucher.loot_id);
        let uri = format!(
            "https://atomicfizzcaps.xyz/loot/{}.json",
            voucher.loot_id
        );
        let metadata_program = ctx.accounts.metadata_program.to_account_info();
        let loot_metadata = ctx.accounts.loot_metadata.to_account_info();
        let loot_mint = ctx.accounts.loot_mint.to_account_info();
        let loot_mint_authority = ctx.accounts.loot_mint_authority.to_account_info();
        let payer = ctx.accounts.player.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let instructions_sysvar = ctx.accounts.instructions_sysvar.to_account_info();
        let token_program = ctx.accounts.token_program.to_account_info();
        let master_edition = ctx.accounts.loot_master_edition.to_account_info();

        CreateV1CpiBuilder::new(&metadata_program)
            .metadata(&loot_metadata)
            .master_edition(Some(&master_edition))
            .mint(&loot_mint, true)
            .authority(&loot_mint_authority)
            .payer(&payer)
            .update_authority(&loot_mint_authority, true)
            .system_program(&system_program)
            .sysvar_instructions(&instructions_sysvar)
            .spl_token_program(Some(&token_program))
            .token_standard(TokenStandard::NonFungible)
            .name(name)
            .symbol("FIZZLOOT".to_string())
            .uri(uri)
            .seller_fee_basis_points(0)
            .is_mutable(false)
            .primary_sale_happened(true)
            .invoke_signed(&[&[
                LOOT_MINT_AUTHORITY_SEEDS,
                &[ctx.bumps.loot_mint_authority],
            ]])?;

        msg!(
            "Loot claimed by {} loot_id {} lat_e6 {} lng_e6 {}",
            player,
            voucher.loot_id,
            voucher.lat_e6,
            voucher.lng_e6
        );
        Ok(())
    }
}

#[account]
pub struct FizzConfig {
    pub authority: Pubkey,
    pub server_key: Pubkey,
    pub caps_mint: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl FizzConfig {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 1 + 1;
}

#[derive(Accounts)]
pub struct FizzInit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: this program. Executable flag and address are pinned.
    #[account(executable, address = crate::ID)]
    pub program: UncheckedAccount<'info>,

    /// CHECK: canonical ProgramData PDA. Upgrade authority is checked in the handler.
    #[account(
        seeds = [crate::ID.as_ref()],
        seeds::program = bpf_loader_upgradeable::ID,
        bump,
        owner = bpf_loader_upgradeable::ID @ ErrorCode::InvalidProgramData,
    )]
    pub program_data: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = FizzConfig::SIZE,
        seeds = [FIZZ_CONFIG_SEEDS],
        bump,
    )]
    pub config: Account<'info, FizzConfig>,

    #[account(seeds = [CAPS_MINT_SEEDS], bump)]
    pub caps_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FizzAdmin<'info> {
    #[account(
        mut,
        seeds = [FIZZ_CONFIG_SEEDS],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, FizzConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(voucher: LootVoucherV1)]
pub struct ClaimLoot<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [FIZZ_CONFIG_SEEDS],
        bump = config.bump,
        constraint = !config.paused @ ErrorCode::Paused,
    )]
    pub config: Account<'info, FizzConfig>,

    #[account(
        mut,
        seeds = [CAPS_MINT_SEEDS],
        bump,
        address = config.caps_mint @ ErrorCode::InvalidCapsMint,
    )]
    pub caps_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = caps_mint,
        associated_token::authority = player,
    )]
    pub player_caps_ata: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = player,
        mint::decimals = 0,
        mint::authority = loot_mint_authority,
    )]
    pub loot_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = player,
        associated_token::mint = loot_mint,
        associated_token::authority = player,
    )]
    pub player_loot_ata: Account<'info, TokenAccount>,

    /// CHECK: PDA authority for every loot mint.
    #[account(seeds = [LOOT_MINT_AUTHORITY_SEEDS], bump)]
    pub loot_mint_authority: UncheckedAccount<'info>,

    /// CHECK: Metaplex metadata PDA for `loot_mint`.
    #[account(
        mut,
        seeds = [b"metadata", METADATA_PROGRAM_ID.as_ref(), loot_mint.key().as_ref()],
        seeds::program = METADATA_PROGRAM_ID,
        bump,
    )]
    pub loot_metadata: UncheckedAccount<'info>,

    /// CHECK: Metaplex master edition PDA for `loot_mint`.
    #[account(
        mut,
        seeds = [
            b"metadata",
            METADATA_PROGRAM_ID.as_ref(),
            loot_mint.key().as_ref(),
            b"edition",
        ],
        seeds::program = METADATA_PROGRAM_ID,
        bump,
    )]
    pub loot_master_edition: UncheckedAccount<'info>,

    #[account(
        init,
        payer = player,
        space = VoucherClaim::SIZE,
        seeds = [VOUCHER_CLAIM_SEED, voucher.voucher_id.as_ref()],
        bump,
    )]
    pub voucher_claim: Account<'info, VoucherClaim>,

    #[account(
        init,
        payer = player,
        space = LootClaim::SIZE,
        seeds = [LOOT_CLAIM_SEED, &voucher.loot_id.to_le_bytes()],
        bump,
    )]
    pub loot_claim: Account<'info, LootClaim>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: Metaplex token metadata program.
    #[account(address = METADATA_PROGRAM_ID)]
    pub metadata_program: UncheckedAccount<'info>,

    /// CHECK: instructions sysvar. Pinned; read only through the sysvar API.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[event]
pub struct ServerKeyRotated {
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct PausedSet {
    pub paused: bool,
    pub authority: Pubkey,
}

#[error_code]
pub enum ErrorCode {
    #[msg("No Ed25519 instruction found")]
    NoEd25519Ix,
    #[msg("Invalid Ed25519 program ID")]
    InvalidEd25519Program,
    #[msg("Invalid Ed25519 data format")]
    InvalidEd25519Data,
    #[msg("Invalid Ed25519 offsets")]
    InvalidEd25519Offsets,
    #[msg("Wrong pubkey in Ed25519 ix")]
    WrongPubkey,
    #[msg("Wrong message in Ed25519 ix")]
    WrongMessage,
    #[msg("claim_loot cannot be invoked via CPI")]
    CpiNotAllowed,
    #[msg("Voucher not yet valid")]
    VoucherNotYetValid,
    #[msg("Voucher expired")]
    VoucherExpired,
    #[msg("Voucher TTL exceeds maximum")]
    VoucherTtlTooLong,
    #[msg("Voucher fields malformed")]
    VoucherBadShape,
    #[msg("caps_mint does not match config")]
    InvalidCapsMint,
    #[msg("Loot mint is not a fresh 0-decimal mint owned by the PDA")]
    BadLootMint,
    #[msg("Program is paused")]
    Paused,
    #[msg("Signer is not the program upgrade authority")]
    Unauthorized,
    #[msg("ProgramData account is not this program's upgrade record")]
    InvalidProgramData,
    #[msg("Server key is missing")]
    InvalidServerKey,
}
