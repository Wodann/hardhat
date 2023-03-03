use hashbrown::HashMap;
use rethnet_eth::{account::BasicAccount, state::state_root, Address, B256, U256};
use revm::{
    db::State,
    primitives::{Account, AccountInfo, Bytecode, KECCAK_EMPTY},
    DatabaseCommit,
};

use super::{account::RethnetAccount, storage::RethnetStorage, StateDebug, StateError};

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
    /// Address -> Account
    accounts: HashMap<Address, RethnetAccount>,
    /// Code hash -> Address
    contracts: HashMap<B256, Bytecode>,
    /// Cached state root
    state_root: Option<B256>,
}

impl RethnetLayer {
    /// Creates a `RethnetLayer` with the provided genesis accounts.
    pub fn with_genesis_accounts(genesis_accounts: HashMap<Address, AccountInfo>) -> Self {
        let mut accounts: HashMap<Address, RethnetAccount> = genesis_accounts
            .into_iter()
            .map(|(address, account_info)| (address, RethnetAccount::new(account_info)))
            .collect();

        let contracts = accounts
            .iter_mut()
            .filter_map(|(_address, account)| {
                let code = account.split_code();
                code.map(|code| (code.hash(), code))
            })
            .collect();

        Self {
            accounts,
            contracts,
            state_root: None,
        }
    }

    fn mark_dirty(&mut self) {
        self.state_root = None;
    }

    /// Retrieves or calculates and caches the layer's state root.
    pub fn state_root(&mut self) -> B256 {
        if let Some(state_root) = self.state_root {
            state_root
        } else {
            let state = self
                .accounts
                .iter_mut()
                .map(|(address, account)| {
                    let account = BasicAccount {
                        nonce: U256::from(account.info.nonce),
                        balance: account.info.balance,
                        storage_root: account.storage.storage_root(),
                        code_hash: account.info.code_hash,
                    };

                    (*address, account)
                })
                .collect();

            let state_root = state_root(&state);
            self.state_root = Some(state_root);
            state_root
        }
    }

    /// Returns whether the layer has a state root.
    pub fn has_state_root(&self) -> bool {
        self.state_root.is_some()
    }

    /// Insert the provided `AccountInfo` at the specified `address`.
    pub fn insert_account(&mut self, address: Address, mut account: RethnetAccount) {
        if let Some(code) = account.split_code() {
            self.contracts.insert(code.hash(), code);
            self.mark_dirty();
        }

        if account.info.code_hash.is_zero() {
            account.info.code_hash = KECCAK_EMPTY;
        }

        let new_code_hash = account.info.code_hash;

        if let Some(old_account) = self.accounts.insert(address, account) {
            self.mark_dirty();

            if old_account.info.code_hash != new_code_hash {
                self.contracts.remove(&old_account.info.code_hash);
            }
        }
    }

    /// Removes the [`AccountInfo`] corresponding to the specified address.
    fn remove_account(&mut self, address: &Address) -> Option<RethnetAccount> {
        let account = self.accounts.remove(address);

        if let Some(account_info) = &account {
            debug_assert!(account_info.info.code.is_none());

            self.mark_dirty();
            self.contracts.remove(&account_info.info.code_hash);
        }

        account
    }
}

impl State for LayeredState<RethnetLayer> {
    type Error = StateError;

    fn basic(&mut self, address: Address) -> Result<Option<AccountInfo>, Self::Error> {
        let account = self
            .last_layer_mut()
            .accounts
            .get(&address)
            .map(|account| account.info.clone());

        // TODO: Move this out of LayeredState when forking
        Ok(account.or(Some(AccountInfo {
            balance: U256::ZERO,
            nonce: 0,
            code_hash: KECCAK_EMPTY,
            code: None,
        })))
    }

    fn code_by_hash(&mut self, code_hash: B256) -> Result<Bytecode, Self::Error> {
        if code_hash == KECCAK_EMPTY {
            return Ok(Bytecode::new());
        }

        self.last_layer_mut()
            .contracts
            .get(&code_hash)
            .cloned()
            .ok_or(StateError::InvalidCodeHash(code_hash))
    }

    fn storage(&mut self, address: Address, index: U256) -> Result<U256, Self::Error> {
        Ok(self
            .last_layer_mut()
            .accounts
            .get(&address)
            .and_then(|account| account.storage.get(&index))
            .cloned()
            .unwrap_or(U256::ZERO))
    }
}

impl DatabaseCommit for LayeredState<RethnetLayer> {
    fn commit(&mut self, changes: HashMap<Address, Account>) {
        if !changes.is_empty() {
            self.last_layer_mut().mark_dirty();
        }

        changes.into_iter().for_each(|(address, account)| {
            if account.is_empty() || account.is_destroyed {
                self.last_layer_mut().remove_account(&address);
            } else {
                let last_layer = self.last_layer_mut();

                if let Some(old_account) = last_layer.accounts.get_mut(&address) {
                    old_account.info = account.info.clone();

                    if account.storage_cleared {
                        old_account.storage = RethnetStorage::default();
                    }

                    old_account.storage.extend(
                        account
                            .storage
                            .into_iter()
                            .map(|(index, value)| (index, value.present_value())),
                    );
                } else {
                    last_layer.insert_account(
                        address,
                        RethnetAccount {
                            info: account.info,
                            storage: RethnetStorage::new(
                                account
                                    .storage
                                    .into_iter()
                                    .filter(|(_index, value)| value.present_value() != U256::ZERO)
                                    .map(|(index, value)| (index, value.present_value()))
                                    .collect(),
                            ),
                        },
                    )
                }
            }
        });
    }
}

impl StateDebug for LayeredState<RethnetLayer> {
    type Error = StateError;

    fn account_storage_root(&mut self, address: &Address) -> Result<Option<B256>, Self::Error> {
        Ok(self
            .last_layer_mut()
            .accounts
            .get_mut(address)
            .map(|account| account.storage.storage_root()))
    }

    fn insert_account(
        &mut self,
        address: Address,
        account_info: AccountInfo,
    ) -> Result<(), Self::Error> {
        self.last_layer_mut()
            .insert_account(address, RethnetAccount::new(account_info));

        Ok(())
    }

    fn make_snapshot(&mut self) -> (B256, bool) {
        let state_root = self.last_layer_mut().state_root();

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
        let account = self.last_layer_mut().accounts.entry(address).or_default();

        let old_code_hash = account.info.code_hash;

        modifier(
            &mut account.info.balance,
            &mut account.info.nonce,
            &mut account.info.code,
        );

        if let Some(code) = account.info.code.take() {
            let new_code_hash = code.hash();

            if old_code_hash != new_code_hash {
                account.info.code_hash = new_code_hash;

                let last_layer = self.last_layer_mut();
                last_layer.contracts.remove(&old_code_hash);
                last_layer.contracts.insert(new_code_hash, code);
            }
        }

        self.last_layer_mut().mark_dirty();

        Ok(())
    }

    fn remove_account(&mut self, address: Address) -> Result<Option<AccountInfo>, Self::Error> {
        Ok(self
            .last_layer_mut()
            .remove_account(&address)
            .map(|account| account.info))
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
        let last_layer = self.last_layer_mut();

        last_layer.mark_dirty();
        last_layer
            .accounts
            .entry(address)
            .or_default()
            .storage
            .insert(index, value);

        Ok(())
    }

    fn set_state_root(&mut self, state_root: &B256) -> Result<(), Self::Error> {
        // A snapshot can only be used once
        if let Some(snapshot) = self.snapshots.remove(state_root) {
            self.stack = snapshot;

            Ok(())
        } else if let Some(layer_id) =
            self.stack
                .iter_mut()
                .enumerate()
                .find_map(|(layer_id, layer)| {
                    if layer.state_root() == *state_root {
                        Some(layer_id)
                    } else {
                        None
                    }
                })
        {
            self.stack.truncate(layer_id + 1);

            Ok(())
        } else {
            Err(StateError::InvalidStateRoot(*state_root))
        }
    }

    fn state_root(&mut self) -> Result<B256, Self::Error> {
        Ok(self.last_layer_mut().state_root())
    }

    fn checkpoint(&mut self) -> Result<(), Self::Error> {
        let state_root = self.state_root()?;

        let last_layer = self.last_layer_mut().clone();
        self.last_layer_mut().state_root.replace(state_root);
        self.add_layer(last_layer);

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
