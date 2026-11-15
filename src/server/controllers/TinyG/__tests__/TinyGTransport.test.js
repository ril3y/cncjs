/* eslint-env jest */
import TinyGTransport from '../TinyGTransport';

const setup = () => {
  const write = jest.fn();
  const fault = jest.fn();
  const transport = new TinyGTransport(write, fault);
  transport.lineMode = true;
  transport.slots = 12;
  return { transport, write, fault };
};

test('control replies never acknowledge numbered program requests', () => {
  const { transport } = setup();
  const program = jest.fn();
  const control = jest.fn();
  transport.enqueue('N1G1X1', { n: 1, done: program });
  transport.enqueue('{clear:null}', { done: control });
  transport.receive({ r: { clear: null }, f: [3, 0, 10] });
  expect(control).toHaveBeenCalledTimes(1);
  expect(program).not.toHaveBeenCalled();
  transport.receive({ r: { n: 1 }, f: [3, 0, 12] });
  expect(program).toHaveBeenCalledTimes(1);
});

test('bounds all controls and retains bytes until the data burst drains', () => {
  const { transport, write } = setup();
  transport.enqueue('N1G1X1', { n: 1 });
  for (let i = 0; i < 10; i++) {
    transport.enqueue('{mfo:1.1}');
  }
  expect(write).toHaveBeenCalledTimes(2);
  const bytes = transport.bytes;
  transport.receive({ r: { mfo: 1.1 }, f: [3, 0, 10] });
  expect(transport.bytes).toBeGreaterThan(bytes);
  expect(transport.active.filter(r => !r.n)).toHaveLength(1);
});

test('long lines travel alone and overlong wire lines are rejected', () => {
  const { transport, write, fault } = setup();
  transport.enqueue('N1' + 'X'.repeat(195), { n: 1 });
  transport.enqueue('N2G1X1', { n: 2 });
  expect(write).toHaveBeenCalledTimes(1);
  transport.enqueue('N3' + 'X'.repeat(250), { n: 3 });
  expect(fault).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
});

test('legacy mode serializes program and control traffic', () => {
  const { transport, write } = setup();
  transport.lineMode = false;
  transport.enqueue('N1G1X1', { n: 1 });
  transport.enqueue('{sr:null}');
  expect(write).toHaveBeenCalledTimes(1);
  transport.receive({ r: { n: 1 }, f: [2, 0, 250] });
  expect(write).toHaveBeenCalledTimes(2);
});

test('reset clears credits, queued writes and owners; asynchronous reports do not acknowledge', () => {
  const { transport } = setup();
  const done = jest.fn();
  transport.enqueue('N1G1X1', { n: 1, done });
  transport.receive({ sr: { stat: 5 } });
  expect(done).not.toHaveBeenCalled();
  transport.reset();
  expect(done).toHaveBeenCalledWith(null);
  expect(transport.active).toHaveLength(0);
  expect(transport.slots).toBe(0);
  expect(transport.bytes).toBe(0);
});

test('ambiguous errors stop admission instead of guessing an owner', () => {
  const { transport, fault } = setup();
  transport.enqueue('N1G1X1', { n: 1 });
  transport.enqueue('{mfo:1.1}');
  transport.receive({ f: [3, 110, 10] });
  expect(fault).toHaveBeenCalledTimes(1);
});

test('an unrelated generic success cannot acknowledge even a sole program line', () => {
  const { transport, fault } = setup();
  const done = jest.fn();
  transport.enqueue('N1G1X1', { n: 1, done });
  transport.receive({ r: { clear: null }, f: [3, 0, 10] });
  expect(done).not.toHaveBeenCalled();
  expect(fault).toHaveBeenCalledTimes(1);
});

test('reset suspends admission before cancellation callbacks and ignores late replies', () => {
  const { transport, write } = setup();
  const done = jest.fn(() => transport.enqueue('G1X2'));
  transport.enqueue('G1X1', { done });
  transport.reset();
  expect(done).toHaveBeenCalledWith(null);
  expect(write).toHaveBeenCalledTimes(1);
  expect(transport.active).toHaveLength(0);
  expect(transport.pending).toHaveLength(0);
  transport.enqueue('{sr:null}');
  transport.receive({ r: {}, f: [3, 0, 12] });
  expect(write).toHaveBeenCalledTimes(1);
  expect(transport.slots).toBe(0);
});

test('249-byte isolated line leaves no space for ordinary controls', () => {
  const { transport, write } = setup();
  transport.enqueue('N1' + 'X'.repeat(246), { n: 1 });
  transport.enqueue('{sr:null}');
  expect(write).toHaveBeenCalledTimes(1);
  expect(transport.bytes).toBe(249);
  transport.receive({ r: { n: 1 }, f: [3, 0, 12] });
  expect(write).toHaveBeenCalledTimes(2);
});

test('pause blocks queued program lines while allowing a bounded control request', () => {
  const { transport, write } = setup();
  transport.enqueue('N1' + 'X'.repeat(150), { n: 1 });
  transport.enqueue('N2G1X2', { n: 2 });
  expect(write).toHaveBeenCalledTimes(1);
  transport.paused = true;
  transport.enqueue('{sr:null}');
  transport.receive({ r: { n: 1 }, f: [3, 0, 12] });
  expect(write.mock.calls.flat()).not.toContain('N2G1X2\n');
  expect(write.mock.calls.flat()).toContain('{sr:null}\n');
  transport.receive({ r: { sr: {} }, f: [3, 0, 12] });
  expect(write.mock.calls.flat()).not.toContain('N2G1X2\n');
  transport.paused = false;
  transport.pump();
  expect(write.mock.calls.flat()).toContain('N2G1X2\n');
});

test('a sole named control cannot be completed by a conflicting named reply', () => {
  const { transport, fault } = setup();
  const done = jest.fn();
  transport.enqueue('{fb:null}', { done });
  transport.receive({ r: { mfo: 1 }, f: [3, 0, 10] });
  expect(done).not.toHaveBeenCalled();
  expect(transport.bytes).toBeGreaterThan(0);
  expect(fault).toHaveBeenCalledTimes(1);
});
