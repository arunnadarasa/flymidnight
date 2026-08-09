import { describe, expect, test } from "bun:test";
import {
  convertFieldToBytes,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  Contract,
  ledger,
  pureCircuits,
} from "./managed/tokenized-choreo-kits/contract/index.js";

setNetworkId("undeployed");

type PrivateState = {
  localSecretKey: Uint8Array;
};

const witnesses = {
  localSecretKey: ({ privateState }: { privateState: PrivateState }) =>
    [privateState, privateState.localSecretKey] as [PrivateState, Uint8Array],
};

function fixedSecretKey(): Uint8Array {
  const sk = new Uint8Array(32);
  sk[0] = 0x07;
  sk[31] = 0xa1;
  return sk;
}

describe("TokenizedChoreoKits simulator", () => {
  test("constructor seeds kit_count to 1", () => {
    const privateState = { localSecretKey: fixedSecretKey() };
    const contract = new Contract<PrivateState>(witnesses);
    const init = contract.initialState(
      createConstructorContext(privateState, sampleContractAddress()),
    );
    const state = ledger(init.currentContractState.data);
    expect(state.kit_count).toBe(1n);
    expect(state.last_kit).toBe("");
  });

  test("publishKit discloses payload + author commitment and bumps counter", () => {
    const privateState = { localSecretKey: fixedSecretKey() };
    const contract = new Contract<PrivateState>(witnesses);
    const addr = sampleContractAddress();
    const init = contract.initialState(
      createConstructorContext(privateState, addr),
    );

    const payload = JSON.stringify({
      title: "Krump Kit",
      steps: "chest pop, stomp, freeze",
      priceDust: 10,
    });

    const ctx = createCircuitContext(
      addr,
      init.currentZswapLocalState,
      init.currentContractState,
      init.currentPrivateState,
    );
    const result = contract.impureCircuits.publishKit(ctx, payload);
    const state = ledger(result.context.currentQueryContext.state);

    expect(state.kit_count).toBe(2n);
    expect(state.last_kit).toBe(payload);

    // Commitment uses pre-increment kit_count (1) as Bytes<32>, never the raw secret.
    const seq = convertFieldToBytes(32, 1n);
    const expected = pureCircuits.authorCommitment(privateState.localSecretKey, seq);
    expect(Buffer.from(state.last_author_commitment)).toEqual(Buffer.from(expected));
    expect(Buffer.from(state.last_author_commitment)).not.toEqual(
      Buffer.from(privateState.localSecretKey),
    );
  });
});
