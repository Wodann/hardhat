use revm::{
    interpreter::{InstructionResult, Interpreter},
    Database, EVMData, Inspector, JournaledState,
};
use tokio::{
    sync::{broadcast, mpsc},
    task,
};

/// The command that is sent to interact with the [`AssemblyDebugger`].
#[derive(Clone)]
pub enum DebugCommand {
    /// Steps backwards, if a previous instruction pointer exists.
    StepBackwards,
    /// Steps forwards
    StepForwards,
    /// Stops the EVM
    Stop,
}

/// Error reported by the [`AssemblyDebugger`].
#[derive(Debug, thiserror::Error)]
pub enum DebugError {
    /// The command channel was closed
    #[error("The command channel was closed")]
    CommandChannelClosed,
    /// The execution was stopped by one of the commanders
    #[error("The execution was stopped by one of the commanders")]
    ExecutionStopped,
}

pub struct StepState {
    instruction_pointer: *const u8,
    journaled_state: JournaledState,
}

#[derive(Clone)]
pub struct StepInfo {}

/// A debugger of EVM bytecode.
pub struct AssemblyDebugger {
    step_history: Vec<StepState>,
    pre_step_instruction_pointer: Option<*const u8>,
    /// Keeps the channel open
    command_sender: mpsc::UnboundedSender<DebugCommand>,
    command_receiver: mpsc::UnboundedReceiver<DebugCommand>,
    step_info_sender: broadcast::Sender<StepInfo>,
    error: Option<DebugError>,
}

impl AssemblyDebugger {
    /// Constructs a new [`AssemblyDebugger`].
    pub fn new(capacity: usize) -> Self {
        let (command_sender, command_receiver) = mpsc::unbounded_channel();
        Self {
            step_history: Vec::new(),
            pre_step_instruction_pointer: None,
            command_sender,
            command_receiver,
            step_info_sender: broadcast::channel(capacity).0,
            error: None,
        }
    }

    /// Subscribe to listen to the debugger's step information.
    pub fn subscribe_listener(&self) -> broadcast::Receiver<StepInfo> {
        self.step_info_sender.subscribe()
    }

    /// Subscribe to command the debugger.
    pub fn subscribe_commander(&self) -> mpsc::UnboundedSender<DebugCommand> {
        self.command_sender.clone()
    }
}

impl<DB: Database> Inspector<DB> for AssemblyDebugger {
    fn step(
        &mut self,
        interp: &mut Interpreter,
        data: &mut EVMData<'_, DB>,
        _is_static: bool,
    ) -> InstructionResult {
        // We don't care whether someone is listening, so don't handle the error for when there are no listeners
        let _ = self.step_info_sender.send(StepInfo {});

        // TODO: split between Database & Inspector errors when using `FatalExternalError`

        if let Some(command) = task::block_in_place(|| self.command_receiver.blocking_recv()) {
            match command {
                DebugCommand::StepBackwards => {
                    if let Some(step) = self.step_history.pop() {
                        interp.instruction_pointer = step.instruction_pointer;
                        // TODO: other interp member variables

                        data.journaled_state = step.journaled_state;
                        data.error = None;
                    }
                }
                DebugCommand::StepForwards => {
                    self.pre_step_instruction_pointer = Some(interp.instruction_pointer);
                }
                DebugCommand::Stop => {
                    self.error = Some(DebugError::ExecutionStopped);
                    return InstructionResult::FatalExternalError;
                }
            }
        } else {
            self.error = Some(DebugError::CommandChannelClosed);
            return InstructionResult::FatalExternalError;
        }

        InstructionResult::Continue
    }

    fn step_end(
        &mut self,
        _interp: &mut Interpreter,
        _data: &mut EVMData<'_, DB>,
        _is_static: bool,
        eval: InstructionResult,
    ) -> InstructionResult {
        eval
    }
}
