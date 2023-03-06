use hashbrown::HashMap;
use rethnet_eth::{
    account::BasicAccount,
    state::{state_root, storage_root},
    Address, B256, U256,
};
use revm::{
    db::State,
    primitives::{Account, AccountInfo, Bytecode, KECCAK_EMPTY},
    DatabaseCommit,
};

use super::{account::RethnetAccount, StateDebug, StateError};

/// A state consisting of layers.
#[derive(Clone, Debug)]
pub struct LayeredState<Layer: Clone> {
    stack: Vec<Layer>,
    /// Snapshots
    snapshots: HashMap<B256, Vec<Layer>>, // naive implementation
}

impl<Layer: Clone> LayeredState<Layer> {
    /// Creates a [`LayeredState`] with the provided layer at the bottom.
    pub fn with_layer(layer: Layer) -> Self {
        Self {
            stack: vec![layer],
            snapshots: HashMap::new(),
        }
    }

    /// Returns the index of the top layer.
    pub fn last_layer_id(&self) -> usize {
        self.stack.len() - 1
    }

    /// Returns a mutable reference to the top layer.
    pub fn last_layer_mut(&mut self) -> &mut Layer {
        // The `LayeredState` always has at least one layer
        self.stack.last_mut().unwrap()
    }

    /// Adds the provided layer to the top, returning its index and a
    /// mutable reference to the layer.
    pub fn add_layer(&mut self, layer: Layer) -> (usize, &mut Layer) {
        let layer_id = self.stack.len();
        self.stack.push(layer);
        (layer_id, self.stack.last_mut().unwrap())
    }

    /// Reverts to the layer with specified `layer_id`, removing all
    /// layers above it.
    pub fn revert_to_layer(&mut self, layer_id: usize) {
        assert!(layer_id < self.stack.len(), "Invalid layer id.");
        self.stack.truncate(layer_id + 1);
    }

    /// Returns an iterator over the object's layers.
    pub fn iter(&self) -> impl Iterator<Item = &Layer> {
        self.stack.iter().rev()
    }
}

impl<Layer: Clone + Default> LayeredState<Layer> {
    /// Adds a default layer to the top, returning its index and a
    /// mutable reference to the layer.
    pub fn add_layer_default(&mut self) -> (usize, &mut Layer) {
        self.add_layer(Layer::default())
    }
}

impl<Layer: Clone + Default> Default for LayeredState<Layer> {
    fn default() -> Self {
        Self {
            stack: vec![Layer::default()],
            snapshots: HashMap::new(),
        }
    }
}

/// A layer with information needed for [`Rethnet`].
#[derive(Clone, Debug, Default)]
pub struct RethnetLayer {
    /// Accounts, where the Option signals deletion.
    accounts: HashMap<Address, Option<RethnetAccount>>,
    /// Code hash -> Address
    contracts: HashMap<B256, Bytecode>,
    /// Cached state root
    state_root: Option<B256>,
}

impl RethnetLayer {
    /// Creates a `RethnetLayer` with the provided genesis accounts.
    pub fn with_genesis_accounts(genesis_accounts: HashMap<Address, AccountInfo>) -> Self {
        let mut accounts: HashMap<Address, Option<RethnetAccount>> = genesis_accounts
            .into_iter()
            .map(|(address, account_info)| (address, Some(account_info.into())))
            .collect();

        let contracts = accounts
            .values_mut()
            .filter_map(|account| {
                account.as_mut().and_then(|account| {
                    let code = account.split_code();
                    code.map(|code| (code.hash(), code))
                })
            })
            .collect();

        Self {
            accounts,
            contracts,
            state_root: None,
        }
    }

    /// Returns whether the layer has a state root.
    pub fn has_state_root(&self) -> bool {
        self.state_root.is_some()
    }

    /// Insert the provided `AccountInfo` at the specified `address`.
    pub fn insert_account(&mut self, address: Address, mut account: RethnetAccount) {
        if account.info.code_hash.is_zero() {
            account.info.code_hash = KECCAK_EMPTY;
        }

        if account.info.code_hash == KECCAK_EMPTY {
            account.info.code = Some(Bytecode::new())
        } else if let Some(code) = account.split_code() {
            self.contracts.insert(code.hash(), code);
        }

        self.accounts.insert(address, Some(account));
    }
}

impl LayeredState<RethnetLayer> {
    /// Retrieves a reference to the account corresponding to the address, if it exists.
    pub fn account(&self, address: &Address) -> Option<&RethnetAccount> {
        self.iter()
            .find_map(|layer| layer.accounts.get(address).map(Option::as_ref))
            .flatten()
    }

    /// Retrieves a mutable reference to the account corresponding to the address, if it exists.
    pub fn account_mut(&mut self, address: &Address) -> Option<&mut Option<RethnetAccount>> {
        // WORKAROUND: https://blog.rust-lang.org/2022/08/05/nll-by-default.html
        if self.last_layer_mut().accounts.contains_key(address) {
            return self.last_layer_mut().accounts.get_mut(address);
        }

        self.account(address).cloned().map(|account| {
            self.last_layer_mut()
                .accounts
                .insert_unique_unchecked(*address, Some(account))
                .1
        })
    }

    /// Retrieves a mutable reference to the account corresponding to the address, if it exists.
    /// Otherwise, inserts a new account.
    pub fn account_or_insert_mut(&mut self, address: &Address) -> &mut RethnetAccount {
        // WORKAROUND: https://blog.rust-lang.org/2022/08/05/nll-by-default.html
        if self.last_layer_mut().accounts.contains_key(address) {
            let was_deleted = self
                .last_layer_mut()
                .accounts
                .get(address)
                .unwrap()
                .is_none();

            if !was_deleted {
                return self
                    .last_layer_mut()
                    .accounts
                    .get_mut(address)
                    .unwrap()
                    .as_mut()
                    .unwrap();
            }
        }

        let account = self.account(address).cloned().unwrap_or_default();

        self.last_layer_mut()
            .accounts
            .insert_unique_unchecked(*address, Some(account))
            .1
            .as_mut()
            .unwrap()
    }

    /// Removes the [`AccountInfo`] corresponding to the specified address.
    fn remove_account(&mut self, address: &Address) -> Option<AccountInfo> {
        if let Some(account) = self.account(address) {
            let account_info = account.info.clone();

            if account.info.code_hash != KECCAK_EMPTY {
                debug_assert!(account.info.code.is_none());

                let code_hash = account.info.code_hash;

                self.last_layer_mut()
                    .contracts
                    .insert(code_hash, Bytecode::new());
            }

            // Insert `None` to signal that the account was deleted
            self.last_layer_mut().accounts.insert(*address, None);

            return Some(account_info);
        }

        None
    }
}

impl State for LayeredState<RethnetLayer> {
    type Error = StateError;

    fn basic(&mut self, address: Address) -> Result<Option<AccountInfo>, Self::Error> {
        let account = self.account(&address).map(|account| account.info.clone());

        // TODO: Move this out of LayeredState when forking
        let account = Some(account.unwrap_or_default());

        Ok(account)
    }

    fn code_by_hash(&mut self, code_hash: B256) -> Result<Bytecode, Self::Error> {
        self.iter()
            .find_map(|layer| layer.contracts.get(&code_hash).cloned())
            .ok_or(StateError::InvalidCodeHash(code_hash))
    }

    fn storage(&mut self, address: Address, index: U256) -> Result<U256, Self::Error> {
        Ok(self
            .account(&address)
            .and_then(|account| account.storage.get(&index))
            .cloned()
            .unwrap_or(U256::ZERO))
    }
}

impl DatabaseCommit for LayeredState<RethnetLayer> {
    fn commit(&mut self, changes: HashMap<Address, Account>) {
        changes.into_iter().for_each(|(address, account)| {
            if account.is_empty() || account.is_destroyed {
                self.remove_account(&address);
            } else {
                let old_account = self.account_or_insert_mut(&address);
                old_account.info = account.info;

                if account.storage_cleared {
                    old_account.storage.clear();
                }

                account.storage.into_iter().for_each(|(index, value)| {
                    let value = value.present_value();
                    if value == U256::ZERO {
                        old_account.storage.remove(&index);
                    } else {
                        old_account.storage.insert(index, value);
                    }
                });
            }
        });
    }
}

impl StateDebug for LayeredState<RethnetLayer> {
    type Error = StateError;

    fn account_storage_root(&mut self, address: &Address) -> Result<Option<B256>, Self::Error> {
        Ok(self
            .account(address)
            .map(|account| storage_root(&account.storage)))
    }

    fn insert_account(
        &mut self,
        address: Address,
        account_info: AccountInfo,
    ) -> Result<(), Self::Error> {
        self.last_layer_mut()
            .insert_account(address, account_info.into());

        Ok(())
    }

    fn make_snapshot(&mut self) -> (B256, bool) {
        let state_root = self.state_root().unwrap();

        let mut exists = true;
        self.snapshots.entry(state_root).or_insert_with(|| {
            exists = false;

            let mut snapshot = self.stack.clone();
            if let Some(layer) = snapshot.last_mut() {
                layer.state_root.replace(state_root);
            }
            snapshot
        });

        (state_root, exists)
    }

    fn modify_account(
        &mut self,
        address: Address,
        modifier: Box<dyn Fn(&mut U256, &mut u64, &mut Option<Bytecode>) + Send>,
    ) -> Result<(), Self::Error> {
        let account = self.account_or_insert_mut(&address);
        let old_code_hash = account.info.code_hash;

        modifier(
            &mut account.info.balance,
            &mut account.info.nonce,
            &mut account.info.code,
        );

        let new_code_hash = account
            .info
            .code
            .as_ref()
            .map_or(KECCAK_EMPTY, |code| code.hash());

        account.info.code_hash = new_code_hash;

        if new_code_hash != KECCAK_EMPTY {
            // Store code separately from the account
            let code = account.info.code.take().unwrap();
            self.last_layer_mut().contracts.insert(new_code_hash, code);
        }

        if old_code_hash != KECCAK_EMPTY && old_code_hash != new_code_hash {
            // The old contract should now return empty bytecode
            self.last_layer_mut()
                .contracts
                .insert(old_code_hash, Bytecode::new());
        }

        Ok(())
    }

    fn remove_account(&mut self, address: Address) -> Result<Option<AccountInfo>, Self::Error> {
        Ok(self.remove_account(&address))
    }

    fn remove_snapshot(&mut self, state_root: &B256) -> bool {
        self.snapshots.remove(state_root).is_some()
    }

    fn set_account_storage_slot(
        &mut self,
        address: Address,
        index: U256,
        value: U256,
    ) -> Result<(), Self::Error> {
        self.account_or_insert_mut(&address)
            .storage
            .insert(index, value);

        Ok(())
    }

    fn set_state_root(&mut self, state_root: &B256) -> Result<(), Self::Error> {
        // Ensure the last layer has a state root
        if !self.last_layer_mut().has_state_root() {
            let state_root = self.state_root()?;
            self.last_layer_mut().state_root.replace(state_root);
        }

        if let Some(snapshot) = self.snapshots.remove(state_root) {
            self.stack = snapshot;

            return Ok(());
        }

        let layer_id = self.stack.iter().enumerate().find_map(|(layer_id, layer)| {
            if layer.state_root.unwrap() == *state_root {
                Some(layer_id)
            } else {
                None
            }
        });

        if let Some(layer_id) = layer_id {
            self.stack.truncate(layer_id + 1);

            Ok(())
        } else {
            Err(StateError::InvalidStateRoot(*state_root))
        }
    }

    fn state_root(&mut self) -> Result<B256, Self::Error> {
        let mut state = HashMap::new();

        self.iter()
            .flat_map(|layer| layer.accounts.iter())
            .for_each(|(address, account)| {
                state
                    .entry(*address)
                    .or_insert(account.as_ref().map(|account| BasicAccount {
                        nonce: U256::from(account.info.nonce),
                        balance: account.info.balance,
                        storage_root: storage_root(&account.storage),
                        code_hash: account.info.code_hash,
                    }));
            });

        let state = state
            .iter()
            .filter_map(|(address, account)| account.as_ref().map(|account| (address, account)));

        Ok(state_root(state))
    }

    fn checkpoint(&mut self) -> Result<(), Self::Error> {
        let state_root = self.state_root()?;
        self.last_layer_mut().state_root.replace(state_root);

        self.add_layer_default();

        Ok(())
    }

    fn revert(&mut self) -> Result<(), Self::Error> {
        let last_layer_id = self.last_layer_id();
        if last_layer_id > 0 {
            self.revert_to_layer(last_layer_id - 1);
            Ok(())
        } else {
            Err(StateError::CannotRevert)
        }
    }
}
