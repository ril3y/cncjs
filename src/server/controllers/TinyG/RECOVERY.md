# Explicit TinyG recovery

On a configured 450.06 line-mode connection, Stop (`^D`), queue flush (`!` then `%`), or a reported ALARM blocks new jobs. The TinyG widget and its warning offer the same **Recover** action (`command('recover')`). Recovery is always operator initiated. It neither replays pending host commands nor starts the loaded job.

Recovery uses a serial output drain and unique transaction IDs for each step:

1. Read fresh `stat`; accept only READY, ALARM, STOP or END (1/2/3/4).
2. Send a pure tagged `gc: "M400"` DATA barrier. Require its exact echo and status 204 in ALARM, or status 0 when idle. Priority getters alone cannot prove older DATA has left the input queue. The ALARM barrier must complete before `clear` is sent.
3. If the fresh state was ALARM, send `clear: null` and require its successful result.
4. Read `rx` and validate the free-line count against the 450.06 twelve-header contract. Old host ownership and byte debt have already been discarded; they are never credited by old replies.
5. Read a full `sr` report and require READY, STOP or END. Then read flat `stat` and `qr`, requiring an idle state again and all 32 planner slots free. These are separate requests so a queue report cannot hide the full status update.
6. Seed line credits conservatively from the minimum of the RX result and subsequent footer credits, then reopen admission. Starting a job still requires a separate operator action.

A missing, malformed, rejected or timed-out step leaves admission blocked and displays the step and available board reply. Each step has a five-second deadline. A later explicit retry uses new transaction IDs. Unknown partial writes, disconnects and unexpected startup require Reset instead. Reset, feed hold, forced Stop and queue flush remain available to interrupt recovery; late replies or drain callbacks cannot complete the canceled attempt.

The implementation targets the reviewed 450.06 protocol. Mock tests and a browser component preview do not establish hardware compatibility. Qualify Stop plus Recover plus a separate job, and hold/flush plus Recover plus a separate job, against the exact candidate and firmware hashes with pulse and endpoint measurements. Include delayed old DATA and verify the tagged barrier/clear ordering in the serial log. No recovery should reset, reopen, home, or clear an alarm silently.
