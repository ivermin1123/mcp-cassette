/**
 * Incremental Server-Sent Events parser.
 *
 * The rules are WHATWG HTML's "interpreting an event stream" and nothing else:
 * lines end with CRLF, LF, or a bare CR; a line starting with a colon is a
 * comment; a line without a colon is a field with an empty value; one leading
 * space after the colon is stripped; `data` accumulates with a LF per line and
 * loses its last LF at dispatch; an empty data buffer dispatches nothing; an
 * `id` containing NUL is ignored; `retry` must be ASCII digits.
 *
 * "Incremental" is the whole point here: the proxy sees whatever TCP hands it,
 * so an event may arrive in any number of pieces and a CR may be separated
 * from its LF by a chunk boundary. Feed bytes as they come; complete events
 * come back. A trailing block with no blank line after it is not an event yet
 * and is deliberately not reported — that is the spec's own rule, and it is
 * also what makes a stream cut short at shutdown record only what it showed.
 */

/** One dispatched event. Fields the cassette never stores are still parsed — see `chunks` in the design (§1.3). */
export interface SseEvent {
  /** The `event:` field, or "message" when the stream named none. */
  type: string;
  /** `data:` lines joined with LF, trailing LF removed. */
  data: string;
  /** The stream's last event id at dispatch time ("" until an `id:` sets one). */
  lastEventId: string;
}

export class SseParser {
  /** Bytes seen but not yet terminated by a line ending. */
  private buffer = "";
  private data = "";
  private eventType = "";
  private lastEventId = "";
  /** Reconnection time from `retry:`, in ms. Parsed to be handled, never recorded. */
  retry: number | undefined;

  /** Feed decoded text; returns every event completed by it, in order. */
  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      // A CR at the very end may still be the first half of a CRLF: hold the
      // line until the next chunk says which, or the stream ends unterminated.
      if (c === "\r" && i === this.buffer.length - 1) break;
      const event = this.line(this.buffer.slice(start, i));
      if (c === "\r" && this.buffer[i + 1] === "\n") i++;
      start = i + 1;
      if (event) events.push(event);
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  /**
   * No more bytes are coming. A CR held back for a possible LF can only have
   * been a line ending after all, so the line it ended is processed now — which
   * may dispatch the stream's last event. A block that never got its blank line
   * is still not an event, per spec, and is dropped.
   */
  end(): SseEvent[] {
    if (!this.buffer.endsWith("\r")) return [];
    const event = this.line(this.buffer.slice(0, -1));
    this.buffer = "";
    return event ? [event] : [];
  }

  /** One complete line. Returns an event when the line was the blank one that dispatches. */
  private line(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // a comment: the spec defines it as data-free
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") this.eventType = value;
    else if (field === "data") this.data += value + "\n";
    else if (field === "id") {
      if (!value.includes("\0")) this.lastEventId = value;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) this.retry = Number(value);
    }
    return null; // any other field name is ignored, per spec
  }

  private dispatch(): SseEvent | null {
    const type = this.eventType || "message";
    this.eventType = "";
    if (this.data === "") return null; // "data: " never appeared: nothing to dispatch
    const data = this.data.endsWith("\n") ? this.data.slice(0, -1) : this.data;
    this.data = "";
    return { type, data, lastEventId: this.lastEventId };
  }
}
