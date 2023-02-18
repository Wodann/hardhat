import { Block } from "@nomicfoundation/ethereumjs-block";
import { Common } from "@nomicfoundation/ethereumjs-common";
import {
  Account,
  Address,
  KECCAK256_NULL,
} from "@nomicfoundation/ethereumjs-util";
import { TypedTransaction } from "@nomicfoundation/ethereumjs-tx";
import {
  Account as RethnetAccount,
  BlockBuilder,
  Blockchain,
  Bytecode,
  Rethnet,
  Tracer,
  TracingMessage,
  TracingMessageResult,
  TracingStep,
} from "rethnet-evm";

import { isForkedNodeConfig, NodeConfig } from "../node-types";
import {
  ethereumjsHeaderDataToRethnet,
  ethereumjsTransactionToRethnet,
  ethereumsjsHardforkToRethnet,
  rethnetResultToRunTxResult,
} from "../utils/convertToRethnet";
import { hardforkGte, HardforkName } from "../../../util/hardforks";
import { keccak256 } from "../../../util/keccak";
import { RethnetStateManager } from "../RethnetState";
import { MessageTrace } from "../../stack-traces/message-trace";
import { VMDebugTracer } from "../../stack-traces/vm-debug-tracer";
import { VMTracer } from "../../stack-traces/vm-tracer";

import { RunTxResult, VMAdapter } from "./vm-adapter";

/* eslint-disable @nomiclabs/hardhat-internal-rules/only-hardhat-error */
/* eslint-disable @typescript-eslint/no-unused-vars */

export class RethnetAdapter implements VMAdapter {
  private _vmTracer: VMTracer;
  private _vmDebugTracer: VMDebugTracer | undefined;

  constructor(
    private _blockchain: Blockchain,
    private _state: RethnetStateManager,
    private _rethnet: Rethnet,
    private readonly _selectHardfork: (blockNumber: bigint) => string,
    private _common: Common
  ) {
    this._vmTracer = new VMTracer(_common, false);
  }

  public static async create(
    config: NodeConfig,
    selectHardfork: (blockNumber: bigint) => string,
    getBlockHash: (blockNumber: bigint) => Promise<Buffer>,
    common: Common
  ): Promise<RethnetAdapter> {
    if (isForkedNodeConfig(config)) {
      // eslint-disable-next-line @nomiclabs/hardhat-internal-rules/only-hardhat-error
      throw new Error("Forking is not supported for Rethnet yet");
    }

    const blockchain = new Blockchain(getBlockHash);

    const limitContractCodeSize =
      config.allowUnlimitedContractSize === true ? 2n ** 64n - 1n : undefined;

    const state = RethnetStateManager.withGenesisAccounts(
      config.genesisAccounts
    );

    const rethnet = new Rethnet(blockchain, state.asInner(), {
      chainId: BigInt(config.chainId),
      specId: ethereumsjsHardforkToRethnet(config.hardfork as HardforkName),
      limitContractCodeSize,
      disableBlockGasLimit: true,
      disableEip3607: true,
    });

    return new RethnetAdapter(
      blockchain,
      state,
      rethnet,
      selectHardfork,
      common
    );
  }

  /**
   * Run `tx` with the given `blockContext`, without modifying the state.
   */
  public async dryRun(
    tx: TypedTransaction,
    blockContext: Block,
    forceBaseFeeZero?: boolean
  ): Promise<RunTxResult> {
    const rethnetTx = ethereumjsTransactionToRethnet(tx);

    const difficulty = this._getBlockEnvDifficulty(
      blockContext.header.difficulty
    );

    const prevRandao = this._getBlockPrevRandao(
      blockContext.header.number,
      blockContext.header.mixHash
    );

    const tracer = new Tracer({
      beforeMessage: this._beforeMessageHandler,
      step: this._stepHandler,
      afterMessage: this._afterMessageHandler,
    });

    const rethnetResult = await this._rethnet.guaranteedDryRun(
      rethnetTx,
      {
        number: blockContext.header.number,
        coinbase: blockContext.header.coinbase.buf,
        timestamp: blockContext.header.timestamp,
        basefee:
          forceBaseFeeZero === true ? 0n : blockContext.header.baseFeePerGas,
        gasLimit: blockContext.header.gasLimit,
        difficulty,
        prevrandao: prevRandao,
      },
      tracer
    );

    try {
      const result = rethnetResultToRunTxResult(
        rethnetResult.execResult,
        blockContext.header.gasUsed
      );
      return result;
    } catch (e) {
      // console.log("Rethnet trace");
      // console.log(rethnetResult.execResult.trace);
      throw e;
    }
  }

  /**
   * Get the account info for the given address.
   */
  public async getAccount(address: Address): Promise<Account> {
    const account = await this._state.getAccount(address);
    const storageRoot = await this._state.getAccountStorageRoot(address);
    return new Account(
      account?.nonce,
      account?.balance,
      storageRoot ?? undefined,
      account?.code?.hash
    );
  }

  /**
   * Get the storage value at the given address and slot.
   */
  public async getContractStorage(
    address: Address,
    key: Buffer
  ): Promise<Buffer> {
    return this._state.getContractStorage(address, key);
  }

  /**
   * Get the contract code at the given address.
   */
  public async getContractCode(address: Address): Promise<Buffer> {
    return this._state.getContractCode(address);
  }

  /**
   * Update the account info for the given address.
   */
  public async putAccount(address: Address, account: Account): Promise<void> {
    const contractCode =
      account.codeHash === KECCAK256_NULL
        ? undefined
        : await this._state.getContractCode(address);

    return this._state.modifyAccount(
      address,
      async function (
        balance: bigint,
        nonce: bigint,
        code: Bytecode | undefined
      ): Promise<RethnetAccount> {
        const newCode: Bytecode | undefined =
          account.codeHash === KECCAK256_NULL
            ? undefined
            : account.codeHash === code?.hash
            ? code
            : {
                hash: account.codeHash,
                code: contractCode!,
              };

        return {
          balance: account.balance,
          nonce: account.nonce,
          code: newCode,
        };
      }
    );
  }

  /**
   * Update the contract code for the given address.
   */
  public async putContractCode(address: Address, value: Buffer): Promise<void> {
    const codeHash = keccak256(value);
    return this._state.modifyAccount(
      address,
      async function (
        balance: bigint,
        nonce: bigint,
        code: Bytecode | undefined
      ): Promise<RethnetAccount> {
        const newCode: Bytecode | undefined =
          codeHash === KECCAK256_NULL
            ? undefined
            : codeHash === code?.hash
            ? code
            : {
                hash: codeHash,
                code: value,
              };

        return {
          balance,
          nonce,
          code: newCode,
        };
      }
    );
  }

  /**
   * Update the value of the given storage slot.
   */
  public async putContractStorage(
    address: Address,
    key: Buffer,
    value: Buffer
  ): Promise<void> {
    await this._state.putContractStorage(address, key, value);
  }

  /**
   * Get the root of the current state trie.
   */
  public async getStateRoot(): Promise<Buffer> {
    return this._state.getStateRoot();
  }

  /**
   * Reset the state trie to the point after `block` was mined. If
   * `irregularStateOrUndefined` is passed, use it as the state root.
   */
  public async setBlockContext(
    block: Block,
    irregularStateOrUndefined: Buffer | undefined
  ): Promise<void> {
    return this._state.setStateRoot(
      irregularStateOrUndefined ?? block.header.stateRoot
    );
  }

  /**
   * Reset the state trie to the point where it had the given state root.
   *
   * Throw if it can't.
   */
  public async restoreContext(stateRoot: Buffer): Promise<void> {
    return this._state.setStateRoot(stateRoot);
  }

  /**
   * Start a new block and accept transactions sent with `runTxInBlock`.
   */
  public async startBlock(): Promise<void> {
    await this._state.checkpoint();
  }

  /**
   * Must be called after `startBlock`, and before `addBlockRewards`.
   */
  public async runTxInBlock(
    tx: TypedTransaction,
    block: Block
  ): Promise<RunTxResult> {
    const rethnetTx = ethereumjsTransactionToRethnet(tx);

    const difficulty = this._getBlockEnvDifficulty(block.header.difficulty);

    const prevRandao = this._getBlockPrevRandao(
      block.header.number,
      block.header.mixHash
    );

    const tracer = new Tracer({
      beforeMessage: this._beforeMessageHandler,
      step: this._stepHandler,
      afterMessage: this._afterMessageHandler,
    });

    const rethnetResult = await this._rethnet.run(
      rethnetTx,
      ethereumjsHeaderDataToRethnet(block.header, difficulty, prevRandao),
      tracer
    );

    try {
      const result = rethnetResultToRunTxResult(
        rethnetResult,
        block.header.gasUsed
      );
      return result;
    } catch (e) {
      // console.log("Rethnet trace");
      // console.log(rethnetResult.trace);
      throw e;
    }
  }

  /**
   * Must be called after `startBlock` and all `runTxInBlock` calls.
   */
  public async addBlockRewards(
    rewards: Array<[Address, bigint]>
  ): Promise<void> {
    const blockBuilder = BlockBuilder.new(
      this._blockchain,
      this._state.asInner(),
      {},
      {
        // Dummy values
        parentHash: Buffer.alloc(32, 0),
        ommersHash: Buffer.alloc(32, 0),
        beneficiary: Buffer.alloc(20, 0),
        stateRoot: Buffer.alloc(32, 0),
        transactionsRoot: Buffer.alloc(32, 0),
        receiptsRoot: Buffer.alloc(32, 0),
        logsBloom: Buffer.alloc(256, 0),
        difficulty: 0n,
        number: 0n,
        gasLimit: 0n,
        gasUsed: 0n,
        timestamp: 0n,
        extraData: Buffer.allocUnsafe(0),
        mixHash: Buffer.alloc(32, 0),
        nonce: 0n,
      },
      {}
    );

    await blockBuilder.finalize(
      rewards.map(([address, reward]) => {
        return [address.buf, reward];
      })
    );
  }

  /**
   * Finish the block successfully. Must be called after `addBlockRewards`.
   */
  public async sealBlock(): Promise<void> {}

  /**
   * Revert the block and discard the changes to the state. Can be called
   * at any point after `startBlock`.
   */
  public async revertBlock(): Promise<void> {
    await this._state.revert();
  }

  public async makeSnapshot(): Promise<Buffer> {
    return this._state.makeSnapshot();
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
    return this._state.accountIsEmpty(new Address(address));
  }

  public async isWarmedAddress(_address: Buffer): Promise<boolean> {
    // TODO
    return true;
  }

  private _getBlockEnvDifficulty(
    difficulty: bigint | undefined
  ): bigint | undefined {
    const MAX_DIFFICULTY = 2n ** 32n - 1n;
    if (difficulty !== undefined && difficulty > MAX_DIFFICULTY) {
      console.debug(
        "Difficulty is larger than U256::max:",
        difficulty.toString(16)
      );
      return MAX_DIFFICULTY;
    }

    return difficulty;
  }

  private _getBlockPrevRandao(
    blockNumber: bigint,
    mixHash: Buffer | undefined
  ): Buffer | undefined {
    const hardfork = this._selectHardfork(blockNumber);
    const isPostMergeHardfork = hardforkGte(
      hardfork as HardforkName,
      HardforkName.MERGE
    );

    if (isPostMergeHardfork) {
      if (mixHash === undefined) {
        throw new Error("mixHash must be set for post-merge hardfork");
      }

      return mixHash;
    }

    return undefined;
  }

  private _beforeMessageHandler = async (message: TracingMessage) => {
    await this._vmTracer.addBeforeMessage(message);
    if (this._vmDebugTracer !== undefined) {
      await this._vmDebugTracer.addBeforeMessage(message);
    }
  };

  private _stepHandler = async (step: TracingStep) => {
    await this._vmTracer.addStep(step);
    if (this._vmDebugTracer !== undefined) {
      await this._vmDebugTracer.addStep(step);
    }
  };

  private _afterMessageHandler = async (result: TracingMessageResult) => {
    await this._vmTracer.addAfterMessage(result);
    if (this._vmDebugTracer !== undefined) {
      await this._vmDebugTracer.addAfterMessage(result);
    }
  };
}
