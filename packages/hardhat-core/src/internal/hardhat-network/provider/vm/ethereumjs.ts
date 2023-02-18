import { Block } from "@nomicfoundation/ethereumjs-block";
import { Common } from "@nomicfoundation/ethereumjs-common";
import {
  EVM,
  EVMResult,
  InterpreterStep,
  Message,
} from "@nomicfoundation/ethereumjs-evm";
import { ERROR } from "@nomicfoundation/ethereumjs-evm/dist/exceptions";
import {
  DefaultStateManager,
  StateManager,
} from "@nomicfoundation/ethereumjs-statemanager";
import { TypedTransaction } from "@nomicfoundation/ethereumjs-tx";
import { Account, Address } from "@nomicfoundation/ethereumjs-util";
import { EEI, VM } from "@nomicfoundation/ethereumjs-vm";
import { SuccessReason } from "rethnet-evm";
import { assertHardhatInvariant } from "../../../core/errors";
import { MessageTrace } from "../../stack-traces/message-trace";
import { VMDebugTracer } from "../../stack-traces/vm-debug-tracer";
import { VMTracer } from "../../stack-traces/vm-tracer";
import { ForkStateManager } from "../fork/ForkStateManager";
import { isForkedNodeConfig, NodeConfig } from "../node-types";
import { HardhatBlockchainInterface } from "../types/HardhatBlockchainInterface";
import { Bloom } from "../utils/bloom";
import { makeForkClient } from "../utils/makeForkClient";
import { makeStateTrie } from "../utils/makeStateTrie";
import { Exit } from "./exit";
import { RunTxResult, VMAdapter } from "./vm-adapter";

/* eslint-disable @nomiclabs/hardhat-internal-rules/only-hardhat-error */

export class EthereumJSAdapter implements VMAdapter {
  private _blockStartStateRoot: Buffer | undefined;

  private _vmTracer: VMTracer;
  private _vmDebugTracer: VMDebugTracer | undefined;

  constructor(
    private readonly _vm: VM,
    private readonly _stateManager: StateManager,
    private readonly _blockchain: HardhatBlockchainInterface,
    private readonly _common: Common,
    private readonly _configNetworkId: number,
    private readonly _configChainId: number,
    private readonly _selectHardfork: (blockNumber: bigint) => string,
    private readonly _forkNetworkId?: number,
    private readonly _forkBlockNumber?: bigint
  ) {
    this._vmTracer = new VMTracer(_common, false);

    assertHardhatInvariant(
      this._vm.evm.events !== undefined,
      "EVM should have an 'events' property"
    );

    this._vm.evm.events.on("beforeMessage", this._beforeMessageHandler);
    this._vm.evm.events.on("step", this._stepHandler);
    this._vm.evm.events.on("afterMessage", this._afterMessageHandler);
  }

  public static async create(
    common: Common,
    blockchain: HardhatBlockchainInterface,
    config: NodeConfig,
    selectHardfork: (blockNumber: bigint) => string
  ): Promise<EthereumJSAdapter> {
    let stateManager: StateManager;
    let forkBlockNum: bigint | undefined;
    let forkNetworkId: number | undefined;

    if (isForkedNodeConfig(config)) {
      const { forkClient, forkBlockNumber } = await makeForkClient(
        config.forkConfig,
        config.forkCachePath
      );

      forkNetworkId = forkClient.getNetworkId();
      forkBlockNum = forkBlockNumber;

      const forkStateManager = new ForkStateManager(
        forkClient,
        forkBlockNumber
      );
      await forkStateManager.initializeGenesisAccounts(config.genesisAccounts);

      stateManager = forkStateManager;
    } else {
      const stateTrie = await makeStateTrie(config.genesisAccounts);

      stateManager = new DefaultStateManager({
        trie: stateTrie,
      });
    }

    const eei = new EEI(stateManager, common, blockchain);
    const evm = await EVM.create({
      eei,
      allowUnlimitedContractSize: config.allowUnlimitedContractSize,
      common,
    });

    const vm = await VM.create({
      evm,
      activatePrecompiles: true,
      common,
      stateManager,
      blockchain,
    });

    return new EthereumJSAdapter(
      vm,
      stateManager,
      blockchain,
      common,
      config.networkId,
      config.chainId,
      selectHardfork,
      forkNetworkId,
      forkBlockNum
    );
  }

  public async dryRun(
    tx: TypedTransaction,
    blockContext: Block,
    forceBaseFeeZero = false
  ): Promise<RunTxResult> {
    const initialStateRoot = await this.getStateRoot();

    let originalCommon: Common | undefined;

    try {
      // NOTE: This is a workaround of both an @nomicfoundation/ethereumjs-vm limitation, and
      //   a bug in Hardhat Network.
      //
      // See: https://github.com/nomiclabs/hardhat/issues/1666
      //
      // If this VM is running with EIP1559 activated, and the block is not
      // an EIP1559 one, this will crash, so we create a new one that has
      // baseFeePerGas = 0.
      //
      // We also have an option to force the base fee to be zero,
      // we don't want to debit any balance nor fail any tx when running an
      // eth_call. This will make the BASEFEE option also return 0, which
      // shouldn't. See: https://github.com/nomiclabs/hardhat/issues/1688
      if (
        this._isEip1559Active(blockContext.header.number) &&
        (blockContext.header.baseFeePerGas === undefined || forceBaseFeeZero)
      ) {
        blockContext = Block.fromBlockData(blockContext, {
          freeze: false,
          common: this._common,

          skipConsensusFormatValidation: true,
        });

        (blockContext.header as any).baseFeePerGas = 0n;
      }

      originalCommon = (this._vm as any)._common;

      (this._vm as any)._common = Common.custom(
        {
          chainId:
            this._forkBlockNumber === undefined ||
            blockContext.header.number >= this._forkBlockNumber
              ? this._configChainId
              : this._forkNetworkId,
          networkId: this._forkNetworkId ?? this._configNetworkId,
        },
        {
          hardfork: this._selectHardfork(blockContext.header.number),
        }
      );

      const ethereumJSResult = await this._vm.runTx({
        block: blockContext,
        tx,
        skipNonce: true,
        skipBalance: true,
        skipBlockGasLimitValidation: true,
      });

      assertHardhatInvariant(
        ethereumJSResult !== undefined,
        "Should have a result"
      );

      const ethereumJSError = ethereumJSResult.execResult.exceptionError;
      const result: RunTxResult = {
        bloom: new Bloom(ethereumJSResult.bloom.bitvector),
        gasUsed: ethereumJSResult.totalGasSpent,
        receipt: ethereumJSResult.receipt,
        returnValue: ethereumJSResult.execResult.returnValue,
        createdAddress: ethereumJSResult.createdAddress,
        exit: Exit.fromEthereumJSEvmError(ethereumJSError),
      };

      return result;
    } finally {
      if (originalCommon !== undefined) {
        (this._vm as any)._common = originalCommon;
      }
      await this._stateManager.setStateRoot(initialStateRoot);
    }
  }

  public async getStateRoot(): Promise<Buffer> {
    return this._stateManager.getStateRoot();
  }

  public async getAccount(address: Address): Promise<Account> {
    return this._stateManager.getAccount(address);
  }

  public async getContractStorage(
    address: Address,
    key: Buffer
  ): Promise<Buffer> {
    return this._stateManager.getContractStorage(address, key);
  }

  public async getContractCode(address: Address): Promise<Buffer> {
    return this._stateManager.getContractCode(address);
  }

  public async putAccount(address: Address, account: Account): Promise<void> {
    return this._stateManager.putAccount(address, account);
  }

  public async putContractCode(address: Address, value: Buffer): Promise<void> {
    return this._stateManager.putContractCode(address, value);
  }

  public async putContractStorage(
    address: Address,
    key: Buffer,
    value: Buffer
  ): Promise<void> {
    return this._stateManager.putContractStorage(address, key, value);
  }

  public async restoreContext(stateRoot: Buffer): Promise<void> {
    if (this._stateManager instanceof ForkStateManager) {
      return this._stateManager.restoreForkBlockContext(stateRoot);
    }
    return this._stateManager.setStateRoot(stateRoot);
  }

  public async setBlockContext(
    block: Block,
    irregularStateOrUndefined: Buffer | undefined
  ): Promise<void> {
    if (this._stateManager instanceof ForkStateManager) {
      return this._stateManager.setBlockContext(
        block.header.stateRoot,
        block.header.number,
        irregularStateOrUndefined
      );
    }

    return this._stateManager.setStateRoot(
      irregularStateOrUndefined ?? block.header.stateRoot
    );
  }

  public async startBlock(): Promise<void> {
    if (this._blockStartStateRoot !== undefined) {
      throw new Error("a block is already started");
    }

    this._blockStartStateRoot = await this.getStateRoot();
  }

  public async runTxInBlock(
    tx: TypedTransaction,
    block: Block
  ): Promise<RunTxResult> {
    const ethereumJSResult = await this._vm.runTx({ tx, block });

    assertHardhatInvariant(
      ethereumJSResult !== undefined,
      "Should have a result"
    );

    const ethereumJSError = ethereumJSResult.execResult.exceptionError;
    const result: RunTxResult = {
      bloom: new Bloom(ethereumJSResult.bloom.bitvector),
      gasUsed: ethereumJSResult.totalGasSpent,
      receipt: ethereumJSResult.receipt,
      returnValue: ethereumJSResult.execResult.returnValue,
      createdAddress: ethereumJSResult.createdAddress,
      exit: Exit.fromEthereumJSEvmError(ethereumJSError),
    };

    return result;
  }

  public async addBlockRewards(
    rewards: Array<[Address, bigint]>
  ): Promise<void> {
    for (const [address, reward] of rewards) {
      const account = await this._stateManager.getAccount(address);
      account.balance += reward;
      await this._stateManager.putAccount(address, account);
    }
  }

  public async sealBlock(): Promise<void> {
    if (this._blockStartStateRoot === undefined) {
      throw new Error("Cannot seal a block that wasn't started");
    }

    this._blockStartStateRoot = undefined;
  }

  public async revertBlock(): Promise<void> {
    if (this._blockStartStateRoot === undefined) {
      throw new Error("Cannot revert a block that wasn't started");
    }

    await this._stateManager.setStateRoot(this._blockStartStateRoot);
    this._blockStartStateRoot = undefined;
  }

  public async makeSnapshot(): Promise<Buffer> {
    return this.getStateRoot();
  }

  public getLastTrace(): {
    trace: MessageTrace | undefined;
    error: Error | undefined;
  } {
    const trace = this._vmTracer.getLastTopLevelMessageTrace();
    const error = this._vmTracer.getLastError();

    return { trace, error };
  }

  public clearLastError() {
    this._vmTracer.clearLastError();
  }

  public selectHardfork(blockNumber: bigint): string {
    return this._selectHardfork(blockNumber);
  }

  public gteHardfork(hardfork: string): boolean {
    return this._common.gteHardfork(hardfork);
  }

  public getCommon(): Common {
    return this._common;
  }

  public setDebugTracer(debugTracer: VMDebugTracer) {
    this._vmDebugTracer = debugTracer;
  }

  public removeDebugTracer() {
    this._vmDebugTracer = undefined;
  }

  public async accountIsEmpty(address: Buffer): Promise<boolean> {
    return this._stateManager.accountIsEmpty(new Address(address));
  }

  public async isWarmedAddress(address: Buffer): Promise<boolean> {
    return this._vm.eei.isWarmedAddress(address);
  }

  private _isEip1559Active(blockNumberOrPending?: bigint | "pending"): boolean {
    if (
      blockNumberOrPending !== undefined &&
      blockNumberOrPending !== "pending"
    ) {
      return this._common.hardforkGteHardfork(
        this._selectHardfork(blockNumberOrPending),
        "london"
      );
    }
    return this._common.gteHardfork("london");
  }

  private _beforeMessageHandler = async (message: Message, next: any) => {
    try {
      const code =
        message.to !== undefined
          ? await this.getContractCode(message.codeAddress)
          : undefined;
      const beforeMessage = {
        ...message,
        to: message.to?.toBuffer(),
        codeAddress:
          message.to !== undefined ? message.codeAddress.toBuffer() : undefined,
        code,
      };

      await this._vmTracer.addBeforeMessage(beforeMessage);
      if (this._vmDebugTracer !== undefined) {
        await this._vmDebugTracer.addBeforeMessage(beforeMessage);
      }

      return next();
    } catch (e) {
      return next(e);
    }
  };

  private _stepHandler = async (step: InterpreterStep, next: any) => {
    try {
      const tracingStep = {
        depth: step.depth,
        pc: BigInt(step.pc),
        opcode: step.opcode.name,
        // returnValue: 0, // Do we have error values in ethereumjs?
        gasCost: BigInt(step.opcode.fee) + (step.opcode.dynamicFee ?? 0n),
        gasRefunded: step.gasRefund,
        gasLeft: step.gasLeft,
        stack: step.stack,
        memory: step.memory,
        contract: {
          balance: step.account.balance,
          nonce: step.account.nonce,
          code: {
            hash: step.account.codeHash,
            code: Buffer.from([]),
          },
        },
        contractAddress: step.address.buf,
      };

      await this._vmTracer.addStep(tracingStep);
      if (this._vmDebugTracer !== undefined) {
        await this._vmDebugTracer.addStep(tracingStep);
      }

      return next();
    } catch (e) {
      return next(e);
    }
  };

  private _afterMessageHandler = async (result: EVMResult, next: any) => {
    try {
      const gasUsed = result.execResult.executionGasUsed;

      let executionResult;

      if (result.execResult.exceptionError === undefined) {
        const reason =
          result.execResult.selfdestruct !== undefined &&
          Object.keys(result.execResult.selfdestruct).length > 0
            ? SuccessReason.SelfDestruct
            : result.createdAddress !== undefined ||
              result.execResult.returnValue.length > 0
            ? SuccessReason.Return
            : SuccessReason.Stop;

        executionResult = {
          reason,
          gasUsed,
          gasRefunded: result.execResult.gasRefund ?? 0n,
          logs:
            result.execResult.logs?.map((log) => {
              return {
                address: log[0],
                topics: log[1],
                data: log[2],
              };
            }) ?? [],
          output:
            result.createdAddress === undefined
              ? {
                  returnValue: result.execResult.returnValue,
                }
              : {
                  address: result.createdAddress.toBuffer(),
                  returnValue: result.execResult.returnValue,
                },
        };
      } else if (result.execResult.exceptionError.error === ERROR.REVERT) {
        executionResult = {
          gasUsed,
          output: result.execResult.returnValue,
        };
      } else {
        const vmError = Exit.fromEthereumJSEvmError(
          result.execResult.exceptionError
        );

        executionResult = {
          reason: vmError.getRethnetExceptionalHalt(),
          gasUsed,
        };
      }

      const afterMessage = {
        executionResult: {
          result: executionResult,
          trace: {
            steps: [],
            returnValue: result.execResult.returnValue,
          },
        },
      };

      await this._vmTracer.addAfterMessage(afterMessage);
      if (this._vmDebugTracer !== undefined) {
        await this._vmDebugTracer.addAfterMessage(afterMessage);
      }

      return next();
    } catch (e) {
      return next(e);
    }
  };
}
