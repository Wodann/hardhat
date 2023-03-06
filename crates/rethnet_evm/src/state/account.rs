use rethnet_eth::{account::KECCAK_EMPTY, state::Storage};
use revm::primitives::{AccountInfo, Bytecode};

#[derive(Clone, Debug, Default)]
pub struct RethnetAccount {
    pub info: AccountInfo,
    pub storage: Storage,
}

impl RethnetAccount {
    /// Splits the code from the `AccountInfo`, if it exists.
    pub fn split_code(&mut self) -> Option<Bytecode> {
        if self.info.code_hash != KECCAK_EMPTY {
            if let Some(code) = self.info.code.take() {
                if !code.is_empty() {
                    self.info.code_hash = code.hash();
                    return Some(code);
                }
            }
        }

        None
    }
}

impl From<AccountInfo> for RethnetAccount {
    fn from(info: AccountInfo) -> Self {
        Self {
            info,
            storage: Storage::default(),
        }
    }
}
