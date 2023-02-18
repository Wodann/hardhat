import type { Block } from "@nomicfoundation/ethereumjs-block";
import type { Common } from "@nomicfoundation/ethereumjs-common";
import type { TypedTransaction } from "@nomicfoundation/ethereumjs-tx";
import type { Account, Address } from "@nomicfoundation/ethereumjs-util";
import type { TxReceipt } from "@nomicfoundation/ethereumjs-vm";

import { MessageTrace } from "../../stack-traces/message-trace";
import { VMDebugTracer } from "../../stack-traces/vm-debug-tracer";
import { Bloom } from "../utils/bloom";

import { Exit } from "./exit";

export interface RunTxResult {
  bloom: Bloom;
  createdAddress?: Address;
  gasUsed: bigint;
  returnValue: Buffer;
  exit: Exit;
  receipt: TxReceipt;
}

export interface RunBlockResult {
  results: RunTxResult[];
  receipts: TxReceipt[];
  stateRoot: Buffer;
  logsBloom: Buffer;
  receiptsRoot: Buffer;
  gasUsed: bigint;
}

export interface VMAdapter {
  dryRun(
    tx: TypedTransaction,
    blockContext: Block,
    forceBaseFeeZero?: boolean
  ): Promise<RunTxResult>;

  // getters
  getAccount(address: Address): Promise<Account>;
  getContractStorage(address: Address, key: Buffer): Promise<Buffer>;
  getContractCode(address: Address): Promise<Buffer>;

  // setters
  putAccount(address: Address, account: Account): Promise<void>;
  putContractCode(address: Address, value: Buffer): Promise<void>;
  putContractStorage(
    address: Address,
    key: Buffer,
    value: Buffer
  ): Promise<void>;

  // getters/setters for the whole state
  getStateRoot(): Promise<Buffer>;
  setBlockContext(
    block: Block,
    irregularStateOrUndefined: Buffer | undefined
  ): Promise<void>;
  restoreContext(stateRoot: Buffer): Promise<void>;

  // methods for block-building
  startBlock(): Promise<void>;
  runTxInBlock(tx: TypedTransaction, block: Block): Promise<RunTxResult>;
  addBlockRewards(rewards: Array<[Address, bigint]>): Promise<void>;
  sealBlock(): Promise<void>;
  revertBlock(): Promise<void>;

  // methods for tracing
  getLastTrace(): {
    trace: MessageTrace | undefined;
    error: Error | undefined;
  };
  clearLastError(): void;

  // methods for snapshotting
  makeSnapshot(): Promise<Buffer>;

  setDebugTracer(tracer: VMDebugTracer): void;
  removeDebugTracer(tracer: VMDebugTracer): void;
  getCommon(): Common;
  selectHardfork(blockNumber: bigint): string;
  gteHardfork(hardfork: string): boolean;
  accountIsEmpty(address: Buffer): Promise<boolean>;
  isWarmedAddress(address: Buffer): Promise<boolean>;
}
