use std::mem;

use napi::{
    bindgen_prelude::{BigInt, Buffer},
    Env, JsBuffer, JsBufferValue,
};
use napi_derive::napi;
use rethnet_eth::{Bytes, U256};

use crate::cast::TryCast;

#[napi(object)]
pub struct Bytecode {
    /// 256-bit code hash
    #[napi(readonly)]
    pub hash: JsBuffer,
    /// Byte code
    #[napi(readonly)]
    pub code: JsBuffer,
}

#[napi(object)]
pub struct AccountData {
    /// Account balance
    #[napi(readonly)]
    pub balance: Option<BigInt>,
    /// Account nonce
    #[napi(readonly)]
    pub nonce: Option<BigInt>,
    /// Optionally, byte code. Otherwise, hash is equal to `KECCAK_EMPTY`
    #[napi(readonly)]
    pub code: Option<Option<Bytecode>>,
}

// #[napi(object)]
// pub struct Account {
//     /// Account balance
//     #[napi(readonly)]
//     pub balance: BigInt,
//     /// Account nonce
//     #[napi(readonly)]
//     pub nonce: BigInt,
//     /// Optionally, byte code. Otherwise, hash is equal to `KECCAK_EMPTY`
//     #[napi(readonly)]
//     pub code: Option<Bytecode>,
// }

#[napi]
pub struct Account {
    inner: rethnet_evm::AccountInfo,
}

#[napi]
impl Account {
    #[napi(getter)]
    pub fn balance(&self) -> BigInt {
        BigInt {
            sign_bit: false,
            words: self.inner.balance.as_limbs().to_vec(),
        }
    }

    #[napi(getter)]
    pub fn nonce(&self) -> u64 {
        self.inner.nonce
    }

    #[napi(getter)]
    pub fn code_hash(&self) -> Buffer {
        Buffer::from(self.inner.code_hash.to_vec())
    }

    #[napi(getter)]
    pub fn code(&self, mut env: Env) -> napi::Result<Option<JsBuffer>> {
        self.inner.code.as_ref().map_or(Ok(None), |code| {
            let code = code.original_bytes();

            env.adjust_external_memory(code.len() as i64);

            unsafe {
                env.create_buffer_with_borrowed_data(
                    code.as_ptr(),
                    code.len(),
                    code,
                    |code: Bytes, mut env| {
                        env.adjust_external_memory(-(code.len() as i64));
                        mem::drop(code);
                    },
                )
            }
            .map(JsBufferValue::into_raw)
            .map(Some)
        })
    }

    pub(crate) fn as_inner(&self) -> &rethnet_evm::AccountInfo {
        &self.inner
    }
}

impl TryCast<rethnet_evm::AccountInfo> for Account {
    type Error = napi::Error;

    fn try_cast(self) -> Result<rethnet_evm::AccountInfo, Self::Error> {
        Ok(self.inner)
    }
}

// impl Bytecode {
//     pub fn new(env: &Env, bytecode: rethnet_evm::Bytecode) -> napi::Result<Self> {
//         let code = bytecode.original_bytes();

//         let hash = env
//             .create_buffer_with_data(bytecode.hash().to_vec())
//             .map(JsBufferValue::into_raw)?;

//         let code = unsafe {
//             env.create_buffer_with_borrowed_data(
//                 code.as_ptr(),
//                 code.len(),
//                 code,
//                 |code: Bytes, _env| {
//                     mem::drop(code);
//                 },
//             )
//         }
//         .map(JsBufferValue::into_raw)?;

//         Ok(Self { hash, code })
//     }
// }

impl From<rethnet_evm::AccountInfo> for Account {
    fn from(account_info: rethnet_evm::AccountInfo) -> Self {
        Self {
            inner: account_info,
        }
    }
}

impl
    TryCast<(
        Option<U256>,
        Option<u64>,
        Option<Option<rethnet_evm::Bytecode>>,
    )> for AccountData
{
    type Error = napi::Error;

    fn try_cast(
        self,
    ) -> Result<
        (
            Option<U256>,
            Option<u64>,
            Option<Option<rethnet_evm::Bytecode>>,
        ),
        Self::Error,
    > {
        let balance = self
            .balance
            .map_or(Ok(None), |balance| BigInt::try_cast(balance).map(Some))?;

        let nonce = self.nonce.map(|nonce| nonce.get_u64().1);

        let code = self.code.map_or(Ok(None), |code| {
            code.map_or(Ok(Some(None)), |code| {
                code.hash
                    .into_value()
                    .map(|hash| rethnet_eth::B256::from_slice(&hash))
                    .and_then(|code_hash| {
                        code.code
                            .into_value()
                            .map(|code| (code_hash, Bytes::copy_from_slice(code.as_ref())))
                    })
                    .map(|(code_hash, code)| {
                        debug_assert_eq!(
                            code_hash,
                            rethnet_evm::Bytecode::new_raw(code.clone()).hash()
                        );

                        Some(Some(unsafe {
                            rethnet_evm::Bytecode::new_raw_with_hash(code, code_hash)
                        }))
                    })
            })
        })?;

        Ok((balance, nonce, code))
    }
}
