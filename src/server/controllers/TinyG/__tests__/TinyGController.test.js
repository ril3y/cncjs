/* eslint-env jest */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import TinyGController from '../TinyGController';
import config from '../../../services/configstore';
import monitor from '../../../services/monitor';
import { WORKFLOW_STATE_IDLE, WORKFLOW_STATE_PAUSED, WORKFLOW_STATE_RUNNING } from '../../../lib/Workflow';
import {
  TOOL_CHANGE_POLICY_IGNORE_M6_COMMANDS,
  TOOL_CHANGE_POLICY_SEND_M6_COMMANDS,
  TOOL_CHANGE_POLICY_MANUAL_TOOL_CHANGE_WCS,
  TOOL_CHANGE_POLICY_MANUAL_TOOL_CHANGE_TLO,
  TOOL_CHANGE_POLICY_MANUAL_TOOL_CHANGE_CUSTOM_PROBING,
  WRITE_SOURCE_CLIENT,
  WRITE_SOURCE_FEEDER,
} from '../../constants';
import { SP_TYPE_LINE_COUNTING, SP_TYPE_SEND_RESPONSE } from '../../../lib/Sender';
import SerialConnection from '../../../lib/SerialConnection';
import { createController } from '../../__tests__/helpers/createController';

let controllers = [];
let controllerSequence = 0;
let configSpy = null;
const tempFiles = [];

afterEach(() => {
  controllers.forEach((controller) => controller.destroy());
  controllers = [];
  if (configSpy) {
    configSpy.mockRestore();
    configSpy = null;
  }
  tempFiles.forEach((file) => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
  tempFiles.length = 0;
});

const setupController = (configOverrides = {}) => {
  configSpy = jest.spyOn(config, 'get').mockImplementation((key, defaultValue) => {
    if (Object.prototype.hasOwnProperty.call(configOverrides, key)) {
      return configOverrides[key];
    }
    return defaultValue;
  });

  const { controller, writes } = createController(TinyGController, { port: `/dev/test-tinyg-${++controllerSequence}` });

  // TinyG connection.write drops the context argument, so write sources are
  // observed through the socket-facing 'serialport:write' event instead.
  const events = [];
  controller.sockets.test = { emit: (event, ...args) => events.push({ event, args }) };
  controller.ready = true; // Unit tests bypass the connection setup.
  controllers.push(controller);

  return { controller, writes, events };
};

const data = (writes) => writes.map((entry) => entry.data);

const answerFence = (controller, writes, status = 0) => {
  const request = JSON.parse(data(writes).filter(line => line.includes('M400')).pop());
  controller.runner.parse(JSON.stringify({ tid: request.tid, r: { gc: 'M400' }, f: [3, status, 12] }));
  return request.tid;
};

const sourceOf = (events, text) => events
  .filter((entry) => entry.event === 'serialport:write' && entry.args[0] === text)
  .map((entry) => entry.args[1].source);

// The feeder writes one line per machine acknowledgement and parks on M0/%wait
// holds; unholding between next() calls replays the full queue synchronously.
const drainFeeder = (controller) => {
  let limit = 1000;
  while (limit-- > 0 && (controller.feeder.size() || controller.transport.active.length || controller.transport.pending.length)) {
    if (controller.feeder.state.hold) {
      controller.feeder.unhold();
    }
    if (controller.transport.active.length) {
      const request = controller.transport.active[0];
      controller.runner.parse(JSON.stringify({ r: request.n ? { n: request.n } : {}, f: [2, 0, 250] }));
    } else {
      controller.feeder.next();
    }
  }
};

const seedModal = (controller, modal) => {
  controller.runner.state = {
    ...controller.runner.state,
    sr: {
      ...controller.runner.state.sr,
      modal: {
        ...controller.runner.state.sr.modal,
        ...modal,
      },
    },
  };
};

const captureConsoleOutput = (fn) => {
  const chunks = [];
  const stdoutSpy = jest.spyOn(console._stdout || process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return chunks.join('');
};

const tempFile = (name) => {
  const file = path.join(os.tmpdir(), name);
  tempFiles.push(file);
  return file;
};

// Answers each line written to the board with reply(line) on a later tick, the way the
// board replies over the serial port, and counts the lines still waiting for a reply.
const respondToWrites = (controller, writes, reply) => {
  const stats = { outstanding: 0, maxOutstanding: 0 };
  controller.connection.write = (data) => {
    writes.push({ data });
    const response = reply(String(data).trim());
    if (!response) {
      return;
    }
    stats.outstanding++;
    stats.maxOutstanding = Math.max(stats.maxOutstanding, stats.outstanding);
    setImmediate(() => {
      stats.outstanding--;
      if (controller.runner) {
        controller.runner.parse(response);
      }
    });
  };
  return stats;
};

const setupCommands = [
  '{fb:n}', '{stat:n}', '{ej:1}', '{jv:5}', '{ex:0}', '{qv:1}', '{sv:1}', '{si:200}',
  '{spe:n}', '{spd:n}', '{spc:n}', '{sps:n}', '{com:n}', '{cof:n}',
  expect.stringMatching(/^{sr:{stat:t,/),
  '{sys:n}', '{mt:n}', '{pwr:n}', '{qr:n}', '{sr:n}',
];

const toolChangeWrites = ({ changeZ, changeXY, probeXY, probeZ, policyLines }) => [
  'G4 P0.5',
  'M5',
  'G90',
  changeZ,
  changeXY,
  'G4 P0.5',
  'M0',
  probeXY,
  probeZ,
  'G4 P0.5',
  ...policyLines,
  changeZ,
  changeXY,
  'G4 P0.5',
  'M0',
  'G90',
  'G0 X0 Y0',
  'G0 Z0',
  'M5',
  'G4 P5',
].map((line) => line + '\n');

describe('TinyGController', () => {
  describe('command handlers', () => {
    test.each([
      ['feedhold', ['!', '{"qr":""}\n']],
      ['cyclestart', ['~', '{"qr":""}\n']],
      ['statusreport', ['{"sr":null}\n']],
      ['homing', ['G28.2 X0 Y0 Z0\n']],
      ['sleep', []],
      ['unlock', ['{clear:null}\n']],
      ['jogCancel', ['!', '%']],
    ])('command %s writes %j', (cmd, expected) => {
      const { controller, writes } = setupController();

      controller.command(cmd);

      drainFeeder(controller);
      expect(data(writes)).toEqual(expected);
    });

    test('feedhold and cyclestart write as the client', () => {
      const { controller, writes, events } = setupController();

      controller.command('feedhold');
      controller.command('cyclestart');

      expect(sourceOf(events, '!\n')).toEqual([WRITE_SOURCE_CLIENT]);
      expect(sourceOf(events, '{"qr":""}\n')).toEqual([WRITE_SOURCE_CLIENT, WRITE_SOURCE_CLIENT]);
      expect(sourceOf(events, '~\n')).toEqual([WRITE_SOURCE_CLIENT]);
      drainFeeder(controller);
      expect(writes).toHaveLength(4);
    });

    test('reset writes a bare control character and clears the feeder', () => {
      const { controller, writes, events } = setupController();

      controller.command('feeder:feed', ['G21', 'G90']);
      controller.command('reset');

      expect(data(writes)).toEqual(['G21\n', '\x18']);
      expect(sourceOf(events, '\x18')).toEqual([WRITE_SOURCE_CLIENT]);
      expect(controller.feeder.size()).toBe(0);
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
    });

    test.each([['feedOverride', 'mfo'], ['spindleOverride', 'sso']])('%s coalesces clicks and reads back before the next write', (command, key) => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command(command, 10);
      controller.command(command, 10);
      expect(writes).toHaveLength(1); // fresh GET before computing the delta
      controller.runner.parse(JSON.stringify({ r: { [key]: 1 }, f: [3, 0, 10] }));
      expect(data(writes)[1]).toBe(JSON.stringify({ [key]: 1.2 }) + '\n');
      controller.runner.parse(JSON.stringify({ r: { [key]: 1.2 }, f: [3, 0, 10] }));
      expect(writes).toHaveLength(3); // authoritative readback
      controller.runner.parse(JSON.stringify({ r: { [key]: 1.2 }, f: [3, 0, 10] }));
      expect(controller.overrideBusy).toBe(false);
    });

    test.each([0, 440.21, 449.02, 450.04, 450.05, 450.06])('override capability gates for %s', fb => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = fb;
      controller.command('rapidOverride', 50);
      expect(writes).toHaveLength(0);
      controller.command('spindleOverride', 10);
      expect(writes).toHaveLength(fb >= 450.06 ? 1 : 0);
      if (fb < 450.06) {
        controller.command('feedOverride', 10);
        expect(writes).toHaveLength(fb >= 450.05 ? 1 : 0);
      }
    });

    test.each([104, 110])('override error %s reads back the board value without retrying the write', code => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('feedOverride', 10);
      controller.runner.parse('{"r":{"mfo":1},"f":[3,0,10]}');
      controller.runner.parse(JSON.stringify({ r: { mfo: 1.1 }, f: [3, code, 10] }));
      expect(controller.runner.settings.mfo).toBe(1);
      expect(data(writes)[2]).toBe('{"mfo":null,"mfc":null,"mfe":null}\n');
      controller.runner.parse('{"r":{"mfo":0.8,"mfc":1,"mfe":0},"f":[3,0,10]}');
      expect(controller.runner.settings.mfo).toBe(0.8);
      expect(controller.runner.settings.mfe).toBe(0);
      expect(writes).toHaveLength(3);
      expect(controller.overrideBusy).toBe(false);
    });

    test('feed change event updates the next increment but never acknowledges a program', () => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.runner.settings.mfo = 1.8;
      controller.runner.parse('{"ov":{"v":1,"q":5,"mfo":1,"mfc":1,"mfe":1}}');
      expect(controller.sender.state.received).toBe(0);
      controller.command('feedOverride', 10);
      controller.runner.parse('{"r":{"mfo":1},"f":[3,0,10]}');
      expect(data(writes)[1]).toBe('{"mfo":1.1}\n');
    });

    test.each([['feedOverride', 'mfo'], ['spindleOverride', 'sso']])('%s reads a job-end reset before applying a click', (command, key) => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.runner.settings[key] = 1.8;
      controller.command(command, 10);
      // No status/event has delivered the firmware's reset yet.
      controller.runner.parse(JSON.stringify({ r: { [key]: 1 }, f: [3, 0, 12] }));
      expect(data(writes)[1]).toBe(JSON.stringify({ [key]: 1.1 }) + '\n');
    });

    test('coalesced clicks preserve saturation and reset order', () => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('feedOverride', 100);
      controller.command('feedOverride', -100);
      controller.runner.parse('{"r":{"mfo":1.8},"f":[3,0,12]}');
      expect(data(writes)[1]).toBe('{"mfo":1}\n');
    });

    test('coalesced reset overrides earlier clicks and later clicks apply to 100 percent', () => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      [50, 0, 10].forEach(step => controller.command('spindleOverride', step));
      controller.runner.parse('{"r":{"sso":1.8},"f":[3,0,12]}');
      expect(data(writes)[1]).toBe('{"sso":1.1}\n');
    });

    test.each([1, 1.9])('job end may interleave with GET/SET; final spindle readback %s remains authoritative', finalFactor => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('spindleOverride', 10);
      controller.runner.parse('{"r":{"sso":1.8},"f":[3,0,12]}');
      expect(data(writes)[1]).toBe('{"sso":1.9}\n');
      // Job end can happen while this absolute SET is in transit. Firmware may
      // reset before accepting it (ends at1.9), or after accepting it (ends at1).
      // There is no atomic relative-update primitive in this wire contract.
      controller.runner.parse('{"sr":{"stat":4}}');
      controller.runner.parse('{"r":{"sso":1.9},"f":[3,0,12]}');
      expect(data(writes)[2]).toBe('{"sso":null,"ssc":null,"sse":null}\n');
      controller.runner.parse(JSON.stringify({ r: { sso: finalFactor, ssc: finalFactor, sse: 1 }, f: [3, 0, 12] }));
      expect(controller.runner.settings.sso).toBe(finalFactor);
      expect(controller.overrideBusy).toBe(false);
      expect(writes).toHaveLength(3);
    });

    test.each(['startup', 'driver error'])('%s between override GET and queued SET cancels the old intent', reason => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.transport.lineMode = true;
      controller.transport.slots = 12;
      controller.transport.enqueue('N1G1X1', { n: 1 });
      controller.command('spindleOverride', 10);
      controller.runner.parse('{"r":{"sso":1.8},"f":[3,0,1]}');
      expect(controller.transport.pending.some(request => request.line === '{"sso":1.9}')).toBe(true);
      if (reason === 'startup') {
        controller.runner.parse('{"sr":{"fb":450.06,"msg":"SYSTEM READY"}}');
      } else {
        controller.connectionEventListener.error(new Error('driver failed after GET'));
      }
      controller.runner.parse('{"r":{"n":1},"f":[3,0,12]}');
      controller.runner.parse('{"r":{"sso":1.8},"f":[3,0,12]}');
      expect(controller.transport.suspended).toBe(true);
      expect(controller.overridePending).toEqual({});
      expect(controller.overrideBusy).toBe(false);
      expect(writes).toHaveLength(2);
      expect(data(writes)).not.toContain('{"sso":1.9}\n');
    });

    test('reset discards pending override intent and credits', () => {
      const { controller } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('feedOverride', 10);
      controller.command('feedOverride', 10);
      controller.command('reset');
      expect(controller.overridePending).toEqual({});
      expect(controller.overrideBusy).toBe(false);
      expect(controller.runner.settings.mfo).toBe(1);
      expect(controller.transport.active).toHaveLength(0);
      expect(controller.transport.slots).toBe(0);
      expect(controller.ready).toBe(false);
    });

    test('rejects an overlong program after numbering without transmitting it', () => {
      const { controller, writes } = setupController();
      controller.command('gcode:load', 'long.nc', 'G1X' + '1'.repeat(250));
      controller.command('gcode:start');
      expect(writes).toHaveLength(0);
      expect(controller.transport.failed).toBe(true);
    });

    test.each(['M0', 'M1'])('ordered %s reaches the board before Resume and blocks later data', marker => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('gcode:load', 'stop.nc', marker + '\nG1X1');
      controller.command('gcode:start');
      expect(data(writes)).toEqual(['N1' + marker + '\n']);
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_PAUSED);
      controller.command('gcode:resume');
      expect(writes).toHaveLength(1); // never send ~ ahead of the marker
      controller.runner.parse('{"r":{"n":1},"f":[2,0,250]}');
      controller.command('gcode:resume');
      expect(JSON.parse(data(writes)[1])).toMatchObject({ gc: 'M400' });
      answerFence(controller, writes);
      expect(data(writes)[2]).toBe('~');
      expect(data(writes)[3]).toBe('N2G1X1\n');
    });

    test.each(['M0', 'M1', 'M6'])('%s behind a long move waits for execution, not its ACK', marker => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('gcode:load', 'long-stop.nc', 'G1X100\n' + marker + '\nG1X0');
      controller.command('gcode:start');
      controller.runner.parse('{"r":{"n":1},"f":[3,0,12]}');
      controller.runner.parse('{"r":{"n":2},"f":[3,0,12]}');
      controller.runner.parse('{"sr":{"stat":5}}');
      controller.command('gcode:resume');
      expect(data(writes)).not.toContain('~');
      expect(data(writes)).not.toContain('N3G1X0\n');
      expect(JSON.parse(data(writes).pop())).toMatchObject({ gc: 'M400' });
      // M1 disabled / host-ignored M6 need not report STOP, but the deferred
      // fence still waits for the final prepared/running segment to complete.
      answerFence(controller, writes);
      expect(data(writes)).toContain('~');
      expect(data(writes)).toContain('N3G1X0\n');
    });

    test.each([0, 1])('modern M1 with firmware os=%s retains explicit host pause until the fence completes', os => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('gcode:load', 'optional.nc', 'M1\nG1X1');
      controller.command('gcode:start');
      controller.runner.parse('{"r":{"n":1},"f":[3,0,12]}');
      controller.runner.parse(JSON.stringify({ sr: { stat: os ? 3 : 1 } }));
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_PAUSED);
      controller.command('gcode:resume');
      expect(data(writes)).not.toContain('~');
      answerFence(controller, writes);
      expect(data(writes)).toContain('~');
    });

    test('450.01 uses its deferred raw M400 fence without assuming tagged support', () => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.01;
      controller.command('gcode:load', 'stop.nc', 'M0\nG1X1');
      controller.command('gcode:start');
      controller.runner.parse('{"r":{"n":1},"f":[2,0,250]}');
      controller.command('gcode:resume');
      expect(data(writes)[1]).toBe('M400\n');
      controller.runner.parse('{"r":{"gc":"M400"},"f":[2,0,250]}');
      expect(data(writes)).toContain('~');
    });

    test('manual hold before a marker cannot force cycle start to complete its fence', () => {
      const { controller, writes, events } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('gcode:load', 'hold.nc', 'G1X100\nM0\nG1X0');
      controller.command('gcode:start');
      controller.runner.parse('{"r":{"n":1},"f":[3,0,12]}');
      controller.runner.parse('{"r":{"n":2},"f":[3,0,12]}');
      controller.runner.parse('{"sr":{"stat":6}}');
      controller.command('gcode:resume');
      controller.command('gcode:resume');
      controller.runner.parse('{"sr":{"stat":6,"qr":31}}');
      expect(data(writes)).not.toContain('~');
      expect(data(writes).filter(line => line.includes('M400'))).toHaveLength(1);
      expect(events.some(entry => entry.event === 'serialport:read' && entry.args[0].includes('manual feed hold'))).toBe(true);
    });

    test.each(['alarm', 'startup'])('%s during an execution fence cannot release pending MDI motion', reason => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('gcode:load', 'stop.nc', 'M0\nG1X1');
      controller.command('gcode:start');
      controller.runner.parse('{"r":{"n":1},"f":[3,0,12]}');
      controller.command('gcode:resume');
      const tid = JSON.parse(data(writes)[1]).tid;
      controller.write('G1X999\n');
      expect(controller.transport.pending).toHaveLength(1);
      if (reason === 'alarm') {
        answerFence(controller, writes, 204);
      } else {
        controller.runner.parse('{"sr":{"fb":450.06,"msg":"SYSTEM READY"}}');
      }
      controller.runner.parse(JSON.stringify({ tid, r: { gc: 'M400' }, f: [3, 0, 12] }));
      expect(controller.transport.suspended).toBe(true);
      expect(data(writes)).not.toContain('~');
      expect(data(writes)).not.toContain('G1X999\n');
    });

    test('repeated program pauses use distinct fence transaction IDs', () => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      controller.command('gcode:load', 'stops.nc', 'M0\nG1X1\nM0\nG1X2');
      controller.command('gcode:start');
      controller.runner.parse('{"r":{"n":1},"f":[3,0,12]}');
      controller.command('gcode:resume');
      const first = answerFence(controller, writes);
      controller.runner.parse('{"r":{"n":2},"f":[3,0,12]}');
      controller.runner.parse('{"r":{"qr":32},"f":[3,0,12]}');
      controller.runner.parse('{"r":{"n":3},"f":[3,0,12]}');
      controller.command('gcode:resume');
      const second = answerFence(controller, writes);
      expect(second).not.toBe(first);
      expect(data(writes).filter(line => line === '~')).toHaveLength(2);
      expect(data(writes)).toContain('N4G1X2\n');
    });

    test('legacy M0 requires a fresh fully freed planner and STOP after its ACK', () => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 449.02;
      controller.runner.plannerBufferPoolSize = 28; // a partial observation must not become capacity
      controller.command('gcode:load', 'stop.nc', 'M0\nG1X1');
      controller.command('gcode:start');
      controller.runner.parse('{"r":{"n":1},"f":[2,0,250]}');
      controller.command('gcode:resume');
      controller.runner.parse('{"r":{"qr":27,"stat":3},"f":[2,0,250]}');
      expect(data(writes)).not.toContain('~');
      controller.command('gcode:resume');
      controller.runner.parse('{"r":{"qr":28,"stat":3},"f":[2,0,250]}');
      expect(data(writes)).not.toContain('~');
      controller.command('gcode:resume');
      controller.runner.parse('{"r":{"qr":32,"stat":3},"f":[2,0,250]}');
      expect(data(writes)).toContain('~');
    });

    test.each([440.21, 449.02])('legacy %s host M6 pause uses a real queued M0', fb => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = fb;
      controller.command('gcode:load', 'tool.nc', 'G1X100\nM6\nG1X0');
      controller.command('gcode:start');
      controller.runner.parse('{"r":{"n":1},"f":[2,0,250]}');
      expect(data(writes)[1]).toBe('N2M0\n');
      controller.runner.parse('{"r":{"n":2},"f":[2,0,250]}');
      controller.command('gcode:resume');
      controller.runner.parse('{"r":{"qr":31,"stat":3},"f":[2,0,250]}');
      expect(data(writes)).not.toContain('~');
      controller.command('gcode:resume');
      controller.runner.parse('{"r":{"qr":32,"stat":3},"f":[2,0,250]}');
      expect(data(writes)).toContain('~');
      expect(data(writes)).toContain('N3G1X0\n');
    });

    test('unknown legacy build cannot infer a stop fence from an observed qr maximum', () => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 449.03;
      controller.runner.plannerBufferPoolSize = 28;
      controller.command('gcode:load', 'stop.nc', 'M0\nG1X1');
      controller.command('gcode:start');
      controller.runner.parse('{"r":{"n":1},"f":[2,0,250]}');
      controller.command('gcode:resume');
      expect(data(writes)).toEqual(['N1M0\n']);
    });

    test('a missing execution-fence reply times out without releasing queued motion', () => {
      jest.useFakeTimers();
      try {
        const { controller, writes } = setupController();
        controller.runner.settings.fb = 450.06;
        controller.command('gcode:load', 'stop.nc', 'M0\nG1X1');
        controller.command('gcode:start');
        controller.runner.parse('{"r":{"n":1},"f":[3,0,12]}');
        controller.command('gcode:resume');
        jest.advanceTimersByTime(10 * 60 * 1000);
        expect(controller.transport.suspended).toBe(true);
        expect(controller.ready).toBe(false);
        expect(data(writes)).not.toContain('~');
        expect(data(writes)).not.toContain('N2G1X1\n');
        controller.runner.parse('{"r":{"gc":"M400"},"f":[3,0,12]}');
        expect(data(writes)).not.toContain('~');
      } finally {
        jest.useRealTimers();
      }
    });

    test('actual startup during a job cancels owners and requires reconnect without sending motion', () => {
      const { controller, writes } = setupController();
      controller.command('gcode:load', 'job.nc', 'G1X1\nG1X2');
      controller.command('gcode:start');
      controller.runner.parse('{"sr":{"fv":0.97,"fb":450.06,"hp":1,"hv":8,"id":"test","msg":"SYSTEM READY"}}');
      expect(controller.ready).toBe(false);
      expect(controller.transport.suspended).toBe(true);
      expect(controller.transport.active).toHaveLength(0);
      const count = writes.length;
      controller.command('gcode', 'G1X123');
      controller.command('gcode:start');
      expect(writes).toHaveLength(count);
    });

    describe('energizeMotors', () => {
      test('energizeMotors:on without a motor timeout writes nothing', () => {
        const { controller, writes } = setupController();

        controller.command('energizeMotors:on');

        expect(writes).toEqual([]);
        expect(controller.timer.energizeMotors).toBeNull();
      });

      test('energizeMotors:on energizes motors once and arms the timer', () => {
        const { controller, writes } = setupController();
        controller.state.mt = 1;

        controller.command('energizeMotors:on');
        controller.command('energizeMotors:on');

        drainFeeder(controller);
        expect(data(writes)).toEqual(['{me:0}\n', '{pwr:n}\n']);
        expect(controller.timer.energizeMotors).not.toBeNull();
      });

      test('energizeMotors:off de-energizes motors and stops the timer', () => {
        const { controller, writes } = setupController();
        controller.state.mt = 1;

        controller.command('energizeMotors:on');
        controller.command('energizeMotors:off');

        drainFeeder(controller);
        expect(data(writes)).toEqual(['{me:0}\n', '{pwr:n}\n', '{md:0}\n', '{pwr:n}\n']);
        expect(controller.timer.energizeMotors).toBeNull();
      });
    });

    describe('lasertest', () => {
      test('lasertest:on with defaults fires the laser at zero power', () => {
        const { controller, writes } = setupController();

        controller.command('lasertest:on');

        expect(data(writes)).toEqual(['M3S0\n']);
      });

      test('lasertest:on with a duration adds dwell and shutdown lines', () => {
        const { controller, writes } = setupController();

        controller.command('lasertest:on', 50, 250, 2000);
        drainFeeder(controller);

        expect(data(writes)).toEqual(['M3S1000\n', 'G4P0.25\n', 'M5S0\n']);
      });

      test('lasertest:off shuts the laser down', () => {
        const { controller, writes } = setupController();

        controller.command('lasertest:off');

        expect(data(writes)).toEqual(['M5S0\n']);
      });
    });
  });

  describe('gcode and feeder commands', () => {
    test('gcode feeds non-blank lines through the feeder with its context', () => {
      const { controller, writes, events } = setupController();

      controller.command('gcode', 'G21\n\n  \nG90', { myContext: true });
      expect(data(writes)).toEqual(['G21\n']);

      drainFeeder(controller);
      expect(data(writes)).toEqual(['G21\n', 'G90\n']);

      const [event] = events.filter((entry) => entry.event === 'serialport:write' && entry.args[0] === 'G21\n');
      expect(event.args[1]).toMatchObject({ myContext: true, source: WRITE_SOURCE_FEEDER });
    });

    test('feeder:feed delegates to the gcode handler', () => {
      const { controller, writes } = setupController();

      controller.command('feeder:feed', 'G0 X0');

      expect(data(writes)).toEqual(['G0 X0\n']);
    });

    test('feeder:start cycles the machine and drains the first queued line', () => {
      const { controller, writes, events } = setupController();

      controller.command('feeder:feed', ['G0 X0', 'G0 X1']);
      controller.command('feeder:start');

      expect(data(writes)).toEqual(['G0 X0\n', '~']);
      drainFeeder(controller);
      expect(data(writes)).toEqual(['G0 X0\n', '~', '{"qr":""}\n', 'G0 X1\n']);
      expect(sourceOf(events, '~\n')).toEqual([WRITE_SOURCE_CLIENT]);
      expect(sourceOf(events, 'G0 X1\n')).toEqual([WRITE_SOURCE_FEEDER]);
    });

    test('feeder:start is a no-op while a program is running', () => {
      const { controller, writes } = setupController();

      controller.command('gcode:start');
      controller.command('feeder:start');

      expect(writes).toEqual([]);
    });

    test('feeder:stop clears the queue without writing', () => {
      const { controller, writes } = setupController();

      controller.command('feeder:feed', ['G0 X0', 'G0 X1']);
      controller.command('feeder:stop');
      drainFeeder(controller);

      expect(data(writes)).toEqual(['G0 X0\n']);
      expect(controller.feeder.size()).toBe(0);
    });
  });

  describe('sender workflow', () => {
    test('gcode:load stores the program plus a planner dwell and reports sender state', () => {
      const { controller, writes, events } = setupController();
      const callback = jest.fn();

      controller.command('gcode:load', 'test.nc', 'G21\nG90', callback);

      expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ name: 'test.nc', total: 3 }));
      expect(controller.sender.state.gcode).toBe('G21\nG90\n%wait ; Wait for the planner to empty');
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
      expect(writes).toEqual([]);
      expect(events.filter((entry) => entry.event === 'gcode:load')).toHaveLength(1);
    });

    test('gcode:load pads blank and non-string programs with the planner dwell instead of failing', () => {
      const runScenario = (gcode) => {
        const { controller, writes } = setupController();
        const callback = jest.fn();

        controller.command('gcode:load', 'test.nc', gcode, callback);

        return { callback, writes };
      };

      // The handler appends the '%wait' dwell before Sender.load, so the
      // "Invalid G-code" error branch is unreachable for these inputs.
      const blank = runScenario('');
      expect(blank.callback).toHaveBeenCalledWith(null, expect.objectContaining({ name: 'test.nc', total: 1 }));
      expect(blank.writes).toEqual([]);

      const nonString = runScenario(undefined);
      expect(nonString.callback).toHaveBeenCalledWith(null, expect.objectContaining({ name: 'test.nc', total: 2 }));
      expect(nonString.writes).toEqual([]);
    });

    test('gcode:unload clears the sender without writing', () => {
      const { controller, writes } = setupController();

      controller.command('gcode:load', 'test.nc', 'G21\nG90');
      controller.command('gcode:unload');

      expect(data(writes)).toEqual([]);
      expect(controller.sender.state.gcode).toBe('');
      expect(controller.sender.state.name).toBe('');
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
    });

    test('gcode:start sends the first program line with an N-prefixed line number', () => {
      const { controller, writes } = setupController();

      controller.command('gcode:load', 'test.nc', 'G21\nG90');
      controller.command('gcode:start');

      expect(data(writes)).toEqual(['N1G21\n']);
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
      expect(controller.sender.state.sent).toBe(1);
    });

    test('gcode:pause feedholds and reports the queue', () => {
      const { controller, writes } = setupController();

      controller.command('gcode:load', 'test.nc', 'G21\nG90');
      controller.command('gcode:start');
      controller.command('gcode:pause');

      expect(data(writes)).toEqual(['N1G21\n', '!']);
      controller.runner.parse('{"r":{"n":1},"f":[2,0,250]}');
      expect(data(writes)[2]).toBe('{"qr":""}\n');
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_PAUSED);
      expect(controller.sender.state.hold).toBe(true);
    });

    test('gcode:resume resumes the sender before reporting the queue', () => {
      const { controller, writes } = setupController();

      controller.command('gcode:load', 'test.nc', 'G21\nG90');
      controller.command('gcode:start');
      controller.command('gcode:pause');
      controller.command('gcode:resume');

      expect(data(writes)).toEqual(['N1G21\n', '!', '~']);
      expect(controller.sender.state.hold).toBe(false);
      drainFeeder(controller);
      expect(data(writes)).toContain('N2G90\n');
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    });

    test('gcode:stop without force only reports the queue', () => {
      const { controller, writes } = setupController();

      controller.command('gcode:load', 'test.nc', 'G21\nG90');
      controller.command('gcode:start');
      controller.command('gcode:stop');

      expect(data(writes)).toEqual(['N1G21\n']);
      drainFeeder(controller);
      expect(data(writes)[1]).toBe('{"qr":""}\n');
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
    });

    test.each([
      [undefined, ['!', '%']],
      [440.21, ['!', '%']],
      [449.02, ['!', '%']],
      [450.06, ['\x04']],
    ])('gcode:stop with force and firmware build %p kills the job accordingly', (fb, expected) => {
      const { controller, writes } = setupController();

      controller.command('gcode:load', 'test.nc', 'G21\nG90');
      if (fb !== undefined) {
        controller.runner.settings.fb = fb;
      }
      controller.command('gcode:stop', { force: true });

      drainFeeder(controller);
      expect(data(writes)).toEqual(expected);
      expect(controller.transport.suspended).toBe(true);
      controller.command('gcode', 'G1X123');
      expect(data(writes)).toEqual(expected);
    });

    test.each([
      ['start', 'gcode:start'],
      ['stop', 'gcode:stop'],
      ['pause', 'gcode:pause'],
      ['resume', 'gcode:resume'],
    ])('deprecated alias %s writes identically to %s', (alias, canonical) => {
      const runScenario = (cmd) => {
        const { controller, writes } = setupController();
        controller.command('gcode:load', 'test.nc', 'G21\nG90');
        controller.command(cmd);
        return data(writes);
      };

      expect(runScenario(alias)).toEqual(runScenario(canonical));
    });

    test('deprecated aliases log a deprecation warning', () => {
      const output = captureConsoleOutput(() => {
        const { controller } = setupController();
        controller.command('start');
      });

      expect(output).toContain('is deprecated');
    });
  });

  describe('macros and watchdir', () => {
    const macros = [{ id: 'm1', name: 'box.nc', content: 'G21\nG90' }];

    test('macro:run feeds the macro content', () => {
      const { controller, writes } = setupController({ macros });
      const callback = jest.fn();

      controller.command('macro:run', 'm1', {}, callback);
      drainFeeder(controller);

      expect(callback).toHaveBeenCalledWith(null);
      expect(data(writes)).toEqual(['G21\n', 'G90\n']);
    });

    test('macro:run without a matching macro writes nothing and skips the callback', () => {
      const { controller, writes } = setupController({ macros });
      const callback = jest.fn();

      controller.command('macro:run', 'missing', callback);

      expect(callback).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });

    test('macro:load loads the macro into the sender', () => {
      const { controller, writes } = setupController({ macros });
      const callback = jest.fn();

      controller.command('macro:load', 'm1', callback);

      expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ name: 'box.nc', total: 3 }));
      expect(controller.sender.state.gcode).toBe('G21\nG90\n%wait ; Wait for the planner to empty');
      expect(writes).toEqual([]);
    });

    test('macro:load without a matching macro skips the callback', () => {
      const { controller } = setupController({ macros });
      const callback = jest.fn();

      controller.command('macro:load', 'missing', callback);

      expect(callback).not.toHaveBeenCalled();
    });

    test('watchdir:load loads the monitored file into the sender', () => {
      const { controller, writes } = setupController();
      const readFileSpy = jest.spyOn(monitor, 'readFile').mockImplementation((file, callback) => callback(null, 'G21\nG90'));
      const callback = jest.fn();

      controller.command('watchdir:load', 'part.nc', callback);

      expect(readFileSpy).toHaveBeenCalledWith('part.nc', expect.any(Function));
      expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ name: 'part.nc', total: 3 }));
      expect(controller.sender.state.gcode).toBe('G21\nG90\n%wait ; Wait for the planner to empty');
      expect(writes).toEqual([]);
      readFileSpy.mockRestore();
    });

    test('watchdir:load forwards read errors to the callback', () => {
      const { controller } = setupController();
      const readFileSpy = jest.spyOn(monitor, 'readFile').mockImplementation((file, callback) => callback(new Error('boom')));
      const callback = jest.fn();

      controller.command('watchdir:load', 'part.nc', callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].message).toBe('boom');
      readFileSpy.mockRestore();
    });
  });

  describe('tool:change', () => {
    const metricPins = {
      'tool.toolChangeX': 0,
      'tool.toolChangeY': 0,
      'tool.toolChangeZ': 0,
      'tool.toolProbeX': 0,
      'tool.toolProbeY': 0,
      'tool.toolProbeZ': 0,
      'tool.toolProbeCommand': 'G38.2',
      'tool.toolProbeDistance': 1,
      'tool.toolProbeFeedrate': 10,
      'tool.touchPlateHeight': 0,
    };

    test.each([
      [TOOL_CHANGE_POLICY_IGNORE_M6_COMMANDS, 'ignore M6 commands'],
      [TOOL_CHANGE_POLICY_SEND_M6_COMMANDS, 'send M6 commands'],
    ])('metric sequence with policy %i (%s)', (policy) => {
      const { controller, writes } = setupController({
        ...metricPins,
        'tool.toolChangePolicy': policy,
      });
      seedModal(controller, { spindle: 'M5', wcs: 'G54' });

      controller.command('tool:change');
      drainFeeder(controller);

      expect(data(writes)).toEqual(toolChangeWrites({
        changeZ: 'G53 G0 Z0.000',
        changeXY: 'G53 G0 X0.000 Y0.000',
        probeXY: 'G53 G0 X0.000 Y0.000',
        probeZ: 'G53 G0 Z0.000',
        policyLines: [],
      }));
    });

    test('metric sequence with the manual tool change WCS policy probes and offsets the WCS', () => {
      const { controller, writes } = setupController({
        ...metricPins,
        'tool.toolChangePolicy': TOOL_CHANGE_POLICY_MANUAL_TOOL_CHANGE_WCS,
      });
      seedModal(controller, { spindle: 'M5', wcs: 'G54' });

      controller.command('tool:change');
      drainFeeder(controller);

      expect(data(writes)).toEqual(toolChangeWrites({
        changeZ: 'G53 G0 Z0.000',
        changeXY: 'G53 G0 X0.000 Y0.000',
        probeXY: 'G53 G0 X0.000 Y0.000',
        probeZ: 'G53 G0 Z0.000',
        policyLines: ['G91 G38.2 F10 Z-1', 'G10 L20 P1 Z0'],
      }));
    });

    test('metric sequence with the manual tool change TLO policy probes and sets a tool offset', () => {
      const { controller, writes } = setupController({
        ...metricPins,
        'tool.toolChangePolicy': TOOL_CHANGE_POLICY_MANUAL_TOOL_CHANGE_TLO,
      });
      seedModal(controller, { spindle: 'M5', wcs: 'G54' });

      controller.command('tool:change');
      drainFeeder(controller);

      expect(data(writes)).toEqual(toolChangeWrites({
        changeZ: 'G53 G0 Z0.000',
        changeXY: 'G53 G0 X0.000 Y0.000',
        probeXY: 'G53 G0 X0.000 Y0.000',
        probeZ: 'G53 G0 Z0.000',
        policyLines: ['G91 G38.2 F10 Z-1', 'G4 P1', '{tofz:0}'],
      }));
    });

    test('metric sequence with the custom probing policy inserts the configured commands', () => {
      const { controller, writes } = setupController({
        ...metricPins,
        'tool.toolChangePolicy': TOOL_CHANGE_POLICY_MANUAL_TOOL_CHANGE_CUSTOM_PROBING,
        'tool.toolProbeCustomCommands': 'G38.2 Z-5 F25\nG92 Z0',
      });
      seedModal(controller, { spindle: 'M5', wcs: 'G54' });

      controller.command('tool:change');
      drainFeeder(controller);

      expect(data(writes)).toEqual(toolChangeWrites({
        changeZ: 'G53 G0 Z0.000',
        changeXY: 'G53 G0 X0.000 Y0.000',
        probeXY: 'G53 G0 X0.000 Y0.000',
        probeZ: 'G53 G0 Z0.000',
        policyLines: ['G38.2 Z-5 F25', 'G92 Z0'],
      }));
    });

    test('imperial units convert pinned millimeter positions and values', () => {
      const { controller, writes } = setupController({
        'tool.toolChangePolicy': TOOL_CHANGE_POLICY_MANUAL_TOOL_CHANGE_WCS,
        'tool.toolChangeX': 25.4,
        'tool.toolChangeY': 0,
        'tool.toolChangeZ': 25.4,
        'tool.toolProbeX': 0,
        'tool.toolProbeY': 0,
        'tool.toolProbeZ': 0,
        'tool.toolProbeCommand': 'G38.2',
        'tool.toolProbeDistance': 25.4,
        'tool.toolProbeFeedrate': 254,
        'tool.touchPlateHeight': 25.4,
      });
      seedModal(controller, { spindle: 'M5', wcs: 'G54', units: 'G20' });

      controller.command('tool:change');
      drainFeeder(controller);

      expect(data(writes)).toEqual(toolChangeWrites({
        changeZ: 'G53 G0 Z1.0000',
        changeXY: 'G53 G0 X1.0000 Y0.0000',
        probeXY: 'G53 G0 X0.0000 Y0.0000',
        probeZ: 'G53 G0 Z0.0000',
        policyLines: ['G91 G38.2 F10 Z-1', 'G10 L20 P1 Z1'],
      }));
    });
  });

  describe('autolevel', () => {
    test('autolevel:start in test mode emits the exact five-line probe sequence', () => {
      const { controller, writes } = setupController();

      controller.command('autolevel:start', {
        mode: 'test',
        clearanceZ: 5,
        startZ: 1,
        endZ: -1,
        feedrate: 100,
      });
      drainFeeder(controller);

      expect(data(writes)).toEqual([
        'G90\n',
        'G0 Z5\n',
        'G0 Z1\n',
        'G38.2 Z-1 F100\n',
        'G0 Z5\n',
      ]);
    });

    test('autolevel:start in full mode probes a 2x2 grid in row-major order', () => {
      const params = {
        mode: 'full',
        startX: 0,
        endX: 10,
        stepX: 10,
        startY: 0,
        endY: 10,
        stepY: 10,
        clearanceZ: 5,
        startZ: 1,
        endZ: -1,
        feedrate: 100,
      };
      const { controller, writes } = setupController();

      controller.command('autolevel:start', params);
      drainFeeder(controller);

      const point = (x, y, index) => [
        'G90\n',
        'G0 Z5\n',
        `G0 X${x} Y${y}\n`,
        'G0 Z1\n',
        `G38.2 Z-1 F${index === 0 ? 50 : 100}\n`,
        'G0 Z5\n',
      ];
      expect(data(writes)).toEqual([
        ...point(0, 0, 0),
        ...point(10, 0, 1),
        ...point(0, 10, 2),
        ...point(10, 10, 3),
      ]);
      expect(controller.probeState.probePoints).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ]);
      expect(controller.probeState.probedPositions).toEqual([]);
      expect(controller.probeState.config).toEqual({
        startX: 0,
        endX: 10,
        stepX: 10,
        startY: 0,
        endY: 10,
        stepY: 10,
        clearanceZ: 5,
        startZ: 1,
        endZ: -1,
        feedrate: 100,
      });
    });

    test('the probe measurement is stored at the intended grid node with the measured Z', () => {
      const { controller } = setupController();
      controller.probeState.probePoints = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
      controller.runner.state.sr = {
        mpos: { x: 0.000, y: 0.000, z: 0.000 },
        wpos: { x: 0.000, y: 0.000, z: 0.000 },
      };

      // Quantised reports: the commanded nodes (0,0) and (10,0) read back off-node.
      controller.runner.emit('r', { prb: { e: 1, x: 0.001, y: 0.001, z: -1.5 } });
      controller.runner.emit('r', { prb: { e: 1, x: 10.001, y: -0.001, z: -1 } });

      expect(controller.probeState.probedPositions).toEqual([
        { x: 0, y: 0, z: -1.5 },
        { x: 10, y: 0, z: -1 },
      ]);
      expect(controller.probeState.minZ).toBe(-1.5);
      expect(controller.probeState.maxZ).toBe(-1);
    });

    test('autolevel:stop resets the board and clears the probe state', () => {
      const { controller, writes } = setupController();

      controller.command('autolevel:start', {
        mode: 'full',
        startX: 0,
        endX: 10,
        stepX: 10,
        startY: 0,
        endY: 10,
        stepY: 10,
        clearanceZ: 5,
        startZ: 1,
        endZ: -1,
        feedrate: 100,
      });
      controller.command('autolevel:stop');

      expect(data(writes)).toEqual(['G90\n', '\x18']);
      expect(controller.feeder.size()).toBe(0);
      expect(controller.probeState).toEqual({
        probedPositions: [],
        probePoints: [],
        minZ: null,
        maxZ: null,
        config: null,
      });
    });

    test('autolevel:getProbeState reports the current probe state', () => {
      const { controller } = setupController();
      controller.probeState.probedPositions = [{ x: 1, y: 2, z: 3 }];
      const callback = jest.fn();

      controller.command('autolevel:getProbeState', null, callback);

      expect(callback).toHaveBeenCalledWith(null, { state: controller.probeState });
    });

    test('autolevel:loadFromFile parses nine-column probe rows', async () => {
      const { controller } = setupController();
      const file = tempFile('cncjs-tinyg-probe-data.txt');
      fs.writeFileSync(file, '0 0 1 0 0 0 0 0 0\n10 0 -2 0 0 0 0 0 0\n', 'utf8');
      const callback = jest.fn();

      await new Promise((resolve) => {
        controller.command('autolevel:loadFromFile', file, (...args) => {
          callback(...args);
          resolve();
        });
      });

      expect(callback).toHaveBeenCalledTimes(1);
      const [err, payload] = callback.mock.calls[0];
      expect(err).toBeNull();
      expect(payload.success).toBe(true);
      expect(controller.probeState.probedPositions).toEqual([
        { x: 0, y: 0, z: 1 },
        { x: 10, y: 0, z: -2 },
      ]);
      expect(controller.probeState.minZ).toBe(-2);
      expect(controller.probeState.maxZ).toBe(1);
    });

    test('autolevel:loadFromFile reports missing files via the callback', async () => {
      const { controller } = setupController();
      const file = tempFile('cncjs-tinyg-missing-probe-data.txt');
      const callback = jest.fn();

      await new Promise((resolve) => {
        controller.command('autolevel:loadFromFile', file, (...args) => {
          callback(...args);
          resolve();
        });
      });

      expect(callback).toHaveBeenCalledTimes(1);
      const [err, payload] = callback.mock.calls[0];
      expect(err).toContain('ENOENT');
      expect(payload).toEqual({ success: false, state: null });
    });

    test('autolevel:saveToFile writes exactly nine columns per row', async () => {
      const { controller } = setupController();
      controller.probeState.probedPositions = [
        { x: 1, y: 2, z: 3 },
        { x: 4, y: 5, z: 6 },
      ];
      const file = tempFile('cncjs-tinyg-probe-save.txt');
      const callback = jest.fn();

      await new Promise((resolve) => {
        controller.command('autolevel:saveToFile', file, (...args) => {
          callback(...args);
          resolve();
        });
      });

      expect(callback).toHaveBeenCalledWith(null, { success: true, filepath: file });
      expect(fs.readFileSync(file, 'utf8')).toBe('1 2 3 0 0 0 0 0 0\n4 5 6 0 0 0 0 0 0');
    });

    test('autolevel:applyProbeCompensation returns the compensated gcode via the callback', () => {
      const { controller } = setupController();
      const callback = jest.fn();
      const probeData = [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 0, y: 10, z: 0 },
        { x: 10, y: 10, z: 0 },
      ];

      controller.command('autolevel:applyProbeCompensation', { gcode: 'M5\nG90', probeData }, callback);

      expect(callback).toHaveBeenCalledWith(null, { compensatedGcode: 'M5\nG90' });
    });
  });

  describe('connect-time setup', () => {
    test('sends each setup command only after the reply to the previous one', async () => {
      const { controller, writes } = setupController();
      const stats = respondToWrites(controller, writes, line => {
        if (line === '{fb:n}') {
          return '{"r":{"fb":440.21},"f":[1,0,5]}';
        }
        return line === '{stat:n}' ? '{"r":{"stat":1},"f":[1,0,5]}' : '{"r":{},"f":[1,0,5]}';
      });

      await controller.initController();

      expect(data(writes).map((line) => line.trim())).toEqual(setupCommands);
      expect(stats.maxOutstanding).toBe(1);
    });

    test('a command without a reply stops setup until reconnect', async () => {
      const { controller, writes } = setupController();
      respondToWrites(controller, writes, line => {
        if (line === '{fb:n}') {
          return '{"r":{"fb":440.21},"f":[1,0,5]}';
        }
        if (line === '{spe:n}') {
          return null;
        }
        return line === '{stat:n}' ? '{"r":{"stat":1},"f":[1,0,5]}' : '{"r":{},"f":[1,0,5]}';
      });

      await controller.initController();

      expect(data(writes).map(line => line.trim())).toEqual(setupCommands.slice(0, 9));
      expect(controller.ready).toBe(false);
      expect(controller.transport.failed).toBe(true);
    });

    // In ALARM a SET is answered with status 204 (newer firmware) and a GET still works.
    const alarmReply = (board) => (line) => {
      if (line === '{fb:n}') {
        return '{"r":{"fb":440.21},"f":[1,0,5]}';
      }
      if (line === '{stat:n}') {
        return `{"r":{"stat":${board.stat}},"f":[1,0,6]}`;
      }
      const isSet = !/:n}$/.test(line);
      return `{"r":{},"f":[1,${(isSet && board.stat === 2) ? 204 : 0},5]}`;
    };

    test('settings rejected in ALARM are applied again after the alarm is cleared, without clearing it', async () => {
      const { controller, writes, events } = setupController();
      const board = { stat: 2 };
      respondToWrites(controller, writes, alarmReply(board));
      const trigger = jest.spyOn(controller.event, 'trigger');

      await controller.initController();

      expect(controller.setup.rejected).toBe(true);
      expect(events.some((entry) => entry.event === 'serialport:read' && /observation-only/.test(entry.args[0]))).toBe(true);
      expect(data(writes).some((line) => /clear/.test(line))).toBe(false);
      expect(trigger).not.toHaveBeenCalledWith('controller:ready');

      // Still in ALARM: nothing is sent
      const sentInAlarm = writes.length;
      controller.runner.parse('{"sr":{"stat":2}}');
      expect(writes).toHaveLength(sentInAlarm);

      // The user clears the alarm: the setup runs again
      const initController = jest.spyOn(controller, 'initController');
      trigger.mockClear();
      board.stat = 1;
      controller.runner.parse('{"sr":{"stat":1}}');
      expect(initController).toHaveBeenCalledWith({ reapply: true });
      await initController.mock.results[0].value;

      expect(data(writes).slice(sentInAlarm).map((line) => line.trim())).toEqual(setupCommands);
      expect(controller.setup.rejected).toBe(false);
      expect(trigger).not.toHaveBeenCalledWith('controller:ready');
    });

    test('settings ignored in ALARM without an error status (build 449) are detected from the machine state', async () => {
      const { controller, writes } = setupController();
      respondToWrites(controller, writes, line => {
        if (line === '{fb:n}') {
          return '{"r":{"fb":449.02},"f":[1,0,5]}';
        }
        return line === '{stat:n}' ? '{"r":{"stat":2},"f":[1,0,6]}' : '{"r":{},"f":[1,0,5]}';
      });

      await controller.initController();

      expect(controller.setup.rejected).toBe(true);
    });

    test('a board that is not in ALARM is not set up again', async () => {
      const { controller, writes } = setupController();
      respondToWrites(controller, writes, alarmReply({ stat: 1 }));

      await controller.initController();
      const count = writes.length;
      controller.runner.parse('{"sr":{"stat":3}}');

      expect(controller.setup.rejected).toBe(false);
      expect(writes).toHaveLength(count);
    });
  });

  describe('recovery and state-preserving attachment', () => {
    test('asynchronous driver error quarantines queued writes through SerialConnection', async () => {
      const { controller, writes } = setupController();
      const connection = new SerialConnection({ path: controller.options.port });
      const driver = new EventEmitter();
      driver.isOpen = true;
      driver.write = data => writes.push({ data });
      driver.on('error', connection.eventListener.error);
      connection.port = driver;
      connection.on('error', controller.connectionEventListener.error);
      connection.on('data', controller.connectionEventListener.data);
      controller.connection = connection;
      controller.transport.lineMode = true;
      controller.transport.slots = 12;
      controller.transport.enqueue('N1' + 'X'.repeat(150), { n: 1 });
      controller.transport.enqueue('N2G1X2', { n: 2 });
      expect(controller.transport.pending).toHaveLength(1);
      await new Promise(resolve => setImmediate(() => {
        driver.emit('error', new Error('asynchronous USB write failure'));
        resolve();
      }));
      expect(controller.ready).toBe(false);
      expect(controller.observationOnly).toBe(true);
      expect(controller.transport.suspended).toBe(true);
      expect(controller.transport.pending).toHaveLength(0);
      connection.eventListener.data('{"r":{"n":1},"f":[3,0,12]}');
      controller.transport.pump();
      controller.write('G1X3\n');
      expect(writes).toHaveLength(1);
      await controller.initController();
      expect(writes).toHaveLength(1); // setup/reopen cannot erase the failed epoch
    });

    test('startup during the final setup delay cannot restore readiness', async () => {
      const { controller, writes } = setupController();
      const trigger = jest.spyOn(controller.event, 'trigger');
      respondToWrites(controller, writes, line => {
        if (line === '{fb:n}') {
          return '{"r":{"fb":440.21},"f":[2,0,250]}';
        }
        if (line === '{stat:n}') {
          return '{"r":{"stat":1},"f":[2,0,250]}';
        }
        if (line === '{sr:n}') {
          setTimeout(() => controller.runner.parse('{"sr":{"fb":440.21,"msg":"SYSTEM READY"}}'), 10);
        }
        return '{"r":{},"f":[2,0,250]}';
      });
      await controller.initController();
      expect(controller.ready).toBe(false);
      expect(controller.observationOnly).toBe(true);
      expect(trigger).not.toHaveBeenCalledWith('controller:ready');
    });

    test.each([5, 6])('running/held state %s receives only read-only discovery', async stat => {
      const { controller, writes } = setupController();
      respondToWrites(controller, writes, line => (line === '{fb:n}'
        ? '{"r":{"fb":450.06},"f":[3,0,12]}'
        : JSON.stringify({ r: { stat }, f: [3, 0, 12] })));
      await controller.initController();
      expect(data(writes)).toEqual(['{fb:n}\n', '{stat:n}\n']);
      expect(controller.ready).toBe(false);
      controller.command('gcode', 'G1X9');
      controller.write('G1X9\n');
      expect(writes).toHaveLength(2);
    });

    test('controller recreation cannot bypass recovery-required state', async () => {
      const { controller } = setupController();
      const port = controller.options.port;
      controller.command('reset');
      const second = createController(TinyGController, { port });
      controllers.push(second.controller);
      await second.controller.initController();
      second.controller.command('gcode', 'G1X99');
      expect(second.writes).toHaveLength(0);
      expect(second.controller.transport.suspended).toBe(true);
    });

    test('explicit modern Reset orders output, requires startup and a fresh matching probe', () => {
      const { controller, writes } = setupController();
      controller.runner.settings.fb = 450.06;
      const drains = [];
      controller.connection.port = { drain: callback => drains.push(callback) };
      const init = jest.spyOn(controller, 'initController').mockImplementation(() => {});
      controller.command('gcode', 'G1X1');
      controller.command('reset');
      controller.command('gcode', 'G1X2');
      expect(data(writes)).toEqual(['G1X1\n']);
      drains.shift()(null);
      expect(data(writes)).toEqual(['G1X1\n', '\x18']);
      controller.runner.parse('{"sr":{"fb":450.06,"msg":"SYSTEM READY"}}');
      expect(writes).toHaveLength(2);
      drains.shift()(null);
      const probe = JSON.parse(data(writes)[2]);
      expect(probe).toMatchObject({ fb: null, stat: null });
      controller.runner.parse(JSON.stringify({ tid: probe.tid + 1, r: { fb: 450.06, stat: 1 }, f: [3, 0, 12] }));
      expect(init).not.toHaveBeenCalled();
      expect(controller.transport.suspended).toBe(true);
      controller.runner.parse(JSON.stringify({ tid: probe.tid, r: { fb: 450.06, stat: 1 }, f: [3, 0, 12] }));
      expect(init).toHaveBeenCalledTimes(1);
      expect(controller.transport.suspended).toBe(false);
    });
  });

  describe('line mode', () => {
    const program = Array.from({ length: 20 }, (v, i) => `G1 X${i}`).join('\n');

    // An idle board with firmware build `fb`; once {rxm:1} is set, every footer reports `free` line slots
    const boardReply = ({ fb = 450.02, rxm = 0 }) => {
      const board = { rxm, free: 10 };
      const footer = (status = 0) => (board.rxm ? `[3,${status},${board.free}]` : `[1,${status},5]`);
      return (line) => {
        if (line === '{fb:n}') {
          return `{"r":{"fb":${fb}},"f":${footer()}}`;
        }
        if (line === '{sys:n}') {
          return `{"r":{"sys":{"fb":${fb},"fv":0.97}},"f":${footer()}}`;
        }
        if (line === '{rxm:1}') {
          board.rxm = 1;
          return `{"r":{"rxm":1},"f":${footer()}}`;
        }
        if (line === '{rx:n}') {
          return `{"r":{"rx":${board.free}},"f":${footer()}}`;
        }
        if (line === '{stat:n}') {
          return `{"r":{"stat":1},"f":${footer()}}`;
        }
        return `{"r":{},"f":${footer()}}`;
      };
    };

    const connect = async (controller, writes, options = {}) => {
      respondToWrites(controller, writes, boardReply(options));
      await controller.initController();
      // From here on the test answers the program lines itself
      controller.connection.write = (data) => writes.push({ data });
      writes.length = 0;
    };

    const respond = (controller, n, free, status = 0) => {
      controller.runner.parse(`{"r":{"n":${n}},"f":[3,${status},${free}]}`);
    };

    test.each([
      [440.21, false],
      [445.99, false],
      [446.01, false],
      [449.01, false],
      [450.01, false],
      [450.02, true],
      [450.06, true],
      [101.02, false], // g2core
    ])('firmware build %p enables line mode: %p', async (fb, enabled) => {
      const { controller, writes } = setupController();
      respondToWrites(controller, writes, boardReply({ fb }));

      await controller.initController();

      const lines = data(writes).map((line) => line.trim());
      expect(lines.includes('{rxm:1}')).toBe(enabled);
      expect(lines.includes('{rx:n}')).toBe(enabled);
      expect(controller.lineMode).toBe(enabled);
      const report = lines.find(line => line.startsWith('{sr:{'));
      expect(report).not.toMatch(/tofx|admo/);
      expect((report.match(/:t/g) || []).length).toBeLessThanOrEqual(30);
      if (fb >= 450.06) {
        expect(report).toContain('sse:t');
        expect(report).toContain('ssc:t');
      }
      expect(controller.sender.sp.type).toBe(enabled ? SP_TYPE_LINE_COUNTING : SP_TYPE_SEND_RESPONSE);
      if (enabled) {
        expect(controller.sender.sp.freeSlots).toBe(10);
        expect(lines.indexOf('{rxm:1}')).toBeGreaterThan(lines.indexOf('{sys:n}'));
      }
    });

    test('line mode is not enabled when the setting turns it off', async () => {
      const { controller, writes } = setupController({ 'state.controller.tinyg.lineMode': false });
      respondToWrites(controller, writes, boardReply({ fb: 449.01 }));

      await controller.initController();

      expect(data(writes).map((line) => line.trim())).toEqual(setupCommands);
      expect(controller.lineMode).toBe(false);
      expect(controller.sender.sp.type).toBe(SP_TYPE_SEND_RESPONSE);
    });

    test('line mode is not enabled when the board rejects {rxm:1}', async () => {
      const { controller, writes } = setupController();
      const reply = boardReply({ fb: 449.01 });
      respondToWrites(controller, writes, (line) => ((line === '{rxm:1}') ? '{"r":{},"f":[1,204,5]}' : reply(line)));

      await controller.initController();

      expect(controller.lineMode).toBe(false);
      expect(controller.sender.sp.type).toBe(SP_TYPE_SEND_RESPONSE);
    });

    test('a connection closed during the setup ends it quietly', async () => {
      const { controller, writes } = setupController();
      const reply = boardReply({ fb: 449.01 });
      respondToWrites(controller, writes, (line) => {
        if (line === '{sys:n}') {
          controller.destroy();
        }
        return reply(line);
      });

      await expect(controller.initController()).resolves.toBeUndefined();
      expect(data(writes).map((line) => line.trim()).pop()).toBe('{sys:n}');
    });

    test('streams several lines in flight, paced by the free line slots in each response footer', async () => {
      const { controller, writes } = setupController();
      await connect(controller, writes);

      controller.command('gcode:load', 'test.nc', program);
      controller.command('gcode:start');

      // 10 free slots, 2 kept for control commands
      expect(data(writes)).toEqual(Array.from({ length: 8 }, (v, i) => `N${i + 1}G1X${i}\n`));

      // The board is filling up: 4 free slots, 7 lines in flight
      respond(controller, 1, 4);
      expect(writes).toHaveLength(8);

      // The board has caught up: 10 free slots, 6 lines in flight
      respond(controller, 2, 10);
      expect(data(writes).slice(8)).toEqual(['N9G1X8\n', 'N10G1X9\n']);
      expect(controller.sender.state.received).toBe(2);
      expect(controller.sender.state.sent).toBe(10);

      // Queue reports do not block acknowledgements in line mode
      controller.runner.parse('{"qr":3}');
      expect(controller.sender.state.received).toBe(2);
      respond(controller, 3, 10);
      expect(controller.sender.state.received).toBe(3);
      expect(writes).toHaveLength(11);
    });

    test('finishes a line-mode job with XON/XOFF inside a reply and interleaved queue reports', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'setTimeout', 'clearTimeout'] });
      try {
        const { controller, writes } = setupController();
        await connect(controller, writes);
        controller.ready = true; // The serial connection helper bypasses open().
        const lines = Array.from({ length: 110 }, (v, i) => (
          [0, 49, 99].includes(i) ? '(comment only)' : `G1 X${i % 20}`
        ));
        controller.command('gcode:load', 'flow-control.nc', lines.join('\n'));
        controller.command('gcode:start');
        let capturedReply = false;

        // Answer only lines actually sent, including the trailing wait once it is released.
        for (let i = 0; i < writes.length; i++) {
          const n = Number(data(writes)[i].match(/^N(\d+)/)[1]);
          controller.connectionEventListener.data('{"qr":23}');
          if (n === 104) {
            capturedReply = true;
            controller.connectionEventListener.data('\x13{"r":{"n":104},"f":\x11[3,0,9]}');
          } else {
            controller.connectionEventListener.data(`{"r":{"n":${n}},"f":[3,0,10]}`);
          }
        }

        expect(capturedReply).toBe(true);
        expect(data(writes).pop()).toBe('N111G4P0.5\n');
        expect(writes).toHaveLength(108); // 110 input lines - 3 comments + final wait
        expect(controller.sender.state.received).toBe(controller.sender.state.total);
        expect(controller.actionTime.senderFinishTime).toBeGreaterThan(0);
        controller.connectionEventListener.data('{"sr":{"stat":3}}');
        jest.advanceTimersByTime(1000);
        expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
      } finally {
        jest.useRealTimers();
      }
    });

    test('a character mode footer falls back to one line at a time', async () => {
      const { controller, writes } = setupController();
      await connect(controller, writes);
      controller.runner.parse('{"r":{},"f":[2,0,25]}');

      controller.command('gcode:load', 'test.nc', program);
      controller.command('gcode:start');
      expect(writes).toHaveLength(1);

      controller.runner.parse('{"r":{"n":1},"f":[2,0,9]}');
      expect(writes).toHaveLength(2);
    });

    test('an error pauses the program, sends nothing past it and reports the failed line', async () => {
      const { controller, writes, events } = setupController();
      await connect(controller, writes);

      controller.command('gcode:load', 'test.nc', program);
      controller.command('gcode:start');
      respond(controller, 1, 10);
      expect(writes).toHaveLength(9);

      respond(controller, 2, 10, 108);

      expect(writes).toHaveLength(9);
      expect(controller.workflow.state).toBe(WORKFLOW_STATE_PAUSED);
      const reads = events.filter((entry) => entry.event === 'serialport:read').map((entry) => entry.args[0]);
      expect(reads).toContain('> G1 X1 (ln=3)');
    });

    test('pause holds the sender while the lines in flight are answered, and resume refills the board', async () => {
      const { controller, writes } = setupController();
      await connect(controller, writes);

      controller.command('gcode:load', 'test.nc', program);
      controller.command('gcode:start');
      controller.command('gcode:pause');
      expect(data(writes).slice(8)).toEqual(['!', '{"qr":""}\n']);

      for (let n = 1; n <= 8; n++) {
        respond(controller, n, 10);
      }
      expect(writes).toHaveLength(10);
      expect(controller.sender.state.received).toBe(8);

      controller.runner.parse('{"r":{"qr":28},"f":[3,0,10]}');
      controller.command('gcode:resume');
      expect(data(writes).slice(10)).toEqual([
        '~',
        ...Array.from({ length: 8 }, (v, i) => `N${i + 9}G1X${i + 8}\n`),
        '{"qr":""}\n',
      ]);
    });

    test('a program runs to completion with every line answered', async () => {
      const { controller, writes } = setupController();
      await connect(controller, writes);

      controller.command('gcode:load', 'test.nc', program);
      controller.command('gcode:start');
      for (let n = 1; n <= 20; n++) {
        respond(controller, n, 10);
      }

      // The trailing %wait is sent on its own once every program line is answered
      expect(data(writes)[20]).toBe('N21G4P0.5\n');
      expect(writes).toHaveLength(21);
      respond(controller, 21, 10);
      controller.runner.parse('{"qr":28}');
      expect(controller.sender.state.received).toBe(controller.sender.state.total);
    });
  });

  describe('negative cases', () => {
    test('unknown command writes nothing', () => {
      const { controller, writes } = setupController();

      controller.command('nonexistent');

      expect(writes).toEqual([]);
    });

    test('a closed connection suppresses client and feeder writes', () => {
      const { controller, writes } = setupController();
      controller.connection.isOpen = false;

      controller.command('feedhold');
      controller.command('gcode', 'G21\nG90');
      controller.command('homing');

      expect(writes).toEqual([]);
    });
  });
});
