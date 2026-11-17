/* eslint-env jest */
import TinyGController from '../TinyGController';
import { createController } from '../../__tests__/helpers/createController';

let controller;
let writes;
let drains;
let events;

beforeEach(() => {
  jest.useFakeTimers();
  ({ controller, writes } = createController(TinyGController, { port: `/dev/recover-${Math.random()}` }));
  drains = [];
  events = [];
  controller.connection.port = { drain: done => drains.push(done) };
  controller.sockets.test = { emit: (event, ...args) => events.push({ event, args }) };
  controller.runner.settings.fb = 450.06;
  controller.ready = true;
  controller.lineMode = true;
  controller.transport.lineMode = true;
  controller.transport.slots = 12;
  controller.runner.parse('{"sr":{"stat":3}}');
});

afterEach(() => {
  controller.destroy();
  jest.useRealTimers();
});

const last = () => JSON.parse(writes[writes.length - 1].data);
const reply = (r, f = [3, 0, 12], tid = last().tid) => {
  controller.runner.parse(JSON.stringify({ tid, r, f }));
};
const begin = (command = '%') => {
  controller.write(command);
  controller.command('recover');
  expect(controller.ready).toBe(false);
  expect(controller.transport.suspended).toBe(true);
  drains.shift()(null);
  expect(last()).toMatchObject({ stat: null });
};
const toStatus = () => {
  begin();
  reply({ stat: 3 });
  reply({ gc: 'M400' });
  reply({ rx: 12 });
};

test('explicit Recover with an acknowledged wire stream starts only a separately requested job', () => {
  controller.command('gcode:load', 'old.nc', 'G1X1\nG1X2\nG1X3');
  // The loaded job has not been sent; only unsent host work can be discarded.
  expect(controller.transport.active).toHaveLength(0);
  begin();
  expect(controller.transport.active).toHaveLength(0);
  expect(controller.transport.pending).toHaveLength(0);
  expect(controller.sender.state.sent).toBe(0);
  expect(controller.sender.state.received).toBe(0);
  const tids = [last().tid];
  reply({ stat: 3 });
  expect(last()).toMatchObject({ gc: 'M400' });
  tids.push(last().tid);
  reply({ gc: 'M400' });
  expect(last()).toMatchObject({ rx: null });
  tids.push(last().tid);
  reply({ rx: 12 }, [3, 0, 11]);
  expect(last()).toMatchObject({ sr: null });
  tids.push(last().tid);
  reply({ sr: { stat: 3, posx: 42 } });
  expect(last()).toMatchObject({ stat: null, qr: null });
  tids.push(last().tid);
  expect(new Set(tids).size).toBe(tids.length);
  const count = writes.length;
  reply({ stat: 3, qr: 32 }, [3, 0, 10]);
  expect(controller.ready).toBe(true);
  expect(Number(controller.runner.state.sr.wpos.x)).toBe(42);
  expect(controller.transport.suspended).toBe(false);
  expect(controller.transport.bytes).toBe(0);
  expect(controller.transport.slots).toBe(10);
  expect(controller.sender.sp.freeSlots).toBe(10);
  expect(controller.workflow.isIdle()).toBe(true);
  expect(writes).toHaveLength(count); // Recover does not resume motion.
  controller.command('gcode:load', 'new.nc', 'G1X7');
  controller.command('gcode:start');
  expect(writes[writes.length - 1].data).toBe('N1G1X7\n');
});

test('recovery waits for the output boundary, and ignores untagged, stale and duplicate responses', () => {
  controller.write('%');
  controller.command('recover');
  const count = writes.length;
  controller.runner.parse('{"r":{"stat":3},"f":[3,0,12]}');
  expect(writes).toHaveLength(count);
  drains.shift()(null);
  const stateTid = last().tid;
  reply({ stat: 3 }, [3, 0, 12], stateTid + 1);
  expect(last()).toMatchObject({ stat: null });
  reply({ stat: 3 });
  reply({ gc: 'M400' });
  const rxTid = last().tid;
  reply({ rx: 12 }, [3, 0, 12], stateTid);
  expect(last().tid).toBe(rxTid);
  reply({ rx: 12 });
  reply({ sr: { stat: 3 }, qr: 32 }, [3, 0, 12], rxTid);
  controller.runner.parse('{"sr":{"stat":3},"qr":32}');
  expect(controller.ready).toBe(false);
  reply({ sr: { stat: 4 } });
  expect(controller.ready).toBe(false);
  reply({ stat: 4, qr: 32 });
  expect(controller.ready).toBe(true);
});

test.each([0, 2, 5, 6, 7, 9, 10, 11, 12, 13, null])('fresh state %p cannot clear an alarm or unlock', stat => {
  begin();
  reply({ stat });
  expect(controller.recovery).toBeNull();
  expect(controller.ready).toBe(false);
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'failed', step: 'state', reply: { r: { stat } } });
  expect(writes.some(({ data }) => data.includes('clear'))).toBe(false);
});

test.each([
  { sr: { stat: 2 }, qr: 32 },
  { sr: { stat: 5 }, qr: 32 },
  { sr: { stat: 6 }, qr: 32 },
  {},
  { stat: 3, qr: 32 }
])('final status %p keeps quarantine and exposes the board reply', r => {
  toStatus();
  reply(r);
  expect(controller.ready).toBe(false);
  expect(controller.transport.suspended).toBe(true);
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'failed', step: 'status', reply: { r } });
});

test.each([undefined, null, -1, 0, 29, '12', 1.5])('invalid rx %p cannot seed credits', rx => {
  begin();
  reply({ stat: 3 });
  reply({ gc: 'M400' });
  reply({ rx });
  expect(controller.transport.slots).toBe(0);
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'failed', step: 'rx' });
});

test.each([[2, 0, 12], [3, 204, 12], [3, 0, -1], [3, 0, '12'], [3, 0]].map(f => [f]))('invalid footer %p fails the current step', f => {
  begin();
  reply({ stat: 3 }, f);
  expect(controller.ready).toBe(false);
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'failed', step: 'state' });
});

test.each(['drain', 'state', 'input', 'rx', 'status', 'planner'])('%s timeout cannot unlock and can be explicitly retried with new tags', step => {
  controller.write('%');
  controller.command('recover');
  if (step !== 'drain') drains.shift()(null);
  if (['input', 'rx', 'status', 'planner'].includes(step)) reply({ stat: 3 });
  if (['rx', 'status', 'planner'].includes(step)) reply({ gc: 'M400' }, [3, 0, 12]);
  if (['status', 'planner'].includes(step)) reply({ rx: 12 });
  if (step === 'planner') reply({ sr: { stat: 3 } });
  const oldTid = controller.recovery.tid;
  jest.advanceTimersByTime(5001);
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'failed', step });
  expect(controller.ready).toBe(false);
  controller.command('recover');
  while (drains.length) drains.shift()(null);
  expect(controller.recovery.tid).not.toBe(oldTid);
  reply({ sr: { stat: 3 }, qr: 32 }, [3, 0, 12], oldTid);
  expect(controller.ready).toBe(false);
});

test.each(['error', 'startup', 'reset', 'stop', 'flush', 'destroy'])('%s invalidates delayed drain and probe replies', action => {
  begin();
  const oldTid = last().tid;
  if (action === 'error') controller.connectionEventListener.error(new Error('USB gone'));
  if (action === 'startup') controller.runner.parse('{"sr":{"fb":450.06,"msg":"SYSTEM READY"}}');
  if (action === 'reset') controller.command('reset');
  if (action === 'stop') controller.write('\x04');
  if (action === 'flush') controller.write('%');
  if (action === 'destroy') {
    controller.destroy();
    while (drains.length) drains.shift()(null);
    return;
  }
  const count = writes.length;
  reply({ sr: { stat: 3 }, qr: 32 }, [3, 0, 12], oldTid);
  expect(writes).toHaveLength(count);
  expect(controller.ready).toBe(false);
});

test('double Recover, Start, raw writes, unlock and override cannot interleave during recovery', () => {
  begin();
  const count = writes.length;
  ['recover', 'gcode:start', 'unlock', 'spindleOverride', 'statusreport'].forEach(cmd => controller.command(cmd, 10));
  controller.write('{clear:null}\n');
  controller.write('~');
  controller.write('G1X500');
  jest.advanceTimersByTime(1000);
  expect(writes).toHaveLength(count);
  expect(controller.workflow.isIdle()).toBe(true);
});

test('unknown transport failures and healthy running jobs cannot use Recover', () => {
  controller.command('gcode:load', 'job.nc', 'G1X1\nG1X2');
  controller.command('gcode:start');
  const count = writes.length;
  controller.command('recover');
  expect(controller.workflow.isRunning()).toBe(true);
  expect(writes).toHaveLength(count);
  controller.transport.fail('unknown partial input');
  controller.command('recover');
  expect(drains).toHaveLength(0);
  expect(controller.ready).toBe(false);
});

test('drain error stays blocked with the failed step visible', () => {
  controller.write('%');
  controller.command('recover');
  drains.shift()(new Error('drain failed'));
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'failed', step: 'drain' });
  expect(writes.map(({ data }) => data)).toEqual(['%']);
});


test.each([{ stat: 2, qr: 32 }, { stat: 5, qr: 32 }, { stat: 6, qr: 32 },
  { stat: 3, qr: 31 }, { stat: 3 }, { stat: 3, qr: '32' }])('planner proof %p cannot unlock', r => {
  toStatus();
  reply({ sr: { stat: 3 } });
  reply(r);
  expect(controller.ready).toBe(false);
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'failed', step: 'planner', reply: { r } });
});

test.each([{ gc: 'M400', status: 204 }, { gc: 'G1X1', status: 0 }])('input fence rejects unexpected result %p', ({ gc, status }) => {
  begin();
  reply({ stat: 3 });
  reply({ gc }, [3, status, 12]);
  expect(controller.ready).toBe(false);
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'failed', step: 'input' });
  expect(writes.some(({ data }) => data.includes('clear'))).toBe(false);
});

test.each(['error', 'reset', 'stop', 'flush', 'destroy'])('%s cancels an outstanding output drain', action => {
  controller.write('%');
  controller.command('recover');
  const drain = drains.shift();
  if (action === 'error') controller.connectionEventListener.error(new Error('USB gone'));
  if (action === 'reset') controller.command('reset');
  if (action === 'stop') controller.write('\x04');
  if (action === 'flush') controller.write('%');
  if (action === 'destroy') controller.destroy();
  const count = writes.length;
  drain(null);
  expect(writes).toHaveLength(count);
});

test('configured ALARM requires explicit Reset without writing recovery commands', () => {
  const count = writes.length;
  controller.runner.parse('{"sr":{"stat":2}}');
  expect(writes).toHaveLength(count);
  expect(controller.ready).toBe(false);
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'required', canRecover: false });
  expect(controller.recovery).toBeNull();
});

test('a partial serial write requires Reset instead of retrying Recover', () => {
  controller.write('%');
  controller.command('recover');
  controller.connection.write = () => { throw new Error('partial write'); };
  drains.shift()(null);
  expect(controller.ready).toBe(false);
  expect(controller.runner.state.recovery).toMatchObject({ phase: 'failed', canRecover: false });
  controller.command('recover');
  expect(drains).toHaveLength(0);
});


test.each(['gcode:stop', 'jogCancel'])('%s can interrupt recovery through the UI command path', command => {
  begin();
  const oldTid = last().tid;
  controller.command(command, { force: true });
  expect(controller.recovery).toBeNull();
  expect(controller.ready).toBe(false);
  expect(writes[writes.length - 1].data).toBe(command === 'gcode:stop' ? '\x04' : '%');
  const count = writes.length;
  reply({ stat: 3 }, [3, 0, 12], oldTid);
  expect(writes).toHaveLength(count);
});

test.each(['command', 'raw'])('Feed Hold via %s cancels recovery before a delayed barrier reply', path => {
  begin();
  reply({ stat: 3 });
  const tid = last().tid;
  if (path === 'command') controller.command('feedhold');
  else controller.write('!');
  const count = writes.length;
  reply({ gc: 'M400' }, [3, 0, 12], tid);
  expect(controller.recovery).toBeNull();
  expect(writes).toHaveLength(count);
  expect(controller.ready).toBe(false);
});


test.each(['\x04', '%'])('pending M30 followed by motion requires Reset after %p', action => {
  // 450.06 keeps DATA after ^D; M30 clears ALARM before the alarm gate and
  // could make the next move executable. % may be ignored. Neither action
  // authorizes sending a fence that drains this backlog.
  controller.transport.enqueue('N1M30', { n: 1 });
  controller.transport.enqueue('N2G1X100', { n: 2 });
  expect(controller.transport.active).toHaveLength(2);
  controller.write(action);
  const count = writes.length;
  controller.command('recover');
  expect(drains).toHaveLength(0);
  expect(writes).toHaveLength(count);
  expect(controller.runner.state.recovery).toMatchObject({ canRecover: false });
  expect(controller.ready).toBe(false);
});

test('even a benign outstanding GET prevents treating an ignored % as a proven discard', () => {
  controller.transport.enqueue('{"sr":null}');
  expect(controller.transport.active.length).toBeGreaterThan(0);
  controller.write('%');
  controller.command('recover');
  expect(drains).toHaveLength(0);
  expect(controller.ready).toBe(false);
});

test('Stop with no outstanding wire commands still requires explicit Reset', () => {
  controller.write('\x04');
  controller.command('recover');
  expect(writes.map(({ data }) => data)).toEqual(['\x04']);
  expect(controller.runner.state.recovery.canRecover).toBe(false);
});

test.each([2, 12, 13])('a newer safety state %s cannot be cleared by Recover', stat => {
  toStatus();
  const count = writes.length;
  reply({ sr: { stat } });
  expect(writes).toHaveLength(count);
  expect(controller.ready).toBe(false);
  expect(writes.some(({ data }) => data.includes('clear'))).toBe(false);
});


test('widget queue-flush command stops host workflow without introducing a new GET owner', () => {
  controller.command('jogCancel');
  expect(writes.map(({ data }) => data)).toEqual(['!', '%']);
  expect(controller.workflow.isIdle()).toBe(true);
  expect(controller.runner.state.recovery.canRecover).toBe(true);
  controller.command('recover');
  expect(drains).toHaveLength(1);
});
