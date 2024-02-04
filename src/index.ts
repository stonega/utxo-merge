import * as secp256k1 from "@bitcoinerlab/secp256k1";
import ECPairFactory from "ecpair";
import * as bitcoin from "bitcoinjs-lib";
import { OpenApiService } from "./open_api";
import dotenv from 'dotenv'
dotenv.config()

const toXOnly = (pubKey: Buffer) =>
  pubKey.length === 32 ? pubKey : pubKey.slice(1, 33);

const ECPair = ECPairFactory(secp256k1);
bitcoin.initEccLib(secp256k1);

function tweakSigner(
  signer: bitcoin.Signer,
  opts: any = {}
): bitcoin.Signer {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let privateKey: Uint8Array | undefined = signer.privateKey!;
  if (!privateKey) {
    throw new Error("Private key is required for tweaking signer!");
  }
  if (signer.publicKey[0] === 3) {
    privateKey = secp256k1.privateNegate(privateKey);
  }

  const tweakedPrivateKey = secp256k1.privateAdd(
    privateKey,
    tapTweakHash(toXOnly(signer.publicKey), opts.tweakHash)
  );
  if (!tweakedPrivateKey) {
    throw new Error("Invalid tweaked private key!");
  }

  return ECPair.fromPrivateKey(Buffer.from(tweakedPrivateKey), {
    network: opts.network,
  });
}
function tapTweakHash(pubKey: Buffer, h: Buffer | undefined): Buffer {
  return bitcoin.crypto.taggedHash(
    "TapTweak",
    Buffer.concat(h ? [pubKey, h] : [pubKey])
  );
}

const privateKey = process.env.PRIVATE_KEY;

if (!privateKey) {
  throw new Error("PRIVATE_KEY is required");
}
async function merge({ value, amount }: {value: number, amount: number}) {
  const network = bitcoin.networks.testnet;
  const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey!, "hex"), {
    network,
  });

  const { address } = bitcoin.payments.p2tr({
    internalPubkey: keyPair.publicKey.slice(1, 33),
    network,
  });
  const api = new OpenApiService("bitcoin_testnet");

  const utxos = await api.getAddressUtxo(address!);

  let inputUtxos = utxos
    .filter((utxo) => utxo.satoshis === value)
    .slice(0, amount)
    .map((i) => ({
      hash: i.txId,
      index: i.outputIndex,
      tapInternalKey: toXOnly(keyPair.publicKey),
      witnessUtxo: {
        value: i.satoshis,
        script: Buffer.from(i.scriptPk, "hex"),
      },
    }));

  const fee = Math.ceil(57.5 * inputUtxos.length + 43 + 10.5);
  const output = {
    address: address!,
    value: value * 100 - fee,
  };

  const psbt = new bitcoin.Psbt({ network })
    .addInputs(inputUtxos)
    .addOutput(output)
    .signAllInputs(tweakSigner(keyPair))
    .finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const feeRate = psbt.getFeeRate();
  console.log(`
=============================================================================================
Summary
  txid:     ${tx.getId()}
  Size:     ${tx.virtualSize()}
  fee:      ${fee}
  Fee Rate: ${feeRate} sat/vB
  Detail:   ${psbt.txInputs.length} Inputs, ${psbt.txOutputs.length} Outputs
----------------------------------------------------------------------------------------------
`);

    const rawtx = tx.toHex();
    const result = await api.pushTx(rawtx);
    console.log(result);
    return result;
}

async function main() {
    for(let i = 0; i < 1; i++) {
        const tx = await merge({value: 1000, amount: 100});
        // wait 2 seconds
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

main().catch(console.error);