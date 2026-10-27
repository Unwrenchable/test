//! Binary loot voucher v1 and Ed25519 instruction-sysvar checks.
//!
//! The Ed25519 precompile verifies the signature. This module checks that the
//! precompile was aimed at the configured server key and at the message this
//! program rebuilds. Offsets are read from the 14-byte `Ed25519SignatureOffsets`
//! record. They are not hard-coded, and every instruction index must be
//! `u16::MAX` so the pubkey, signature, and message live in that instruction.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use solana_program::{ed25519_program, hash::hash};

use crate::ErrorCode;

pub const VOUCHER_DOMAIN: &[u8; 24] = b"FIZZCAPS:LOOT_VOUCHER:v1";
pub const VOUCHER_MSG_LEN: usize = 169;
pub const MAX_HINT_LEN: usize = 64;
/// On-chain maximum lifetime of a voucher. The backend must not exceed this.
pub const MAX_VOUCHER_TTL_SECS: i64 = 300;
pub const MAX_CLOCK_SKEW_SECS: i64 = 30;
pub const METAPLEX_NAME_MAX: usize = 32;

pub const VOUCHER_CLAIM_SEED: &[u8] = b"voucher-claim";
pub const LOOT_CLAIM_SEED: &[u8] = b"loot-claim";

pub const CLUSTER_TAG: u8 = if cfg!(feature = "mainnet") {
    1
} else if cfg!(feature = "devnet") {
    2
} else {
    3
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LootVoucherV1 {
    pub voucher_id: [u8; 16],
    pub loot_id: u64,
    pub lat_e6: i32,
    pub lng_e6: i32,
    pub location_hint: String,
    pub issued_at: i64,
    pub expires_at: i64,
}

impl LootVoucherV1 {
    pub fn check_shape_and_time(&self, now: i64) -> Result<()> {
        require!(
            self.location_hint.len() <= MAX_HINT_LEN,
            ErrorCode::VoucherBadShape
        );
        require!(
            (-90_000_000..=90_000_000).contains(&self.lat_e6),
            ErrorCode::VoucherBadShape
        );
        require!(
            (-180_000_000..=180_000_000).contains(&self.lng_e6),
            ErrorCode::VoucherBadShape
        );
        let ttl = self
            .expires_at
            .checked_sub(self.issued_at)
            .ok_or_else(|| error!(ErrorCode::VoucherBadShape))?;
        require!(ttl > 0, ErrorCode::VoucherBadShape);
        require!(ttl <= MAX_VOUCHER_TTL_SECS, ErrorCode::VoucherTtlTooLong);
        require!(
            self.issued_at <= now.saturating_add(MAX_CLOCK_SKEW_SECS),
            ErrorCode::VoucherNotYetValid
        );
        require!(now <= self.expires_at, ErrorCode::VoucherExpired);
        Ok(())
    }

    /// Domain-separated message. `program_id` and `player` are supplied by the
    /// program, never trusted from the client as raw bytes.
    pub fn message(&self, program_id: &Pubkey, player: &Pubkey) -> [u8; VOUCHER_MSG_LEN] {
        let mut m = [0u8; VOUCHER_MSG_LEN];
        let mut o = 0usize;
        let mut put = |b: &[u8]| {
            m[o..o + b.len()].copy_from_slice(b);
            o += b.len();
        };
        put(VOUCHER_DOMAIN);
        put(&[CLUSTER_TAG]);
        put(program_id.as_ref());
        put(player.as_ref());
        put(&self.voucher_id);
        put(&self.loot_id.to_le_bytes());
        put(&self.lat_e6.to_le_bytes());
        put(&self.lng_e6.to_le_bytes());
        put(hash(self.location_hint.as_bytes()).as_ref());
        put(&self.issued_at.to_le_bytes());
        put(&self.expires_at.to_le_bytes());
        debug_assert_eq!(o, VOUCHER_MSG_LEN);
        m
    }
}

pub fn loot_display_name(loot_id: u64) -> String {
    format!("Fizz Cache #{loot_id}")
}

pub fn ensure_claims_open(paused: bool) -> Result<()> {
    require!(!paused, ErrorCode::Paused);
    Ok(())
}

/// Returns `(pubkey, signature, message)` slices inside `d`.
pub fn parse_ed25519_ix_data(d: &[u8]) -> Result<(&[u8], &[u8], &[u8])> {
    if d.len() < 16 || d[0] != 1 {
        return err!(ErrorCode::InvalidEd25519Data);
    }
    let rd = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]);
    // Header layout after (num_signatures, padding):
    //   2 signature_offset, 4 signature_instruction_index,
    //   6 public_key_offset, 8 public_key_instruction_index,
    //  10 message_data_offset, 12 message_data_size,
    //  14 message_instruction_index.
    let sig_off = rd(2) as usize;
    let sig_ix = rd(4);
    let pk_off = rd(6) as usize;
    let pk_ix = rd(8);
    let msg_off = rd(10) as usize;
    let msg_len = rd(12) as usize;
    let msg_ix = rd(14);
    if sig_ix != u16::MAX || pk_ix != u16::MAX || msg_ix != u16::MAX {
        return err!(ErrorCode::InvalidEd25519Data);
    }
    let slice = |off: usize, len: usize| -> Result<&[u8]> {
        let end = off
            .checked_add(len)
            .ok_or_else(|| error!(ErrorCode::InvalidEd25519Offsets))?;
        d.get(off..end)
            .ok_or_else(|| error!(ErrorCode::InvalidEd25519Offsets))
    };
    Ok((slice(pk_off, 32)?, slice(sig_off, 64)?, slice(msg_off, msg_len)?))
}

#[allow(deprecated)]
pub fn verify_voucher_ed25519(
    ix_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
    expected_msg: &[u8],
) -> Result<()> {
    let cur = load_current_index_checked(ix_sysvar)? as usize;
    let cur_ix = load_instruction_at_checked(cur, ix_sysvar)?;
    require_keys_eq!(cur_ix.program_id, crate::ID, ErrorCode::CpiNotAllowed);
    require!(cur > 0, ErrorCode::NoEd25519Ix);
    let ed = load_instruction_at_checked(cur - 1, ix_sysvar)?;
    require_keys_eq!(
        ed.program_id,
        ed25519_program::ID,
        ErrorCode::InvalidEd25519Program
    );
    require!(ed.accounts.is_empty(), ErrorCode::InvalidEd25519Data);
    let (pk, _sig, msg) = parse_ed25519_ix_data(&ed.data)?;
    require!(pk == expected_signer.as_ref(), ErrorCode::WrongPubkey);
    require!(msg == expected_msg, ErrorCode::WrongMessage);
    Ok(())
}

#[account]
pub struct VoucherClaim {
    pub voucher_id: [u8; 16],
    pub player: Pubkey,
    pub loot_id: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

impl VoucherClaim {
    pub const SIZE: usize = 8 + 16 + 32 + 8 + 8 + 1;
}

#[account]
pub struct LootClaim {
    pub loot_id: u64,
    pub player: Pubkey,
    pub voucher_id: [u8; 16],
    pub claimed_at: i64,
    pub bump: u8,
}

impl LootClaim {
    pub const SIZE: usize = 8 + 8 + 32 + 16 + 8 + 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::{
        account_info::AccountInfo,
        sysvar::instructions::{
            construct_instructions_data, BorrowedAccountMeta, BorrowedInstruction,
        },
    };
    use std::str::FromStr;

    fn anchor_code(err: anchor_lang::error::Error) -> u32 {
        match err {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("not an anchor error: {other:?}"),
        }
    }

    fn expect_code(result: Result<()>, code: ErrorCode) {
        let err = result.expect_err("expected error");
        assert_eq!(anchor_code(err), 6000 + code as u32, "{code:?}");
    }

    fn sample_voucher() -> LootVoucherV1 {
        LootVoucherV1 {
            voucher_id: [1u8; 16],
            loot_id: 7,
            lat_e6: 36_012_345,
            lng_e6: -115_139_000,
            location_hint: "vault-77".to_string(),
            issued_at: 1_700_000_000,
            expires_at: 1_700_000_300,
        }
    }

    #[test]
    fn constants_match_the_variant_rules() {
        assert_eq!(VOUCHER_DOMAIN.len(), 24);
        assert_eq!(VOUCHER_MSG_LEN, 169);
        assert_eq!(MAX_VOUCHER_TTL_SECS, 300);
        assert_eq!(MAX_CLOCK_SKEW_SECS, 30);
        assert_eq!(VoucherClaim::SIZE, 73);
        assert_eq!(LootClaim::SIZE, 73);
        assert!(loot_display_name(0).len() <= METAPLEX_NAME_MAX);
        assert!(loot_display_name(u64::MAX).len() <= METAPLEX_NAME_MAX);
        assert_eq!(loot_display_name(42), "Fizz Cache #42");
        assert_ne!(VOUCHER_CLAIM_SEED, LOOT_CLAIM_SEED);
    }

    #[test]
    fn message_is_169_bytes_and_binds_player_program_and_cluster() {
        let v = sample_voucher();
        let program = Pubkey::new_unique();
        let player_a = Pubkey::new_unique();
        let player_b = Pubkey::new_unique();
        let msg_a = v.message(&program, &player_a);
        let msg_b = v.message(&program, &player_b);
        assert_eq!(msg_a.len(), 169);
        assert_eq!(&msg_a[0..24], VOUCHER_DOMAIN);
        assert_eq!(msg_a[24], CLUSTER_TAG);
        assert_eq!(&msg_a[25..57], program.as_ref());
        assert_eq!(&msg_a[57..89], player_a.as_ref());
        assert_eq!(&msg_a[89..105], &v.voucher_id);
        assert_ne!(msg_a, msg_b);
        assert_eq!(&msg_b[57..89], player_b.as_ref());
        let hint_hash = hash(v.location_hint.as_bytes());
        assert_eq!(&msg_a[121..153], hint_hash.as_ref());
    }

    #[test]
    fn hint_length_bounds() {
        let now = 1_700_000_100;
        let mut v = sample_voucher();
        v.location_hint = "a".repeat(64);
        v.check_shape_and_time(now).unwrap();
        assert_eq!(v.message(&Pubkey::new_unique(), &Pubkey::new_unique()).len(), 169);
        v.location_hint = "a".repeat(65);
        expect_code(v.check_shape_and_time(now), ErrorCode::VoucherBadShape);
    }

    #[test]
    fn time_rules_use_a_300_second_ttl() {
        let base = sample_voucher();
        let cases: &[(i64, i64, i64, Option<ErrorCode>)] = &[
            (1_700_000_000, 1_700_000_300, 1_700_000_100, None),
            (1_700_000_000, 1_700_000_300, 1_700_000_300, None),
            (1_700_000_000, 1_700_000_300, 1_700_000_000, None),
            (1_700_000_100, 1_700_000_400, 1_700_000_130, None), // skew +30
            (1_700_000_131, 1_700_000_200, 1_700_000_100, Some(ErrorCode::VoucherNotYetValid)),
            (1_700_000_000, 1_700_000_200, 1_700_000_201, Some(ErrorCode::VoucherExpired)),
            (1_700_000_000, 1_700_000_000, 1_700_000_000, Some(ErrorCode::VoucherBadShape)),
            (1_700_000_100, 1_700_000_000, 1_700_000_000, Some(ErrorCode::VoucherBadShape)),
            (1_700_000_000, 1_700_000_301, 1_700_000_100, Some(ErrorCode::VoucherTtlTooLong)),
            (1_700_000_000, 1_700_000_300, 1_699_999_000, Some(ErrorCode::VoucherNotYetValid)),
        ];
        for (issued, expires, now, expect) in cases {
            let mut v = base.clone();
            v.issued_at = *issued;
            v.expires_at = *expires;
            let result = v.check_shape_and_time(*now);
            match expect {
                None => result.unwrap(),
                Some(code) => expect_code(result, *code),
            }
        }
    }

    #[test]
    fn coordinate_bounds_and_ttl_overflow() {
        let now = 1_700_000_100;
        let mut v = sample_voucher();
        v.lat_e6 = 90_000_000;
        v.lng_e6 = -180_000_000;
        v.check_shape_and_time(now).unwrap();
        v.lat_e6 = 90_000_001;
        expect_code(v.check_shape_and_time(now), ErrorCode::VoucherBadShape);
        v.lat_e6 = 0;
        v.lng_e6 = 180_000_001;
        expect_code(v.check_shape_and_time(now), ErrorCode::VoucherBadShape);
        v.lng_e6 = 0;
        v.issued_at = i64::MIN;
        v.expires_at = i64::MAX;
        expect_code(v.check_shape_and_time(now), ErrorCode::VoucherBadShape);
    }

    #[test]
    fn pause_flag_rejects_claims() {
        ensure_claims_open(false).unwrap();
        expect_code(ensure_claims_open(true), ErrorCode::Paused);
    }

    fn decode_hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn encode_hex(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0xf) as usize] as char);
        }
        out
    }

    #[test]
    fn golden_message_matches_the_js_fixture() {
        let raw = include_str!("../fixtures/voucher_v1_golden.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).unwrap();
        let program = Pubkey::from_str(fixture["program_id"].as_str().unwrap()).unwrap();
        let player = Pubkey::from_str(fixture["player"].as_str().unwrap()).unwrap();
        let mut voucher_id = [0u8; 16];
        voucher_id.copy_from_slice(&decode_hex(fixture["voucher_id_hex"].as_str().unwrap()));
        let voucher = LootVoucherV1 {
            voucher_id,
            loot_id: fixture["loot_id"].as_u64().unwrap(),
            lat_e6: fixture["lat_e6"].as_i64().unwrap() as i32,
            lng_e6: fixture["lng_e6"].as_i64().unwrap() as i32,
            location_hint: fixture["location_hint"].as_str().unwrap().to_string(),
            issued_at: fixture["issued_at"].as_i64().unwrap(),
            expires_at: fixture["expires_at"].as_i64().unwrap(),
        };
        let msg = voucher.message(&program, &player);
        let got = encode_hex(&msg);
        if cfg!(feature = "localnet") {
            assert_eq!(crate::ID.to_string(), fixture["program_id"].as_str().unwrap());
            assert_eq!(CLUSTER_TAG, 3);
            assert_eq!(got, fixture["message_hex"].as_str().unwrap());
        } else {
            assert_ne!(crate::ID.to_string(), fixture["program_id"].as_str().unwrap());
            assert_ne!(got, fixture["message_hex"].as_str().unwrap());
            assert_eq!(msg[24], CLUSTER_TAG);
        }
    }

    #[test]
    fn parser_accepts_web3_js_fixture_and_rejects_legacy_offsets() {
        let raw = include_str!("../fixtures/ed25519_ix_fixture.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).unwrap();
        let data = decode_hex(fixture["instruction_data_hex"].as_str().unwrap());
        let pk = decode_hex(fixture["public_key_hex"].as_str().unwrap());
        let sig = decode_hex(fixture["signature_hex"].as_str().unwrap());
        let message = decode_hex(fixture["message_hex"].as_str().unwrap());
        let (got_pk, got_sig, got_msg) = parse_ed25519_ix_data(&data).unwrap();
        assert_eq!(got_pk, pk.as_slice());
        assert_eq!(got_sig, sig.as_slice());
        assert_eq!(got_msg, message.as_slice());
        // web3.js places the signature offset at bytes 2..4 (value 48) and the
        // pubkey at offset 16. The previous parser treated bytes 2..4 as the
        // pubkey offset, so it would have read the signature instead.
        let legacy_pk_off = u16::from_le_bytes([data[2], data[3]]) as usize;
        assert_eq!(legacy_pk_off, 48);
        assert_ne!(&data[legacy_pk_off..legacy_pk_off + 32], got_pk);
        assert_eq!(got_pk, &data[16..48]);
        assert_eq!(got_sig, &data[48..112]);
        assert_eq!(got_msg, &data[112..]);
    }

    #[test]
    fn parser_rejects_bad_layouts() {
        let mut ok = vec![0u8; 16 + 32 + 64 + 4];
        ok[0] = 1;
        ok[2..4].copy_from_slice(&48u16.to_le_bytes());
        ok[4..6].copy_from_slice(&u16::MAX.to_le_bytes());
        ok[6..8].copy_from_slice(&16u16.to_le_bytes());
        ok[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
        ok[10..12].copy_from_slice(&112u16.to_le_bytes());
        ok[12..14].copy_from_slice(&4u16.to_le_bytes());
        ok[14..16].copy_from_slice(&u16::MAX.to_le_bytes());
        parse_ed25519_ix_data(&ok).unwrap();

        let mut zero_sigs = ok.clone();
        zero_sigs[0] = 0;
        expect_code(
            parse_ed25519_ix_data(&zero_sigs).map(|_| ()),
            ErrorCode::InvalidEd25519Data,
        );
        let mut two_sigs = ok.clone();
        two_sigs[0] = 2;
        expect_code(
            parse_ed25519_ix_data(&two_sigs).map(|_| ()),
            ErrorCode::InvalidEd25519Data,
        );
        expect_code(
            parse_ed25519_ix_data(&ok[..15]).map(|_| ()),
            ErrorCode::InvalidEd25519Data,
        );

        for at in [4usize, 8, 14] {
            let mut bad_ix = ok.clone();
            bad_ix[at..at + 2].copy_from_slice(&1u16.to_le_bytes());
            expect_code(
                parse_ed25519_ix_data(&bad_ix).map(|_| ()),
                ErrorCode::InvalidEd25519Data,
            );
        }

        let mut past_end = ok.clone();
        past_end[6..8].copy_from_slice(&1000u16.to_le_bytes());
        expect_code(
            parse_ed25519_ix_data(&past_end).map(|_| ()),
            ErrorCode::InvalidEd25519Offsets,
        );

        let mut overflow = ok.clone();
        overflow[10..12].copy_from_slice(&u16::MAX.to_le_bytes());
        overflow[12..14].copy_from_slice(&2u16.to_le_bytes());
        expect_code(
            parse_ed25519_ix_data(&overflow).map(|_| ()),
            ErrorCode::InvalidEd25519Offsets,
        );
    }

    fn ed25519_ix_data(pubkey: &[u8; 32], signature: &[u8; 64], message: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8; 112 + message.len()];
        d[0] = 1;
        d[2..4].copy_from_slice(&48u16.to_le_bytes());
        d[4..6].copy_from_slice(&u16::MAX.to_le_bytes());
        d[6..8].copy_from_slice(&16u16.to_le_bytes());
        d[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
        d[10..12].copy_from_slice(&112u16.to_le_bytes());
        d[12..14].copy_from_slice(&(message.len() as u16).to_le_bytes());
        d[14..16].copy_from_slice(&u16::MAX.to_le_bytes());
        d[16..48].copy_from_slice(pubkey);
        d[48..112].copy_from_slice(signature);
        d[112..].copy_from_slice(message);
        d
    }

    fn with_sysvar<T>(mut data: Vec<u8>, f: impl FnOnce(AccountInfo) -> T) -> T {
        let key = anchor_lang::solana_program::sysvar::instructions::ID;
        let owner = anchor_lang::solana_program::sysvar::ID;
        let mut lamports = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false, 0);
        f(info)
    }

    fn sysvar_data(instructions: &[BorrowedInstruction], current: u16) -> Vec<u8> {
        let mut data = construct_instructions_data(instructions);
        let n = data.len();
        data[n - 2..].copy_from_slice(&current.to_le_bytes());
        data
    }

    #[test]
    fn verify_checks_preceding_ed25519_ix_against_config_key_and_message() {
        let server = Pubkey::new_unique();
        let player = Pubkey::new_unique();
        let voucher = sample_voucher();
        let message = voucher.message(&crate::ID, &player);
        let mut server_bytes = [0u8; 32];
        server_bytes.copy_from_slice(server.as_ref());
        let signature = [7u8; 64];
        let ed_data = ed25519_ix_data(&server_bytes, &signature, &message);
        let ed_program = ed25519_program::ID;
        let our_program = crate::ID;
        let ix = [
            BorrowedInstruction {
                program_id: &ed_program,
                accounts: vec![],
                data: &ed_data,
            },
            BorrowedInstruction {
                program_id: &our_program,
                accounts: vec![],
                data: &[],
            },
        ];
        let data = sysvar_data(&ix, 1);
        with_sysvar(data, |info| {
            verify_voucher_ed25519(&info, &server, &message).unwrap();
        });

        let other = Pubkey::new_unique();
        let data = sysvar_data(&ix, 1);
        with_sysvar(data, |info| {
            expect_code(
                verify_voucher_ed25519(&info, &other, &message),
                ErrorCode::WrongPubkey,
            );
        });

        let mut tampered = message;
        tampered[105] ^= 0xff;
        let data = sysvar_data(&ix, 1);
        with_sysvar(data, |info| {
            expect_code(
                verify_voucher_ed25519(&info, &server, &tampered),
                ErrorCode::WrongMessage,
            );
        });
    }

    #[test]
    fn verify_rejects_missing_misplaced_and_cpi_invocations() {
        let server = Pubkey::new_unique();
        let message = [9u8; 4];
        let mut server_bytes = [0u8; 32];
        server_bytes.copy_from_slice(server.as_ref());
        let ed_data = ed25519_ix_data(&server_bytes, &[1u8; 64], &message);
        let ed_program = ed25519_program::ID;
        let our_program = crate::ID;
        let other_program = Pubkey::new_unique();
        let system_program = anchor_lang::solana_program::system_program::ID;

        let only_ours = [BorrowedInstruction {
            program_id: &our_program,
            accounts: vec![],
            data: &[],
        }];
        with_sysvar(sysvar_data(&only_ours, 0), |info| {
            expect_code(
                verify_voucher_ed25519(&info, &server, &message),
                ErrorCode::NoEd25519Ix,
            );
        });

        let gap = [
            BorrowedInstruction {
                program_id: &ed_program,
                accounts: vec![],
                data: &ed_data,
            },
            BorrowedInstruction {
                program_id: &system_program,
                accounts: vec![],
                data: &[],
            },
            BorrowedInstruction {
                program_id: &our_program,
                accounts: vec![],
                data: &[],
            },
        ];
        with_sysvar(sysvar_data(&gap, 2), |info| {
            expect_code(
                verify_voucher_ed25519(&info, &server, &message),
                ErrorCode::InvalidEd25519Program,
            );
        });

        let cpi = [
            BorrowedInstruction {
                program_id: &ed_program,
                accounts: vec![],
                data: &ed_data,
            },
            BorrowedInstruction {
                program_id: &other_program,
                accounts: vec![],
                data: &[],
            },
        ];
        with_sysvar(sysvar_data(&cpi, 1), |info| {
            expect_code(
                verify_voucher_ed25519(&info, &server, &message),
                ErrorCode::CpiNotAllowed,
            );
        });

        let meta_key = Pubkey::new_unique();
        let with_account = [
            BorrowedInstruction {
                program_id: &ed_program,
                accounts: vec![BorrowedAccountMeta {
                    pubkey: &meta_key,
                    is_signer: false,
                    is_writable: false,
                }],
                data: &ed_data,
            },
            BorrowedInstruction {
                program_id: &our_program,
                accounts: vec![],
                data: &[],
            },
        ];
        with_sysvar(sysvar_data(&with_account, 1), |info| {
            expect_code(
                verify_voucher_ed25519(&info, &server, &message),
                ErrorCode::InvalidEd25519Data,
            );
        });

        let mut indexed = ed_data.clone();
        indexed[14..16].copy_from_slice(&1u16.to_le_bytes());
        let bad_index = [
            BorrowedInstruction {
                program_id: &ed_program,
                accounts: vec![],
                data: &indexed,
            },
            BorrowedInstruction {
                program_id: &our_program,
                accounts: vec![],
                data: &[],
            },
        ];
        with_sysvar(sysvar_data(&bad_index, 1), |info| {
            expect_code(
                verify_voucher_ed25519(&info, &server, &message),
                ErrorCode::InvalidEd25519Data,
            );
        });

        let mut two = ed_data.clone();
        two[0] = 2;
        let two_sigs = [
            BorrowedInstruction {
                program_id: &ed_program,
                accounts: vec![],
                data: &two,
            },
            BorrowedInstruction {
                program_id: &our_program,
                accounts: vec![],
                data: &[],
            },
        ];
        with_sysvar(sysvar_data(&two_sigs, 1), |info| {
            expect_code(
                verify_voucher_ed25519(&info, &server, &message),
                ErrorCode::InvalidEd25519Data,
            );
        });
    }

    #[test]
    fn verify_rejects_a_fake_instructions_sysvar() {
        let key = Pubkey::new_unique();
        let owner = anchor_lang::solana_program::sysvar::ID;
        let mut lamports = 0u64;
        let mut data = vec![0u8; 8];
        let info = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );
        let err = verify_voucher_ed25519(&info, &Pubkey::new_unique(), &[0u8; 4]).unwrap_err();
        let text = format!("{err:?}");
        assert!(
            text.contains("UnsupportedSysvar") || text.contains("ProgramError"),
            "{text}"
        );
    }

}
