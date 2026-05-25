type RealtimePayload = Record<string, unknown>;
type RealtimeEvent = {
  event: string;
  payload: RealtimePayload;
};
type RealtimeListener = (event: RealtimeEvent) => void;

const globalRealtimeHub = globalThis as typeof globalThis & {
  __aeroRealtimeHub?: Map<string, Set<RealtimeListener>>;
};

const listenersByChannel = globalRealtimeHub.__aeroRealtimeHub ?? new Map<string, Set<RealtimeListener>>();
globalRealtimeHub.__aeroRealtimeHub = listenersByChannel;

export function subscribeRealtimeChannel(channel: string, listener: RealtimeListener) {
  const listeners = listenersByChannel.get(channel) ?? new Set<RealtimeListener>();
  listeners.add(listener);
  listenersByChannel.set(channel, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByChannel.delete(channel);
    }
  };
}

export function publishRealtimeEvent(channel: string, event: string, payload: RealtimePayload) {
  const listeners = listenersByChannel.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }

  for (const listener of listeners) {
    listener({ event, payload });
  }
}
