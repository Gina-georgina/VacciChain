const StellarSdk = require('@stellar/stellar-sdk');
const config = require('../config');
const logger = require('../logger');
const {
  withTimeout,
  withRetry,
  classifyError,
  getCorrelationId,
  SorobanError,
  SorobanRpcError,
  SorobanTransactionError,
  SorobanSimulationError,
  SorobanTimeoutError,
  SorobanTransientError,
  SorobanPermanentError,
} = require('./client');

const {
  SOROBAN_RPC_URL,
  STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASE,
  VACCINATIONS_CONTRACT_ID: CONTRACT_ID,
} = config;

// Fee in stroops (1 XLM = 10_000_000 stroops). Minimum is 100.
const TX_FEE = String(process.env.SOROBAN_FEE || 100);
// Inclusion tip in stroops for priority during congestion (0 = no tip).
const TX_TIP = process.env.SOROBAN_TIP ? String(process.env.SOROBAN_TIP) : undefined;

function getRpcServer() {
  return new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
}

/**
 * Execute a single-attempt RPC call (used for non-idempotent operations such as
 * transaction submission). Applies a bounded timeout but never retries, so a
 * transaction is never submitted twice.
 */
async function callOnce(fn, context) {
  return withTimeout(fn, context);
}

/**
 * Execute an idempotent read-only RPC call with bounded timeout and retries.
 * Only safe-to-retry operations should use this.
 */
async function callRead(fn, context) {
  return withRetry(fn, context, { idempotent: true });
}

/**
 * Invoke a Soroban contract function.
 * @param {string} secretKey - Caller's secret key
 * @param {string} method - Contract method name
 * @param {StellarSdk.xdr.ScVal[]} args - Method arguments
 */
async function invokeContract(secretKey, method, args) {
  const rpc = getRpcServer();
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const account = await callRead(() => rpc.getAccount(keypair.publicKey()), 'getAccount');

  const contract = new StellarSdk.Contract(CONTRACT_ID);

  const txBuilderOpts = {
    fee: TX_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  };
  if (TX_TIP) txBuilderOpts.sorobanData = undefined; // tip applied via fee bump if needed

  const tx = new StellarSdk.TransactionBuilder(account, txBuilderOpts)
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const prepared = await callRead(() => rpc.prepareTransaction(tx), 'prepareTransaction');
  prepared.sign(keypair);

  // Submission is NOT idempotent: single attempt only, bounded by timeout.
  const response = await callOnce(() => rpc.sendTransaction(prepared), 'sendTransaction');
  if (response.status === 'ERROR') {
    const errDetail = JSON.stringify(response.errorResult);
    if (errDetail.includes('txINSUFFICIENT_FEE') || errDetail.includes('fee')) {
      throw new SorobanPermanentError(
        `Transaction rejected: fee too low (current: ${TX_FEE} stroops). ` +
        `Increase SOROBAN_FEE in your environment. Details: ${errDetail}`
      );
    }
    const error = new SorobanTransactionError(`Contract invocation failed: ${errDetail}`);
    error.sorobanErrorResult = response.errorResult;
    throw error;
  }

  // Poll for result (read-only, safe to retry)
  let result;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    result = await callRead(() => rpc.getTransaction(response.hash), 'getTransaction');
    if (result.status !== 'NOT_FOUND') break;
  }

  if (result.status !== 'SUCCESS') {
    const error = new SorobanTransactionError(`Transaction failed: ${result.status}`);
    error.sorobanResultXdr = result.resultXdr;
    error.sorobanStatus = result.status;
    throw error;
  }

  return { returnValue: result.returnValue, hash: response.hash, ledger: result.ledger };
}

function toOptionalU32(value) {
  return value != null
    ? StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvU32(value)])
    : StellarSdk.xdr.ScVal.scvVoid();
}

/**
 * Mint a vaccination record and submit a signed transaction.
 * @param {string} patient - Stellar address of the patient
 * @param {string} vaccineName - Vaccine name
 * @param {string} dateAdministered - ISO-8601 timestamp
 * @param {string} issuerSecret - Issuer secret key for signing
 * @param {Object} [options]
 * @param {number|null} [options.doseNumber]
 * @param {number|null} [options.doseSeries]
 */
async function mintVaccination(patient, vaccineName, dateAdministered, issuerSecret, options = {}) {
  try {
    const issuerKeypair = StellarSdk.Keypair.fromSecret(issuerSecret);
    const args = [
      StellarSdk.Address.fromString(patient).toScVal(),
      StellarSdk.xdr.ScVal.scvString(vaccineName),
      StellarSdk.xdr.ScVal.scvString(dateAdministered),
      StellarSdk.Address.fromString(issuerKeypair.publicKey()).toScVal(),
      toOptionalU32(options.doseNumber),
      toOptionalU32(options.doseSeries),
    ];

    const result = await invokeContract(issuerSecret, 'mint_vaccination', args);
    const tokenId = StellarSdk.scValToNative(result.returnValue);
    return {
      tokenId,
      hash: result.hash,
      ledger: result.ledger,
    };
  } catch (error) {
    if (error instanceof SorobanError) throw error;
    throw new SorobanTransactionError('Failed to mint vaccination record', error);
  }
}

/**
 * Explicit verification statuses. These MUST NOT be collapsed into a boolean:
 * a missing, revoked, or unavailable record is never a positive verification.
 */
const VerificationStatus = Object.freeze({
  VALID: 'valid',
  REVOKED: 'revoked',
  ABSENT: 'absent',
  UNAVAILABLE: 'unavailable',
});

/**
 * Verify vaccination status via a read-only contract call.
 *
 * Returns an explicit status rather than a boolean so callers cannot
 * misinterpret missing/revoked/unavailable data as a positive result.
 * RPC and simulation failures are mapped to UNAVAILABLE (never VALID).
 *
 * @param {string} wallet - Stellar wallet address to verify
 * @returns {Promise<{wallet: string, status: string, vaccinated: boolean, records: Array, error?: string}>}
 */
async function verifyVaccination(wallet) {
  try {
    const args = [StellarSdk.Address.fromString(wallet).toScVal()];
    const rawResult = await simulateContract('verify_vaccination', args);

    if (rawResult == null) {
      // No return value from the contract: treat as absent, never positive.
      return {
        wallet,
        status: VerificationStatus.ABSENT,
        vaccinated: false,
        records: [],
      };
    }

    const [vaccinated, records] = StellarSdk.scValToNative(rawResult);
    const recordList = Array.isArray(records) ? records : [];

    let status;
    if (vaccinated === true && recordList.length > 0) {
      status = VerificationStatus.VALID;
    } else if (recordList.length > 0) {
      // Records exist but are not currently valid (e.g. revoked).
      status = VerificationStatus.REVOKED;
    } else {
      status = VerificationStatus.ABSENT;
    }

    return {
      wallet,
      status,
      vaccinated: status === VerificationStatus.VALID,
      records: recordList,
    };
  } catch (error) {
    // Any RPC/simulation failure means data is unavailable — never positive.
    logger.warn('Vaccination verification unavailable', {
      wallet,
      message: error.message,
    });
    return {
      wallet,
      status: VerificationStatus.UNAVAILABLE,
      vaccinated: false,
      records: [],
      error: error.message,
    };
  }
}

/**
 * Read-only contract call (no signing needed).
 */
async function simulateContract(method, args) {
  const rpc = getRpcServer();
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  // Use a dummy account for simulation
  const dummyKeypair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(dummyKeypair.publicKey(), '0');

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: TX_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await callRead(() => rpc.simulateTransaction(tx), 'simulateTransaction');
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    const error = new SorobanSimulationError(`Simulation failed: ${sim.error}`);
    error.simulationError = sim.error;
    throw error;
  }

  return sim.result?.retval;
}

/**
 * Send a 503 RPC timeout response. Use in route catch blocks when err is SorobanTimeoutError.
 */
function sendRpcTimeout(res) {
  return res.status(503).json({
    error: 'RPC timeout',
    retryAfter: 5,
    correlationId: getCorrelationId(),
  });
}

module.exports = {
  getRpcServer,
  invokeContract,
  simulateContract,
  mintVaccination,
  verifyVaccination,
  addIssuer,
  revokeIssuer,
  sendRpcTimeout,
  classifyError,
  VerificationStatus,
  SorobanError,
  SorobanRpcError,
  SorobanTransactionError,
  SorobanSimulationError,
  SorobanTimeoutError,
  SorobanTransientError,
  SorobanPermanentError,
};

/**
 * Add a new issuer to the contract allowlist (admin-signed).
 * @param {string} issuerWallet - Stellar public key to authorize as issuer
 */
async function addIssuer(issuerWallet) {
  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) throw new Error('ADMIN_SECRET_KEY not configured');
  const args = [StellarSdk.xdr.ScVal.scvAddress(
    StellarSdk.Address.fromString(issuerWallet).toScAddress()
  )];
  return invokeContract(adminSecret, 'add_issuer', args);
}

/**
 * Revoke an issuer from the contract allowlist (admin-signed).
 * @param {string} issuerWallet - Stellar public key to deauthorize
 */
async function revokeIssuer(issuerWallet) {
  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) throw new Error('ADMIN_SECRET_KEY not configured');
  const args = [StellarSdk.xdr.ScVal.scvAddress(
    StellarSdk.Address.fromString(issuerWallet).toScAddress()
  )];
  return invokeContract(adminSecret, 'revoke_issuer', args);
}
