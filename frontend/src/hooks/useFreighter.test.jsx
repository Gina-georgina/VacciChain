import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './useFreighter';

// Mock Freighter API
jest.mock('@stellar/freighter-api', () => ({
  isConnected: jest.fn(),
  getPublicKey: jest.fn(),
  getNetwork: jest.fn(),
  signTransaction: jest.fn(),
}));

// Mock useToast
jest.mock('./useToast', () => ({
  useToast: () => jest.fn(),
}));

// Mock the announcer so we can assert on live-region announcements
jest.mock('./useAnnouncer', () => ({
  useAnnouncer: () => jest.fn(),
}));

import { isConnected, getPublicKey, getNetwork, signTransaction } from '@stellar/freighter-api';
import { useAnnouncer } from './useAnnouncer';

const WALLET = 'GA3AUY2XRF6S7R73ABSLJMKG4R2NQGRUFPEJUGCANMBAAXI4MTBS6AQU';
const TOKEN = 'jwt-token-abc';
const CONFIGURED_NETWORK = 'TESTNET';

const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>;

// Stub fetch globally
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();

  isConnected.mockResolvedValue(true);
  getPublicKey.mockResolvedValue(WALLET);
  getNetwork.mockResolvedValue(CONFIGURED_NETWORK);
  signTransaction.mockResolvedValue('signed-xdr');

  global.fetch = jest.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transaction: 'challenge-xdr', nonce: 'nonce-1' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: TOKEN, role: 'patient' }),
    });
});

describe('useFreighter / useAuth', () => {
  it('connect() calls POST /auth/sep10 then POST /auth/verify', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, '/v1/auth/sep10', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenNthCalledWith(2, '/v1/auth/verify', expect.objectContaining({ method: 'POST' }));
  });

  it('successful connect sets isConnected: true and publicKey', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.publicKey).toBe(WALLET);
  });

  it('Freighter signing failure sets error state', async () => {
    signTransaction.mockRejectedValue(new Error('User rejected'));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.connect().catch(() => {});
    });

    expect(result.current.error).toBe('User rejected');
    expect(result.current.isConnected).toBe(false);
  });

  it('backend 401 on verify sets error state', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ transaction: 'challenge-xdr', nonce: 'nonce-1' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Invalid signature' }),
      });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.connect().catch(() => {});
    });

    expect(result.current.error).toBe('Invalid signature');
    expect(result.current.isConnected).toBe(false);
  });

  it('disconnect() clears JWT and resets state', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });
    expect(result.current.isConnected).toBe(true);

    act(() => { result.current.disconnect(); });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
    expect(localStorage.getItem('vaccichain_wallet')).toBeNull();
  });

  it('exposes the configured network and the wallet network', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });

    expect(getNetwork).toHaveBeenCalled();
    expect(result.current.configuredNetwork).toBe(CONFIGURED_NETWORK);
    expect(result.current.walletNetwork).toBe(CONFIGURED_NETWORK);
  });

  it('isNetworkMismatch is false when wallet network matches configured network', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });

    expect(result.current.isNetworkMismatch).toBe(false);
  });

  it('isNetworkMismatch is true when wallet network differs from configured network', async () => {
    getNetwork.mockResolvedValue('PUBLIC');

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });

    expect(result.current.configuredNetwork).toBe(CONFIGURED_NETWORK);
    expect(result.current.walletNetwork).toBe('PUBLIC');
    expect(result.current.isNetworkMismatch).toBe(true);
  });

  it('blocks transaction signing when there is a network mismatch', async () => {
    getNetwork.mockResolvedValue('PUBLIC');

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });
    expect(result.current.isNetworkMismatch).toBe(true);

    let thrown;
    await act(async () => {
      try {
        await result.current.signTransaction('unsigned-xdr');
      } catch (err) {
        thrown = err;
      }
    });

    expect(signTransaction).not.toHaveBeenCalled();
    expect(thrown).toBeDefined();
    expect(result.current.error).toMatch(/network/i);
  });

  it('allows transaction signing when networks match', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });

    let signed;
    await act(async () => {
      signed = await result.current.signTransaction('unsigned-xdr');
    });

    expect(signTransaction).toHaveBeenCalledWith('unsigned-xdr', expect.anything());
    expect(signed).toBe('signed-xdr');
  });

  it('announces wallet connection success via the live region', async () => {
    const announce = jest.fn();
    useAnnouncer.mockReturnValue(announce);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });

    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/connected/i));
  });

  it('announces wallet connection errors via the live region', async () => {
    const announce = jest.fn();
    useAnnouncer.mockReturnValue(announce);

    signTransaction.mockRejectedValue(new Error('User rejected'));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.connect().catch(() => {});
    });

    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/user rejected/i));
  });

  it('announces wallet disconnection via the live region', async () => {
    const announce = jest.fn();
    useAnnouncer.mockReturnValue(announce);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });
    announce.mockClear();

    act(() => { result.current.disconnect(); });

    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/disconnected/i));
  });

  it('does not duplicate identical announcements', async () => {
    const announce = jest.fn();
    useAnnouncer.mockReturnValue(announce);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => { await result.current.connect(); });
    const firstCallCount = announce.mock.calls.length;

    // Re-render without a state change should not re-announce.
    act(() => { result.current.disconnect(); });
    act(() => { result.current.disconnect(); });

    const disconnectCalls = announce.mock.calls
      .slice(firstCallCount)
      .filter(([msg]) => /disconnected/i.test(msg));

    expect(disconnectCalls).toHaveLength(1);
  });
});
