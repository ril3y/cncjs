// Bound unread UART input, not the firmware's fragmented line-pool storage.
// Every ordinary wire byte stays charged until its own matched reply proves the
// line left the UART. This rolling window permits refill while older lines wait.
const PAUSED_CONTROL_FIELD = '["\']?(?:mfo|mfc|mfe|sso|ssc|sse|sr|stat|qr|rx|mt|pwr|clear)["\']?\\s*:\\s*(?:null|true|false|""|-?\\d+(?:\\.\\d+)?)';
const PAUSED_CONTROL_LINE = new RegExp(`^\\{\\s*${PAUSED_CONTROL_FIELD}(?:\\s*,\\s*${PAUSED_CONTROL_FIELD})*\\s*\\}$`, 'i');

export default class TinyGTransport {
  constructor(write, fault) {
    this.write = write;
    this.fault = fault;
    this.reset();
    this.suspended = false;
  }

  reset() {
    this.suspended = true;
    this.generation = (this.generation || 0) + 1;
    const requests = [...(this.pending || []), ...(this.active || [])];
    this.pending = [];
    this.active = [];
    this.bytes = 0;
    this.slots = 0;
    this.lineMode = false;
    this.failed = false;
    this.paused = false;
    this.pauseThrough = 0;
    this.fencing = false;
    this.motionBlocked = false;
    requests.forEach((request) => request.done && request.done(null));
  }

  resume() {
    if (this.active.length || this.pending.length || this.failed) {
      return;
    }
    this.suspended = false;
  }

  enqueue(line, options = {}) {
    // Cancellation callbacks are notifications, not permission to start a new
    // transaction. Only the controller's verified resynchronization can resume.
    if (this.suspended) {
      return;
    }
    line = String(line).trim();
    const bytes = Buffer.byteLength(line + '\n');
    // Include LF on the wire and leave room for the firmware's terminating NUL.
    if (
      !line ||
      /[\r\n]/.test(line) ||
      bytes > 249 ||
      this.pending.length >= 64 ||
      this.failed
    ) {
      this.fail(
        'TinyG command rejected: invalid length, full queue, or transport requires reconnect'
      );
      if (options.done) {
        options.done(null);
      }
      return;
    }
    const key = (line.match(/^[{]\s*["']?([a-z0-9]+)["']?\s*:/i) || [])[1];
    let kind = key ? 'json' : 'gcode';
    if (options.n) {
      kind = 'program';
    }
    const request = { ...options, line, bytes, kind, key };
    if (options.priority && (!this.fencing || options.fence)) {
      this.pending.unshift(request);
    } else {
      this.pending.push(request);
    }
    this.pump();
  }

  fail(message) {
    this.failed = true;
    this.fault(message);
  }

  pump() {
    if (this.pumping || this.failed || this.suspended) {
      return;
    }
    this.pumping = true;
    try {
      while (this.pending.length) {
        const held = request => {
          if (request.fence || request.allowPaused || (!this.paused && !this.motionBlocked)) {
            return false;
          }
          if (request.n) {
            return this.motionBlocked || request.n > this.pauseThrough;
          }
          // After an ordered program stop, do not queue MDI/macro motion behind
          // M0 before its execution fence. Only non-motion controls may overtake.
          // Validate the entire group: a safe first key must not hide gc/home.
          return (this.motionBlocked || this.pauseThrough > 0) && !PAUSED_CONTROL_LINE.test(request.line);
        };
        if (held(this.pending[0])) {
          const controlIndex = this.pending.findIndex(request => !held(request));
          if (controlIndex < 0) {
            break;
          }
          this.pending.unshift(...this.pending.splice(controlIndex, 1));
        }
        const request = this.pending[0];
        if (this.fencing && !request.fence) {
          break;
        }
        const control = !request.n;
        if (this.active.length) {
          if (
            request.fence ||
            !this.lineMode ||
            this.bytes + request.bytes > (control ? 200 : 136)
          ) {
            break;
          }
          // At most one control transaction; only JSON controls may overtake data.
          if (
            control &&
            (request.line[0] !== '{' || this.active.some((r) => !r.n))
          ) {
            break;
          }
          if (this.slots - this.active.length <= (control ? 0 : 2)) {
            break;
          }
        }
        this.pending.shift();
        this.active.push(request);
        this.bytes += request.bytes;
        try {
          this.write(request.line + '\n');
        } catch (err) {
          // A failed write may have partially reached the driver. Keep its debt
          // and stop admission rather than treating it as an unsent request.
          this.fail(`TinyG serial write failed: ${err.message}`);
          break;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  receive(data) {
    if (!Array.isArray(data.f) || !this.active.length || this.failed || this.suspended) {
      return;
    }
    const n = data.r && Number(data.r.n);
    let index = this.active.findIndex((r) => r.n && r.n === n &&
      (!data.r.gc || data.r.gc === r.line));
    if (index < 0) {
      // Never guess ownership of a footer-only error with multiple requests.
      const controls = this.active.filter((r) => !r.n);
      const response = data.r || {};
      const control = controls[0];
      const tagged = control && Number.isInteger(control.tid);
      if (
        control &&
        ((tagged && data.tid === control.tid && response.gc === control.replyGC) ||
          (!tagged && ((control.kind === 'gcode' && response.gc === control.line) ||
          (!n && ((this.active.length === 1 && Object.keys(response).length === 0) ||
            (control.kind === 'json' && Object.keys(response).includes(control.key)))))))
      ) {
        index = this.active.indexOf(control);
      } else if (!tagged && this.active.length === 1 && !n && data.f[1] && Object.keys(response).length === 0) {
        index = 0;
      }
    }
    if (index < 0) {
      this.fail('Unmatched TinyG reply; reconnect before continuing');
      return;
    }
    const generation = this.generation;
    const [request] = this.active.splice(index, 1);
    this.slots = data.f[0] === 3 ? Number(data.f[2]) : 0;
    this.bytes -= request.bytes;
    if (request.done) {
      request.done(data);
    }
    if (generation === this.generation) {
      this.pump();
    }
  }
}
