// All tabs share one service-worker writer; per-tab read/modify/write loses siblings.
export function createMeasuredWriter(storage) {
  let tail = Promise.resolve();
  return function remember({ conversationId, userMessageId, measuredMs, startedAtMs, endedAtMs }) {
    const task = tail.catch(() => {}).then(async () => {
      if (!/^[0-9a-f-]{36}$/i.test(conversationId || '') || !userMessageId
        || ![measuredMs, startedAtMs, endedAtMs].every(Number.isFinite) || measuredMs <= 0) {
        throw new Error('invalid_measured_duration');
      }
      const { turnDurations = {} } = await storage.get({ turnDurations: {} });
      const key = `${conversationId}:${userMessageId}`;
      turnDurations[key] = { ms: Math.round(measuredMs),
        startedAtMs: Math.round(startedAtMs), endedAtMs: Math.round(endedAtMs) };
      const keys = Object.keys(turnDurations);
      for (const old of keys.slice(0, Math.max(0, keys.length - 500))) delete turnDurations[old];
      await storage.set({ turnDurations });
      return { ok: true };
    });
    tail = task;
    return task;
  };
}
