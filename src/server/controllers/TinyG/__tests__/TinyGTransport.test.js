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

test('overtaking control replies release only their own UART bytes', () => {
  const { transport, write } = setup();
  transport.enqueue('N1G1X1', { n: 1 });
  for (let i = 0; i < 10; i++) {
    transport.enqueue('{mfo:1.1}');
  }
  expect(write).toHaveBeenCalledTimes(2);
  const bytes = transport.bytes;
  transport.receive({ r: { mfo: 1.1 }, f: [3, 0, 10] });
  expect(transport.bytes).toBe(bytes); // next same-size control refills the released credit
  expect(transport.active.some(request => request.n === 1)).toBe(true);
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

test.each([{}, { n: 87 }])('verbose MDI echo owns its reply despite cached n: %j', extra => {
  const { transport, fault } = setup();
  const done = jest.fn();
  transport.enqueue('G1X2', { done });
  transport.receive({ r: { ...extra, gc: 'G1X2' }, f: [3, 0, 12] });
  expect(done).toHaveBeenCalledTimes(1);
  expect(fault).not.toHaveBeenCalled();
  expect(transport.bytes).toBe(0);
});

test('wrong MDI echo cannot complete the active request', () => {
  const { transport, fault } = setup();
  const done = jest.fn();
  transport.enqueue('G1X2', { done });
  transport.receive({ r: { gc: 'G1X1' }, f: [3, 0, 12] });
  expect(done).not.toHaveBeenCalled();
  expect(fault).toHaveBeenCalledTimes(1);
});

test('refills on one program ACK without waiting for the remaining active lines', () => {
  const { transport, write } = setup();
  const line = n => 'N' + n + 'X'.repeat(37); // 40 wire bytes
  for (let n = 1; n <= 4; n++) {
 transport.enqueue(line(n), { n });
}
  expect(write).toHaveBeenCalledTimes(3);
  expect(transport.bytes).toBe(120);
  transport.receive({ r: { n: 1 }, f: [3, 0, 10] });
  expect(write).toHaveBeenCalledTimes(4);
  expect(transport.active.map(request => request.n)).toEqual([2, 3, 4]);
  expect(transport.bytes).toBe(120);
});

test('rolling wire credit stays bounded during repeated control overtakes and declining headers', () => {
  const { transport, write } = setup();
  transport.enqueue('N1' + 'X'.repeat(117), { n: 1 }); // 120 bytes held outstanding
  for (let i = 0; i < 8; i++) {
 transport.enqueue('{mfo:1.1}');
}
  for (let slots = 10; slots >= 2; slots--) {
    if (!transport.active.some(request => !request.n)) {
 break;
}
    transport.receive({ r: { mfo: 1.1 }, f: [3, 0, slots] });
    const sum = transport.active.reduce((total, request) => total + Buffer.byteLength(request.line + '\n'), 0);
    expect(transport.bytes).toBe(sum);
    expect(sum).toBeLessThanOrEqual(200);
    expect(transport.active.some(request => request.n === 1)).toBe(true);
  }
  expect(write.mock.calls.length).toBeGreaterThan(2);
  expect(transport.bytes).toBeGreaterThanOrEqual(120);
});

test('duplicate program reply cannot release rolling credit twice', () => {
  const { transport, fault } = setup();
  transport.enqueue('N1G1X1', { n: 1 });
  transport.enqueue('N2G1X2', { n: 2 });
  transport.receive({ r: { n: 1 }, f: [3, 0, 10] });
  const bytes = transport.bytes;
  transport.receive({ r: { n: 1 }, f: [3, 0, 10] });
  expect(transport.bytes).toBe(bytes);
  expect(fault).toHaveBeenCalledTimes(1);
});

test('write failure preserves uncertain byte debt and prevents further writes', () => {
  const fault = jest.fn();
  const write = jest.fn(() => {
    throw new Error('driver failed');
  });
  const transport = new TinyGTransport(write, fault);
  transport.enqueue('N1G1X1', { n: 1 });
  expect(fault).toHaveBeenCalledTimes(1);
  expect(transport.bytes).toBe(Buffer.byteLength('N1G1X1\n'));
  transport.enqueue('N2G1X2', { n: 2 });
  expect(write).toHaveBeenCalledTimes(1);
});

test('execution fence waits for every prior owner and blocks all later ordinary writes', () => {
  const { transport, write } = setup();
  transport.enqueue('N1M0', { n: 1 });
  transport.fencing = true;
  transport.enqueue('M400', { priority: true, fence: true, done: () => { transport.fencing = false; } });
  transport.enqueue('G1X2');
  transport.enqueue('{mfo:1.1}', { priority: true });
  expect(write).toHaveBeenCalledTimes(1);
  transport.receive({ r: { n: 1 }, f: [3, 0, 12] });
  expect(write.mock.calls.flat()).toEqual(['N1M0\n', 'M400\n']);
  transport.receive({ r: { gc: 'M400' }, f: [3, 0, 12] });
  expect(write.mock.calls.flat()).toContain('G1X2\n');
});

test.each([{ tid: 40, gc: 'M400' }, { tid: 41, gc: 'G1X1' }, { gc: 'M400' }])('tagged fence rejects stale or conflicting completion %j', reply => {
  const { transport, fault } = setup();
  const done = jest.fn();
  transport.enqueue('{"tid":41,"gc":"M400"}', { tid: 41, replyGC: 'M400', fence: true, done });
  transport.receive({ tid: reply.tid, r: { gc: reply.gc }, f: [3, 0, 12] });
  expect(done).not.toHaveBeenCalled();
  expect(fault).toHaveBeenCalledTimes(1);
  expect(transport.bytes).toBeGreaterThan(0);
});
