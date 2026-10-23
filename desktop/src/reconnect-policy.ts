const CHANNEL_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export function channelReconnectDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return CHANNEL_RECONNECT_DELAYS_MS[attempt] ?? null;
}
