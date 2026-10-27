//! Upgrade-authority gate for `fizz_init`.
//!
//! `fizz_init` may only be signed by the pubkey stored in this program's
//! upgradeable-loader `ProgramData` account. The account address is the
//! canonical PDA `["program id"]` under the BPF upgradeable loader, and the
//! trailing ELF bytes are ignored.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

use crate::ErrorCode;

#[allow(deprecated)]
pub fn program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

/// `ProgramData` header written by the upgradeable loader (bincode):
/// `u32` discriminant 3, `u64` slot, `u8` option tag, optional 32-byte pubkey.
pub fn read_upgrade_authority(data: &[u8]) -> Result<Option<Pubkey>> {
    const PROGRAM_DATA: u32 = 3;
    if data.len() < 13 {
        return err!(ErrorCode::InvalidProgramData);
    }
    let disc = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    if disc != PROGRAM_DATA {
        return err!(ErrorCode::InvalidProgramData);
    }
    match data[12] {
        0 => Ok(None),
        1 => {
            if data.len() < 45 {
                return err!(ErrorCode::InvalidProgramData);
            }
            let bytes: [u8; 32] = data[13..45]
                .try_into()
                .map_err(|_| error!(ErrorCode::InvalidProgramData))?;
            Ok(Some(Pubkey::new_from_array(bytes)))
        }
        _ => err!(ErrorCode::InvalidProgramData),
    }
}

#[allow(deprecated)]
pub fn assert_upgrade_authority(
    program_id: &Pubkey,
    program_data: &AccountInfo,
    authority: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *program_data.key,
        program_data_address(program_id),
        ErrorCode::InvalidProgramData
    );
    require_keys_eq!(
        *program_data.owner,
        bpf_loader_upgradeable::ID,
        ErrorCode::InvalidProgramData
    );
    let data = program_data.try_borrow_data()?;
    let stored = read_upgrade_authority(&data)?;
    require!(stored == Some(*authority), ErrorCode::Unauthorized);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::{
        account_info::AccountInfo, bpf_loader_upgradeable::UpgradeableLoaderState,
    };

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

    fn program_data_bytes(authority: Option<Pubkey>, trailing: usize) -> Vec<u8> {
        let state = UpgradeableLoaderState::ProgramData {
            slot: 42,
            upgrade_authority_address: authority,
        };
        let mut bytes = bincode::serialize(&state).unwrap();
        bytes.extend(std::iter::repeat(0xab).take(trailing));
        bytes
    }

    fn call(
        program_id: &Pubkey,
        key: &Pubkey,
        owner: &Pubkey,
        data: &mut [u8],
        authority: &Pubkey,
    ) -> Result<()> {
        let mut lamports = 0u64;
        let info = AccountInfo::new(key, false, false, &mut lamports, data, owner, false, 0);
        assert_upgrade_authority(program_id, &info, authority)
    }

    #[test]
    fn upgrade_authority_must_sign_and_layout_matches_the_loader() {
        let program_id = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let pda = program_data_address(&program_id);
        #[allow(deprecated)]
        let loader = bpf_loader_upgradeable::ID;
        let mut data = program_data_bytes(Some(authority), 128);
        assert!(data.len() > 45);
        call(&program_id, &pda, &loader, &mut data, &authority).unwrap();
        assert_eq!(
            read_upgrade_authority(&data).unwrap(),
            Some(authority)
        );

        let other = Pubkey::new_unique();
        expect_code(
            call(&program_id, &pda, &loader, &mut data, &other),
            ErrorCode::Unauthorized,
        );

        let wrong_owner = Pubkey::new_unique();
        expect_code(
            call(&program_id, &pda, &wrong_owner, &mut data, &authority),
            ErrorCode::InvalidProgramData,
        );

        let wrong_key = Pubkey::new_unique();
        expect_code(
            call(&program_id, &wrong_key, &loader, &mut data, &authority),
            ErrorCode::InvalidProgramData,
        );

        let mut immutable = program_data_bytes(None, 0);
        expect_code(
            call(&program_id, &pda, &loader, &mut immutable, &authority),
            ErrorCode::Unauthorized,
        );

        let buffer = bincode::serialize(&UpgradeableLoaderState::Buffer {
            authority_address: Some(authority),
        })
        .unwrap();
        expect_code(
            read_upgrade_authority(&buffer).map(|_| ()),
            ErrorCode::InvalidProgramData,
        );
        expect_code(
            read_upgrade_authority(&[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).map(|_| ()),
            ErrorCode::InvalidProgramData,
        );
    }
}
