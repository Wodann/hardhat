use std::mem;

use napi::{
    bindgen_prelude::{BigInt, Buffer},
    Env, JsBuffer, JsBufferValue,
};
use napi_derive::napi;
use rethnet_evm::trace::{BeforeMessage, Step};

use crate::transaction::result::ExecutionResult;

// #[napi]
// impl Trace {
//     pub fn num_messages(&self) -> usize {
//         self.inner.messages.len()
//     }

//     pub fn message_at(&self, index: usize, env: Env) -> napi::Result<TraceMessage

//     // #[napi(getter)]
//     pub fn return_value(&self, env: Env) -> napi::Result<JsBuffer> {
//         let return_value = self.inner.return_value.clone();

//         unsafe {
//             env.create_buffer_with_borrowed_data(
//                 return_value.as_ptr(),
//                 return_value.len(),
//                 return_value,
//                 |return_value: rethnet_eth::Bytes, _env| {
//                     mem::drop(return_value);
//                 },
//             )
//         }
//         .map(JsBufferValue::into_raw)
//     }
// }

// #[napi(object)]
// pub struct Trace {
//     pub steps: Vec<Step>,
//     pub return_value: Buffer,
// }

// impl From<rethnet_evm::trace::Trace> for Trace {
//     fn from(value: rethnet_evm::trace::Trace) -> Self {
//         let steps = value.steps.into_iter().map(From::from).collect();
//         let return_value = Buffer::from(value.return_value.as_ref());

//         Self {
//             steps,
//             return_value,
//         }
//     }
// }

// #[napi(object)]
// pub struct Step {
//     pub opcode: u8,
//     pub gas_cost: BigInt,
//     pub gas_refunded: i64,
//     pub exit_code: u8,
// }

// impl From<rethnet_evm::trace::Step> for Step {
//     fn from(value: rethnet_evm::trace::Step) -> Self {
//         Self {
//             opcode: value.opcode,
//             gas_cost: BigInt::from(value.gas_cost),
//             gas_refunded: value.gas_refunded,
//             exit_code: value.exit_code as u8,
//         }
//     }
// }

#[napi(object)]
pub struct TracingMessage {
    /// Recipient address. None if it is a Create message.
    #[napi(readonly)]
    pub to: Option<Buffer>,

    /// Depth of the message
    #[napi(readonly)]
    pub depth: u8,

    /// Input data of the message
    #[napi(readonly)]
    pub data: JsBuffer,

    /// Value sent in the message
    #[napi(readonly)]
    pub value: BigInt,

    /// Address of the code that is being executed. Can be different from `to` if a delegate call
    /// is being done.
    #[napi(readonly)]
    pub code_address: Option<Buffer>,

    /// Code of the contract that is being executed.
    #[napi(readonly)]
    pub code: Option<JsBuffer>,
}

impl TracingMessage {
    pub fn new(env: &mut Env, message: &BeforeMessage) -> napi::Result<Self> {
        let data = message.data.clone();

        env.adjust_external_memory(data.len() as i64);

        let data = unsafe {
            env.create_buffer_with_borrowed_data(
                data.as_ptr(),
                data.len(),
                data,
                |data: rethnet_eth::Bytes, mut env| {
                    env.adjust_external_memory(-(data.len() as i64));
                    mem::drop(data);
                },
            )
        }
        .map(JsBufferValue::into_raw)?;

        let code = message.code.as_ref().map_or(Ok(None), |code| {
            let code = code.original_bytes();

            env.adjust_external_memory(code.len() as i64);

            unsafe {
                env.create_buffer_with_borrowed_data(
                    code.as_ptr(),
                    code.len(),
                    code,
                    |code: rethnet_eth::Bytes, mut env| {
                        env.adjust_external_memory(-(code.len() as i64));
                        mem::drop(code);
                    },
                )
            }
            .map(JsBufferValue::into_raw)
            .map(Some)
        })?;

        Ok(TracingMessage {
            to: message.to.map(|to| Buffer::from(to.to_vec())),
            depth: message.depth as u8,
            data,
            value: BigInt {
                sign_bit: false,
                words: message.value.into_limbs().to_vec(),
            },
            code_address: message
                .code_address
                .map(|address| Buffer::from(address.to_vec())),
            code,
        })
    }
}

#[napi(object)]
pub struct TracingStep {
    /// Call depth
    #[napi(readonly)]
    pub depth: u8,
    /// The program counter
    #[napi(readonly)]
    pub pc: BigInt,
    // /// The executed op code
    // #[napi(readonly)]
    // pub opcode: String,
    // /// The return value of the step
    // #[napi(readonly)]
    // pub return_value: u8,
    // /// The amount of gas that was used by the step
    // #[napi(readonly)]
    // pub gas_cost: BigInt,
    // /// The amount of gas that was refunded by the step
    // #[napi(readonly)]
    // pub gas_refunded: BigInt,
    // /// The amount of gas left
    // #[napi(readonly)]
    // pub gas_left: BigInt,
    // /// The stack
    // #[napi(readonly)]
    // pub stack: Vec<BigInt>,
    // /// The memory
    // #[napi(readonly)]
    // pub memory: Buffer,
    // /// The contract being executed
    // #[napi(readonly)]
    // pub contract: Account,
    // /// The address of the contract
    // #[napi(readonly)]
    // pub contract_address: Buffer,
    // /// The address of the code being executed
    // #[napi(readonly)]
    // pub code_address: Buffer,
}

impl TracingStep {
    pub fn new(step: &Step) -> Self {
        Self {
            depth: step.depth as u8,
            pc: BigInt::from(step.pc),
            // opcode: OPCODE_JUMPMAP[usize::from(step.opcode)]
            //     .unwrap_or("")
            //     .to_string(),
            // gas_cost: BigInt::from(0u64),
            // gas_refunded: BigInt::from(0u64),
            // gas_left: BigInt::from(0u64),
            // stack: Vec::new(),
            // memory: Buffer::from(Vec::new()),
            // contract: Account::from(step.contract),
            // contract_address: Buffer::from(step.contract_address.to_vec()),
        }
    }
}

#[napi(object)]
pub struct TracingMessageResult {
    /// Execution result
    #[napi(readonly)]
    pub execution_result: ExecutionResult,
}
