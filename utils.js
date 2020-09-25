
const axios = require('axios')
const BN = require('bn.js')
const BIP84 = require('bip84')
const CryptoJS = require('crypto-js')
const bjs = require('bitcoinjs-lib')
const varuint = require('varuint-bitcoin')
const { GetProof } = require('eth-proof')
const { Log, Receipt, Transaction } = require('eth-object')
const rlp = require('rlp')
const Web3 = require('web3')
const web3 = new Web3()
const bitcoinNetworks = { mainnet: bjs.networks.bitcoin, testnet: bjs.networks.testnet }
/* global localStorage */
const syscoinNetworks = {
  mainnet: {
    messagePrefix: '\x18Syscoin Signed Message:\n',
    bech32: 'sys',
    bip32: {
      public: 0x0488b21e,
      private: 0x0488ade4
    },
    pubKeyHash: 0x3f,
    scriptHash: 0x05,
    wif: 0x80
  },
  testnet: {
    messagePrefix: '\x18Syscoin Signed Message:\n',
    bech32: 'tsys',
    bip32: {
      public: 0x043587cf,
      private: 0x04358394
    },
    pubKeyHash: 0x41,
    scriptHash: 0xc4,
    wif: 0xef
  }
}
const bitcoinZPubTypes = { mainnet: { zprv: '04b2430c', zpub: '04b24746' }, testnet: { vprv: '045f18bc', vpub: '045f1cf6' } }
const bitcoinXPubTypes = { mainnet: { zprv: bitcoinNetworks.mainnet.bip32.private, zpub: bitcoinNetworks.mainnet.bip32.public }, testnet: { vprv: bitcoinNetworks.testnet.bip32.private, vpub: bitcoinNetworks.testnet.bip32.public } }
const syscoinZPubTypes = { mainnet: { zprv: '04b2430c', zpub: '04b24746' }, testnet: { vprv: '045f18bc', vpub: '045f1cf6' } }
const syscoinXPubTypes = { mainnet: { zprv: syscoinNetworks.mainnet.bip32.private, zpub: syscoinNetworks.mainnet.bip32.public }, testnet: { vprv: syscoinNetworks.testnet.bip32.private, vpub: syscoinNetworks.testnet.bip32.public } }
const syscoinSLIP44 = 57
const bitcoinSLIP44 = 0

async function fetchNotarizationFromEndPoint (endPoint, txHex) {
  try {
    const request = await axios.post(endPoint, { tx: txHex })
    if (request && request.data) {
      return request.data
    }
    return null
  } catch (e) {
    console.error(e)
    throw e
  }
}

async function fetchBackendAsset (backendURL, assetGuid) {
  try {
    const request = await axios.get(backendURL + '/api/v2/asset/' + assetGuid + '?details=basic')
    if (request && request.data && request.data.asset) {
      return request.data.asset
    }
    return null
  } catch (e) {
    console.error(e)
    return e
  }
}

async function fetchBackendUTXOS (backendURL, addressOrXpub, options) {
  try {
    var url = backendURL + '/api/v2/utxo/' + addressOrXpub
    if (options) {
      url += '?' + options
    }
    const request = await axios.get(url)
    if (request && request.data) {
      return request.data
    }
    return null
  } catch (e) {
    console.error(e)
    return e
  }
}

async function fetchBackendTxs (backendURL, addressOrXpub, options, xpub, myHDSignerObj) {
  try {
    var url = backendURL
    if (xpub) {
      url += '/api/v2/xpub/'
    } else {
      url += '/api/v2/address/'
    }
    url += addressOrXpub
    if (options) {
      url += '?' + options
    }
    const request = await axios.get(url)
    if (request && request.data) {
      // if fetching xpub data
      if (xpub && request.data.tokens && myHDSignerObj) {
        myHDSignerObj.setLatestIndexesFromXPubTokens(request.data.tokens)
      }
      return request.data
    }
    return null
  } catch (e) {
    console.error(e)
    return e
  }
}

async function sendRawTransaction (backendURL, txHex, myHDSignerObj) {
  try {
    const request = await axios.post(backendURL + '/api/v2/sendtx/', txHex)
    if (request && request.data) {
      if (myHDSignerObj) {
        await fetchBackendTxs(backendURL, myHDSignerObj.getAccountXpub(), 'tokens=used&details=tokens', true, myHDSignerObj)
      }
      return request.data
    }
    return null
  } catch (e) {
    console.error(e)
    return e
  }
}

async function fetchBackendRawTx (backendURL, txid) {
  try {
    const request = await axios.get(backendURL + '/api/v2/tx/' + txid)
    if (request && request.data && request.data) {
      return request.data
    }
    return null
  } catch (e) {
    console.error(e)
    return e
  }
}

async function buildEthProof (assetOpts) {
  const ethProof = new GetProof(assetOpts.infuraurl)
  try {
    let result = await ethProof.transactionProof(assetOpts.ethtxid)
    const txvalue = rlp.encode(rlp.decode(result.txProof[2][1])).toString('hex')
    const txObj = Transaction.fromHex(result.txProof[2][1]).toObject()
    txObj.data = txObj.data.substring(10)
    const paramTxResults = web3.eth.abi.decodeParameters([{
      type: 'uint',
      name: 'value'
    }, {
      type: 'uint32',
      name: 'assetGUID'
    }, {
      type: 'string',
      name: 'syscoinAddress'
    }], txObj.data)
    const assetguid = paramTxResults.assetGUID
    const destinationaddress = paramTxResults.syscoinAddress
    const txroot = rlp.encode(result.header[4]).toString('hex')
    const txparentnodes = rlp.encode(result.txProof).toString('hex')
    const txpath = rlp.encode(result.txIndex).toString('hex')
    const blocknumber = parseInt(result.header[8].toString('hex'), 16)

    result = await ethProof.receiptProof(assetOpts.ethtxid)
    const receiptvalue = rlp.encode(rlp.decode(result.receiptProof[2][1])).toString('hex')
    const receiptroot = rlp.encode(result.header[5]).toString('hex')
    const receiptparentnodes = rlp.encode(result.receiptProof).toString('hex')
    const tokenFreezeFunction = ('9c6dea23fe3b510bb5d170df49dc74e387692eaa3258c691918cd3aa94f5fb74').toLowerCase() // token freeze function signature
    const testnet = assetOpts.infuraurl.indexOf('mainnet') === -1
    const ERC20Manager = (testnet ? '0x0765efb302d504751c652c5b1d65e8e9edf2e70f' : '0xFF957eA28b537b34E0c6E6B50c6c938668DD28a0').toLowerCase()
    let bridgetransferid = 0
    const txReceipt = Receipt.fromHex(result.receiptProof[2][1]).toObject()
    let amount = 0
    for (var i = 0; i < txReceipt.setOfLogs.length; i++) {
      const log = Log.fromRaw(txReceipt.setOfLogs[i]).toObject()
      if (log.topics && log.topics.length !== 1) {
        continue
      }

      // event TokenFreeze(address freezer, uint value, uint transferIdAndPrecisions);
      if (log.topics[0].toString('hex').toLowerCase() === tokenFreezeFunction && log.address.toLowerCase() === ERC20Manager) {
        const paramResults = web3.eth.abi.decodeParameters([{
          type: 'address',
          name: 'freezer'
        }, {
          type: 'uint',
          name: 'value'
        }, {
          type: 'uint',
          name: 'transferIdAndPrecisions'
        }], log.data)
        const transferIdAndPrecisions = new web3.utils.BN(paramResults.transferIdAndPrecisions)
        bridgetransferid = transferIdAndPrecisions.maskn(32).toNumber()
        const value = new web3.utils.BN(paramResults.value)

        // get precision
        const erc20precision = transferIdAndPrecisions.shrn(32).maskn(8)
        const sptprecision = transferIdAndPrecisions.shrn(40)
        // local precision can range between 0 and 8 decimal places, so it should fit within a CAmount
        // we pad zero's if erc20's precision is less than ours so we can accurately get the whole value of the amount transferred
        if (sptprecision > erc20precision) {
          amount = value.mul(new web3.utils.BN(10).pow(sptprecision.sub(erc20precision))).toNumber()
          // ensure we truncate decimals to fit within int64 if erc20's precision is more than our asset precision
        } else if (sptprecision < erc20precision) {
          amount = value.div(new web3.utils.BN(10).pow(erc20precision.sub(sptprecision))).toNumber()
        } else {
          amount = value.toNumber()
        }
        break
      }
    }
    return { assetguid, destinationaddress, amount, txvalue, txroot, txparentnodes, txpath, blocknumber, receiptvalue, receiptroot, receiptparentnodes, bridgetransferid }
  } catch (e) {
    console.log('error getting Eth Proof: ', e)
    return e
  }
}

function sanitizeBlockbookUTXOs (utxoObj, network, txOpts, assetMap) {
  if (!txOpts) {
    txOpts = { rbf: false }
  }
  const sanitizedUtxos = { utxos: [] }
  if (utxoObj.assets) {
    sanitizedUtxos.assets = new Map()
    utxoObj.assets.forEach(asset => {
      const assetObj = {}
      if (asset.contract) {
        asset.contract = asset.contract.replace(/^0x/, '')
        assetObj.contract = Buffer.from(asset.contract, 'hex')
      }
      if (asset.pubData) {
        assetObj.pubdata = Buffer.from(JSON.stringify(asset.pubData))
      }
      if (asset.notaryKeyID) {
        assetObj.notarykeyid = Buffer.from(asset.notaryKeyID, 'hex')
        network = network || syscoinNetworks.mainnet
        assetObj.notaryaddress = bjs.payments.p2wpkh({ hash: assetObj.notarykeyid, network: network }).address
        // in unit tests notarySig may be provided
        if (asset.notarySig) {
          assetObj.notarysig = Buffer.from(asset.notarySig, 'hex')
        } else {
          // prefill in this likely case where notarySig isn't provided
          assetObj.notarysig = Buffer.alloc(65, 0)
        }
      }
      if (asset.notaryDetails) {
        assetObj.notarydetails = {}
        if (asset.notaryDetails.endPoint) {
          assetObj.notarydetails.endpoint = Buffer.from(asset.notaryDetails.endPoint, 'base64')
        } else {
          assetObj.notarydetails.endpoint = Buffer.from('')
        }
        assetObj.notarydetails.instanttransfers = asset.notaryDetails.instantTransfers
        assetObj.notarydetails.hdrequired = asset.notaryDetails.HDRequired
      }
      if (asset.auxFeeDetails) {
        assetObj.auxfeedetails = {}
        if (asset.auxFeeDetails.auxFeeKeyID) {
          assetObj.auxfeedetails.auxfeekeyid = Buffer.from(asset.auxFeeDetails.auxFeeKeyID, 'hex')
          assetObj.auxfeedetails.auxfeeaddress = bjs.payments.p2wpkh({ hash: assetObj.auxfeedetails.auxfeekeyid, network: syscoinNetworks.testnet }).address
        } else {
          assetObj.auxfeedetails.auxfeekeyid = Buffer.from('')
        }
        assetObj.auxfeedetails.auxfees = asset.auxFeeDetails.auxFees
      }
      if (asset.updateCapabilityFlags) {
        assetObj.updatecapabilityflags = asset.updateCapabilityFlags
      }

      assetObj.maxsupply = new BN(asset.maxSupply)
      assetObj.precision = asset.decimals
      sanitizedUtxos.assets.set(asset.assetGuid, assetObj)
    })
  }
  if (utxoObj.utxos) {
    utxoObj.utxos.forEach(utxo => {
      if (!utxo.address) {
        console.log('SKIPPING utxo: no address field defined')
        return
      }
      const newUtxo = { type: 'LEGACY', address: utxo.address, txId: utxo.txid, path: utxo.path, vout: utxo.vout, value: new BN(utxo.value), locktime: utxo.locktime }
      if (newUtxo.address.startsWith(network.bech32)) {
        newUtxo.type = 'BECH32'
      }
      if (utxo.assetInfo) {
        newUtxo.assetInfo = { assetGuid: utxo.assetInfo.assetGuid, value: new BN(utxo.assetInfo.value) }
        const assetObj = sanitizedUtxos.assets.get(utxo.assetInfo.assetGuid)
        // sanity check to ensure sanitizedUtxos.assets has all of the assets being added to UTXO that are assets
        if (!assetObj) {
          return
        }
        // allowOtherNotarizedAssetInputs option if set will skip this check, by default this check is done and inputs will be skipped if they are notary asset inputs and user is not sending those assets (used as gas to fulfill requested output amount of SYS)
        if (!txOpts.allowOtherNotarizedAssetInputs) {
          // if notarization is required but it isn't a requested asset to send we skip this UTXO as would be dependent on a foreign asset notary
          if (assetObj.notarykeyid && assetObj.notarykeyid.length > 0) {
            if (!assetMap || !assetMap.has(utxo.assetInfo.assetGuid)) {
              console.log('SKIPPING notary utxo')
              return
            }
          }
        }
      }
      sanitizedUtxos.utxos.push(newUtxo)
    })
  }

  return sanitizedUtxos
}

function HDSigner (mnemonic, password, isTestnet, networks, SLIP44, pubTypes) {
  this.isTestnet = isTestnet || false
  SLIP44 = this.isTestnet ? 1 : SLIP44 || syscoinSLIP44 // 1 is testnet for all coins,
  this.networks = networks || syscoinNetworks

  if (!this.isTestnet) {
    this.network = this.networks.mainnet || syscoinNetworks.mainnet
  } else {
    this.network = this.networks.testnet || syscoinNetworks.testnet
  }

  this.password = password
  this.pubTypes = pubTypes || syscoinZPubTypes

  this.accounts = []
  this.changeIndex = -1
  this.receivingIndex = -1
  this.mnemonic = mnemonic // serialized
  this.accountIndex = -1 // serialized

  /* eslint new-cap: ["error", { "newIsCap": false }] */
  this.fromSeed = new BIP84.fromSeed(mnemonic, this.isTestnet, SLIP44, this.pubTypes, this.network)
  // try to restore, if it does not succeed then initialize from scratch
  if (!this.password || !this.restore(this.password)) {
    this.createAccount()
  }
}
HDSigner.prototype.getMasterFingerprint = function () {
  return bjs.bip32.fromSeed(this.fromSeed.seed, this.network).fingerprint
}

HDSigner.prototype.deriveAccount = function (index) {
  let bipNum = '44'
  if (this.pubTypes === syscoinZPubTypes ||
    this.pubTypes === bitcoinZPubTypes) {
    bipNum = '84'
  }
  return this.fromSeed.deriveAccount(index, bipNum)
}

HDSigner.prototype.setAccountIndex = function (accountIndex) {
  this.accountIndex = accountIndex
  this.changeIndex = -1
  this.receivingIndex = -1
}

// restore on load from local storage and decrypt data to de-serialize objects
HDSigner.prototype.restore = function (password) {
  const browserStorage = (typeof localStorage === 'undefined') ? null : localStorage
  if (!browserStorage) { return }
  const key = this.network.bech32 + '_hdsigner'
  const ciphertext = browserStorage.getItem(key)
  if (ciphertext === null) {
    return false
  }
  const bytes = CryptoJS.AES.decrypt(ciphertext, password)
  if (!bytes || bytes.length === 0) {
    return false
  }
  const decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8))
  this.mnemonic = decryptedData.mnemonic
  var numAccounts = decryptedData.numAccounts
  // sanity checks
  if (this.accountIndex > 1000) {
    return false
  }
  for (var i = 0; i <= numAccounts; i++) {
    const child = this.deriveAccount(i)
    /* eslint new-cap: ["error", { "newIsCap": false }] */
    this.accounts.push(new BIP84.fromZPrv(child, this.pubTypes, this.networks))
  }
  return true
}
// encrypt to password and backup to local storage for persistence
HDSigner.prototype.backup = function () {
  const browserStorage = (typeof localStorage === 'undefined') ? null : localStorage
  if (!browserStorage || !this.password) { return }
  const key = this.network.bech32 + '_hdsigner'
  const obj = { mnemonic: this.mnemonic, numAccounts: this.accounts.length }
  const ciphertext = CryptoJS.AES.encrypt(JSON.stringify(obj), this.password).toString()
  browserStorage.setItem(key, ciphertext)
}

HDSigner.prototype.getNewChangeAddress = async function (skipIncrement) {
  if (this.changeIndex === -1 && this.blockbookURL) {
    await fetchBackendTxs(this.blockbookURL, this.getAccountXpub(), 'tokens=used&details=tokens', true, this)
  }
  const keyPair = this.createKeypair(this.changeIndex + 1, true)
  if (keyPair) {
    if (!skipIncrement) {
      this.changeIndex++
    }
    return this.getAddressFromKeypair(keyPair)
  }

  return null
}

HDSigner.prototype.getNewReceivingAddress = async function (skipIncrement) {
  if (this.receivingIndex === -1 && this.blockbookURL) {
    await fetchBackendTxs(this.blockbookURL, this.getAccountXpub(), 'tokens=used&details=tokens', true, this)
  }
  const keyPair = this.createKeypair(this.receivingIndex + 1, false)
  if (keyPair) {
    if (!skipIncrement) {
      this.receivingIndex++
    }
    return this.getAddressFromKeypair(keyPair)
  }

  return null
}

HDSigner.prototype.createAccount = function () {
  this.accountIndex++
  this.changeIndex = -1
  this.receivingIndex = -1
  const child = this.deriveAccount(this.accountIndex)
  /* eslint new-cap: ["error", { "newIsCap": false }] */
  this.accounts.push(new BIP84.fromZPrv(child, this.pubTypes, this.networks))
  this.backup()
  return this.accountIndex
}

HDSigner.prototype.getAccountXpub = function () {
  return this.accounts[this.accountIndex].getAccountPublicKey()
}

HDSigner.prototype.setLatestIndexesFromXPubTokens = function (tokens) {
  if (tokens) {
    tokens.forEach(token => {
      if (token.path) {
        const splitPath = token.path.split('/')
        if (splitPath.length >= 6) {
          var change = parseInt(splitPath[4], 10)
          var index = parseInt(splitPath[5], 10)
          if (change === 1) {
            if (index > this.changeIndex) {
              this.changeIndex = index
            }
          } else if (index > this.receivingIndex) {
            this.receivingIndex = index
          }
        }
      }
    })
  }
}

HDSigner.prototype.createKeypair = function (addressIndex, isChange) {
  return this.accounts[this.accountIndex].getKeypair(addressIndex, isChange)
}

HDSigner.prototype.getAddressFromKeypair = function (keyPair) {
  const payment = bjs.payments.p2wpkh({
    pubkey: keyPair.publicKey,
    network: this.network
  })
  return payment.address
}

HDSigner.prototype.getAddressFromPubKey = function (pubkey) {
  const payment = bjs.payments.p2wpkh({
    pubkey: pubkey,
    network: this.network
  })
  return payment.address
}

HDSigner.prototype.deriveKeypair = function (keypath) {
  const keyPair = bjs.bip32.fromSeed(this.fromSeed.seed, this.network).derivePath(keypath)
  if (!keyPair) {
    return null
  }
  return keyPair
}

HDSigner.prototype.derivePubKey = function (keypath) {
  const keyPair = bjs.bip32.fromSeed(this.fromSeed.seed, this.network).derivePath(keypath)
  if (!keyPair) {
    return null
  }
  return keyPair.publicKey
}

HDSigner.prototype.getRootNode = function () {
  return bjs.bip32.fromSeed(this.fromSeed.seed, this.network)
}

/* Override PSBT stuff so fee check isn't done as Syscoin Allocation burns outputs > inputs */

function scriptWitnessToWitnessStack (buffer) {
  let offset = 0
  function readSlice (n) {
    offset += n
    return buffer.slice(offset - n, offset)
  }
  function readVarInt () {
    const vi = varuint.decode(buffer, offset)
    offset += varuint.decode.bytes
    return vi
  }
  function readVarSlice () {
    return readSlice(readVarInt())
  }
  function readVector () {
    const count = readVarInt()
    const vector = []
    for (let i = 0; i < count; i++) vector.push(readVarSlice())
    return vector
  }
  return readVector()
}

function addNonWitnessTxCache (cache, input, inputIndex) {
  cache.__NON_WITNESS_UTXO_BUF_CACHE[inputIndex] = input.nonWitnessUtxo
  const tx = bjs.Transaction.fromBuffer(input.nonWitnessUtxo)
  cache.__NON_WITNESS_UTXO_TX_CACHE[inputIndex] = tx
  const self = cache
  const selfIndex = inputIndex
  delete input.nonWitnessUtxo
  Object.defineProperty(input, 'nonWitnessUtxo', {
    enumerable: true,
    get () {
      const buf = self.__NON_WITNESS_UTXO_BUF_CACHE[selfIndex]
      const txCache = self.__NON_WITNESS_UTXO_TX_CACHE[selfIndex]
      if (buf !== undefined) {
        return buf
      } else {
        const newBuf = txCache.toBuffer()
        self.__NON_WITNESS_UTXO_BUF_CACHE[selfIndex] = newBuf
        return newBuf
      }
    },
    set (data) {
      self.__NON_WITNESS_UTXO_BUF_CACHE[selfIndex] = data
    }
  })
}

function nonWitnessUtxoTxFromCache (cache, input, inputIndex) {
  const c = cache.__NON_WITNESS_UTXO_TX_CACHE
  if (!c[inputIndex]) {
    addNonWitnessTxCache(cache, input, inputIndex)
  }
  return c[inputIndex]
}

// override of psbt.js inputFinalizeGetAmts without fee < 0 check
function inputFinalizeGetAmts (inputs, tx, cache, mustFinalize) {
  let inputAmount = 0
  inputs.forEach((input, idx) => {
    if (mustFinalize && input.finalScriptSig) { tx.ins[idx].script = input.finalScriptSig }
    if (mustFinalize && input.finalScriptWitness) {
      tx.ins[idx].witness = scriptWitnessToWitnessStack(
        input.finalScriptWitness
      )
    }
    if (input.witnessUtxo) {
      inputAmount += input.witnessUtxo.value
    } else if (input.nonWitnessUtxo) {
      const nwTx = nonWitnessUtxoTxFromCache(cache, input, idx)
      const vout = tx.ins[idx].index
      const out = nwTx.outs[vout]
      inputAmount += out.value
    }
  })
  const outputAmount = tx.outs.reduce((total, o) => total + o.value, 0)
  const fee = inputAmount - outputAmount
  // SYSCOIN for burn allocations, this will be negative
  // if (fee < 0) {
  //  throw new Error('Outputs are spending more than Inputs');
  // }
  const bytes = tx.virtualSize()
  cache.__FEE = fee
  cache.__EXTRACTED_TX = tx
  cache.__FEE_RATE = Math.floor(fee / bytes)
}

function isFinalized (input) {
  return !!input.finalScriptSig || !!input.finalScriptWitness
}

function checkFees (psbt, cache, opts) {
  const feeRate = cache.__FEE_RATE || psbt.getFeeRate()
  const vsize = cache.__EXTRACTED_TX.virtualSize()
  const satoshis = feeRate * vsize
  if (feeRate >= opts.maximumFeeRate) {
    throw new Error(
      `Warning: You are paying around ${(satoshis / 1e8).toFixed(8)} in ` +
        `fees, which is ${feeRate} satoshi per byte for a transaction ` +
        `with a VSize of ${vsize} bytes (segwit counted as 0.25 byte per ` +
        'byte). Use setMaximumFeeRate method to raise your threshold, or ' +
        'pass true to the first arg of extractTransaction.'
    )
  }
}

function getTxCacheValue (key, name, inputs, c) {
  if (!inputs.every(isFinalized)) { throw new Error(`PSBT must be finalized to calculate ${name}`) }
  if (key === '__FEE_RATE' && c.__FEE_RATE) return c.__FEE_RATE
  if (key === '__FEE' && c.__FEE) return c.__FEE
  let tx
  let mustFinalize = true
  if (c.__EXTRACTED_TX) {
    tx = c.__EXTRACTED_TX
    mustFinalize = false
  } else {
    tx = c.__TX.clone()
  }
  inputFinalizeGetAmts(inputs, tx, c, mustFinalize)
  if (key === '__FEE_RATE') return c.__FEE_RATE
  else if (key === '__FEE') return c.__FEE
}

class SPSBT extends bjs.Psbt {
  getFeeRate () {
    return getTxCacheValue(
      '__FEE_RATE',
      'fee rate',
      this.data.inputs,
      this.__CACHE
    )
  }

  getFee () {
    return getTxCacheValue('__FEE', 'fee', this.data.inputs, this.__CACHE)
  }

  extractTransaction (disableFeeCheck) {
    if (!this.data.inputs.every(isFinalized)) throw new Error('Not finalized')
    const c = this.__CACHE
    if (!disableFeeCheck) {
      checkFees(this, c, this.opts)
    }
    if (c.__EXTRACTED_TX) return c.__EXTRACTED_TX
    const tx = c.__TX.clone()
    inputFinalizeGetAmts(this.data.inputs, tx, c, true)
    return tx
  }
}
bjs.Psbt = SPSBT
module.exports = {
  bitcoinXPubTypes: bitcoinXPubTypes,
  bitcoinZPubTypes: bitcoinZPubTypes,
  bitcoinNetworks: bitcoinNetworks,
  syscoinXPubTypes: syscoinXPubTypes,
  syscoinZPubTypes: syscoinZPubTypes,
  syscoinNetworks: syscoinNetworks,
  syscoinSLIP44: syscoinSLIP44,
  bitcoinSLIP44: bitcoinSLIP44,
  HDSigner: HDSigner,
  fetchBackendUTXOS: fetchBackendUTXOS,
  sanitizeBlockbookUTXOs: sanitizeBlockbookUTXOs,
  fetchBackendTxs: fetchBackendTxs,
  fetchBackendAsset: fetchBackendAsset,
  fetchBackendRawTx: fetchBackendRawTx,
  fetchNotarizationFromEndPoint: fetchNotarizationFromEndPoint,
  sendRawTransaction: sendRawTransaction,
  buildEthProof: buildEthProof,
  bitcoinjs: bjs
}
