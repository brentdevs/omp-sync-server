/** Require a clean server EOF within one fixed deadline, draining queued events. */
export async function waitForServerEOF(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 5000): Promise<true> {
  let timer: Timer | undefined;
  const closed = (async () => {
    while (true) {
      if ((await reader.read()).done) return true as const;
    }
  })();
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Server did not close the stream before the revocation deadline")), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
