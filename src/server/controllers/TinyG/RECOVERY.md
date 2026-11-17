# Explicit TinyG recovery

The TinyG widget and its warning expose the same operator-initiated `command('recover')` action. It never starts a job, sends `clear`, resets, reopens, or homes the controller.

## Current limits on 450.06

**One-click recovery after Stop/ALARM is not supported yet.** It requires an additional firmware contract. Stop (`^D`), reported ALARM, unknown partial writes, disconnects and unexpected startup require explicit Reset. Sending `%` is also insufficient evidence of a discard: the firmware can ignore it when no hold flush is pending.

Recover after queue flush is therefore enabled only on a configured 450.06 line-mode connection whose tracked active wire queue was empty when `%` was requested. Every prior ordinary command must already have its own acknowledgement. Unsent host requests are canceled; any unacknowledged command, including a status query, requires Reset. A retry is allowed only within that previously established restricted attempt; its requests contain no alarm-clear or motion commands. This assumes exclusive ordered writes and intact framing.

## Verification sequence

1. Freeze ordinary host producers, cancel unsent host work, rewind/hold the sender and drain host serial output.
2. Read fresh tagged `stat`; require READY, STOP or END (1/3/4).
3. Send tagged pure `gc: "M400"`; require its exact echo and successful footer. This proves runtime completion under the firmware M400 contract. It is not an input discard and must not be used to drain an arbitrary backlog.
4. Read `rx`; validate the free-line count against the twelve-header contract.
5. Read full `sr`, requiring READY, STOP or END; then separately read flat `stat` and `qr`, again requiring an idle state and all 32 planner slots free.
6. Seed line credits conservatively from the RX result and subsequent footer credits, then allow a separately requested job start. Old replies never credit canceled owners.

Each step has a five-second deadline and its own transaction ID. Failure leaves admission blocked and shows the step and available reply. Feed Hold (command or raw `!`), forced Stop, queue flush, Reset and connection faults invalidate the attempt; delayed replies/drain callbacks cannot advance it. Cancellation cannot revoke requests already transmitted to the board. These recovery requests do not clear alarms or execute motion.

## Why the restriction exists

Firmware 450.06 preserves input after `^D`. Buffered standalone M2/M30 can clear ALARM before the G-code alarm gate, letting later stale motion execute. A DATA fence proves earlier DATA was dispatched or discarded, not that it never executed. Priority status/RX getters can overtake that DATA. Also, `clear` clears SHUTDOWN as well as ALARM: checking ALARM on the host cannot prevent clearing a newer SHUTDOWN.

Full Stop recovery needs a device-side discard-and-ack contract with atomic safety-state semantics. Until then, explicit Reset is the available recovery path for these cases. Mock tests and browser checks do not establish hardware compatibility. Qualify the restricted queue-flush path separately, retaining exact candidate/firmware hashes, serial ordering, pulse counts and endpoint measurements. Stop with buffered M30 followed by motion, ignored `%`, and newer safety-state cases must remain blocked; do not describe host queue cancellation as firmware input discard.
