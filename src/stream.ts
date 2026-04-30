// Generic byte stream backed by socket data callbacks.
// Each layer (usbmux, lockdown, webinspector) reads its own framing from this.

export class ByteStream {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private waiters: Array<{ n: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void }> = [];
  closed = false;
  closeErr: Error | null = null;

  push(chunk: Uint8Array) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    this.drain();
  }

  close(err?: Error) {
    this.closed = true;
    this.closeErr = err ?? null;
    for (const w of this.waiters) w.reject(err ?? new Error("stream closed"));
    this.waiters = [];
  }

  /** Read exactly n bytes. Resolves when available. */
  read(n: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      if (this.closed && this.size < n) {
        reject(this.closeErr ?? new Error("stream closed"));
        return;
      }
      this.waiters.push({ n, resolve, reject });
      this.drain();
    });
  }

  private drain() {
    while (this.waiters.length > 0 && this.waiters[0]!.n <= this.size) {
      const w = this.waiters.shift()!;
      const out = new Uint8Array(w.n);
      let written = 0;
      while (written < w.n) {
        const head = this.chunks[0]!;
        const need = w.n - written;
        if (head.length <= need) {
          out.set(head, written);
          written += head.length;
          this.chunks.shift();
        } else {
          out.set(head.subarray(0, need), written);
          this.chunks[0] = head.subarray(need);
          written += need;
        }
      }
      this.size -= w.n;
      w.resolve(out);
    }
  }
}
