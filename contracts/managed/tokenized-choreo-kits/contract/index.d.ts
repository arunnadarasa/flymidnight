import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  localSecretKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  publishKit(context: __compactRuntime.CircuitContext<PS>, payload_0: string): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  publishKit(context: __compactRuntime.CircuitContext<PS>, payload_0: string): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
  authorCommitment(sk_0: Uint8Array, seq_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  authorCommitment(context: __compactRuntime.CircuitContext<PS>,
                   sk_0: Uint8Array,
                   seq_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  publishKit(context: __compactRuntime.CircuitContext<PS>, payload_0: string): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly kit_count: bigint;
  readonly last_kit: string;
  readonly last_author_commitment: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
