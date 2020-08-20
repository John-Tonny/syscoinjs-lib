const utils = require('./utils')
const bitcoin = require('bitcoinjs-lib')
const syscointx = require('syscointx-js')
function SyscoinJSLib (blockbookURL, HDSigner, accountIndex, network) {
  if (blockbookURL) {
    this.blockbookURL = blockbookURL
  }
  if (HDSigner) {
    this.HDSigner = HDSigner
    this.network = network || this.HDSigner.network
  } else {
    this.HDSigner = null
    this.network = network
  }
  if (accountIndex) {
    this.accountIndex = accountIndex
  } else {
    this.accountIndex = 0
  }
 
}

SyscoinJSLib.prototype.setAccountIndex = function (accountIndex) {
  this.accountIndex = accountIndex
}

SyscoinJSLib.prototype.createTransaction = async function (changeAddress, outputsArr, feeRate, fromXpubOrAddress, utxos) {
  if (!utxos) {
    if (fromXpubOrAddress) {
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, fromXpubOrAddress)
    } else if(this.HDSigner) {
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, this.HDSigner.getAccountXpub(this.accountIndex))
    }
  }
  const res = syscointx.createTransaction(utxos, changeAddress, outputsArr, feeRate, this.network)
  return this.notarizeAndSign(res, !!fromXpubOrAddress, utxos.assets)
}

SyscoinJSLib.prototype.getNotarizationSignatures = async function (assets, res) {
  const sigs = new Map()
  let txHex = null
  for (const [assetGuid, valueAssetObj] of assets.entries()) {
    if (valueAssetObj.notarydetails && valueAssetObj.notarydetails.endpoint && valueAssetObj.notarydetails.endpoint.length > 0) {
      if (!txHex) {
        const psbt = this.createPSBTFromRes(res)
        txHex = psbt.extractTransaction().toHex()
      }
      const decodedEndpoint = utils.decodeFromBase64(valueAssetObj.notarydetails.endpoint.toString())
      const responseNotary = await this.fetchNotarizationFromEndPoint(decodedEndpoint, txHex)
      if (responseNotary.sig) {
        sigs.set(assetGuid, responseNotary.sig)
      }
    }
  }
  return sigs
}

SyscoinJSLib.prototype.createAndSignPSBTFromRes = function (res, sign, ownedIndexes) {
  const psbt = this.createPSBTFromRes(res)

  if (sign) {
    if (!this.HDSigner) {
      console.log('No HD Signer defined! Cannot sign transaction!')
      return null
    }
    const rootNode = this.HDSigner.getRootNode()
    // sign inputs this xpub key owns
    for (var i = 0; i < res.inputs.length; i++) {
      if (ownedIndexes.has(i)) {
        psbt.signInputHD(i, rootNode)
      }
    }
    if (psbt.validateSignaturesOfAllInputs()) {
      psbt.finalizeAllInputs()
    }
  }
  return psbt
}

SyscoinJSLib.prototype.notarizeAndSign = async function (res, sign, assets) {
  const ownedIndexes = new Map()
  // if from address is passed in, we don't sign and pass back unsigned transaction
  if (sign) {
    if (!this.HDSigner) {
      console.log('No HD Signer defined! Cannot derive keys to sign transaction!')
      return null
    }
    for (var i = 0; i < res.inputs.length; i++) {
      const input = res.input[i]
      if (input.path) {
        const pubkey = this.HDSigner.derivePubKey(input.path)
        if (pubkey) {
          ownedIndexes.set(i, true)
          input.bip32Derivation = [
            {
              masterFingerprint: this.HDSigner.masterFingerprint,
              path: input.path,
              pubkey: pubkey
            }]
        }
      }
    }
  }
  let psbt = this.createAndSignPSBTFromRes(res, sign, ownedIndexes)
  const notarizationSignatures = await this.getNotarizationSignatures(assets, res)
  // sign again if notarization was added
  if (syscointx.addNotarizationSignatures(res.txVersion, notarizationSignatures, res.outputs) !== -1) {
    psbt = this.createAndSignPSBTFromRes(res, sign, ownedIndexes)
  }
  return psbt
}

SyscoinJSLib.prototype.createPSBTFromRes = function (res) {
  const psbt = new bitcoin.Psbt()
  psbt.setVersion(res.txVersion)
  res.inputs.forEach(input => {
    psbt.addInput({
      hash: input.txId,
      index: input.vout,
      witnessUtxo: input.witnessUtxo,
      bip32Derivation: input.bip32Derivation
    })
  })
  res.outputs.forEach(output => {
    psbt.addOutput({
      script: output.script,
      address: output.script ? null : output.address,
      value: output.value.toNumber()
    })
  })
  return psbt
}

SyscoinJSLib.prototype.assetNew = async function (assetOpts, sysChangeAddress, feeRate, sysFromXpubOrAddress, utxos) {
  if (!utxos) {
    if (sysFromXpubOrAddress) {
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, sysFromXpubOrAddress)
    } else if(this.HDSigner){
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, this.HDSigner.getAccountXpub(this.accountIndex))
    }
  }
  const res = syscointx.assetNew(assetOpts, utxos, sysChangeAddress, feeRate, this.network)
  const pbst = await this.notarizeAndSign(res, !!sysFromXpubOrAddress, utxos.assets)
  return pbst
}

SyscoinJSLib.prototype.assetUpdate = async function (assetGuid, assetOpts, assetMap, sysChangeAddress, feeRate, sysFromXpubOrAddress, utxos) {
  if (!utxos) {
    if (sysFromXpubOrAddress) {
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, sysFromXpubOrAddress)
    } else if(this.HDSigner){
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, this.HDSigner.getAccountXpub(this.accountIndex))
    }
  }

  const res = syscointx.assetUpdate(assetGuid, assetOpts, utxos, assetMap, sysChangeAddress, feeRate, this.network)
  const pbst = this.notarizeAndSign(res, !!sysFromXpubOrAddress, utxos.assets)
  return pbst
}

SyscoinJSLib.prototype.assetSend = async function (assetMap, sysChangeAddress, feeRate, sysFromXpubOrAddress, utxos) {
  if (!utxos) {
    if (sysFromXpubOrAddress) {
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, sysFromXpubOrAddress)
    } else if(this.HDSigner){
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, this.HDSigner.getAccountXpub(this.accountIndex))
    }
  }
  const res = syscointx.assetSend(utxos, assetMap, sysChangeAddress, feeRate, sysChangeAddress, feeRate, this.network)
  const pbst = this.notarizeAndSign(res, !!sysFromXpubOrAddress, utxos.assets)
  return pbst
}

SyscoinJSLib.prototype.assetAllocationSend = async function (assetMap, sysChangeAddress, feeRate, sysFromXpubOrAddress, utxos) {
  if (!utxos) {
    if (sysFromXpubOrAddress) {
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, sysFromXpubOrAddress)
    } else if(this.HDSigner){
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, this.HDSigner.getAccountXpub(this.accountIndex))
    }
  }
  const res = syscointx.assetSend(utxos, assetMap, sysChangeAddress, feeRate, this.network)
  const pbst = this.notarizeAndSign(res, !!sysFromXpubOrAddress, utxos.assets)
  return pbst
}

SyscoinJSLib.prototype.assetAllocationBurn = async function (assetOpts, assetMap, sysChangeAddress, feeRate, sysFromXpubOrAddress, utxos) {
  if (!utxos) {
    if (sysFromXpubOrAddress) {
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, sysFromXpubOrAddress)
    } else if(this.HDSigner){
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, this.HDSigner.getAccountXpub(this.accountIndex))
    }
  }
  const res = syscointx.assetAllocationBurn(assetOpts, utxos, assetMap, sysChangeAddress, feeRate, this.network)
  const pbst = this.notarizeAndSign(res, !!sysFromXpubOrAddress, utxos.assets)
  return pbst
}

SyscoinJSLib.prototype.assetAllocationMint = async function (assetOpts, assetMap, sysChangeAddress, feeRate, sysFromXpubOrAddress, utxos) {
  if (!utxos) {
    if (sysFromXpubOrAddress) {
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, sysFromXpubOrAddress)
    } else if(this.HDSigner){
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, this.HDSigner.getAccountXpub(this.accountIndex))
    }
  }
  const res = syscointx.assetAllocationMint(assetOpts, utxos, assetMap, sysChangeAddress, feeRate, this.network)
  const pbst = this.notarizeAndSign(res, !!sysFromXpubOrAddress, utxos.assets)
  return pbst
}

SyscoinJSLib.prototype.syscoinBurnToAssetAllocation = async function (assetMap, sysChangeAddress, dataAmount, feeRate, sysFromXpubOrAddress, utxos) {
  if (!utxos) {
    if (sysFromXpubOrAddress) {
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, sysFromXpubOrAddress)
    } else if(this.HDSigner){
      utxos = await utils.fetchBackendUTXOS(this.blockbookURL, this.HDSigner.getAccountXpub(this.accountIndex))
    }
  }
  const res = syscointx.syscoinBurnToAssetAllocation(utxos, assetMap, sysChangeAddress, dataAmount, feeRate, this.network)
  const pbst = this.notarizeAndSign(res, !!sysFromXpubOrAddress, utxos.assets)
  return pbst
}

module.exports = {
  SyscoinJSLib: SyscoinJSLib,
  utils: utils
}
