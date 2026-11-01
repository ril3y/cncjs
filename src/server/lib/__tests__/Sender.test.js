/* eslint-env jest */
import fs from 'fs';
import path from 'path';
import Sender, {
  SP_TYPE_SEND_RESPONSE,
  SP_TYPE_CHAR_COUNTING,
  SP_TYPE_LINE_COUNTING
} from '../Sender';

describe('Sender', () => {
  describe('null streaming protocol', () => {
    test('should create sender with null protocol', () => {
      const sender = new Sender(null);
      expect(sender.sp).toEqual(null);
    });
  });

  describe('send-response streaming protocol', () => {
    test('should process G-code file', () => {
      return new Promise((resolve) => {
        const sender = new Sender(SP_TYPE_SEND_RESPONSE);
        expect(sender.sp.type).toEqual(SP_TYPE_SEND_RESPONSE);

        const file = path.resolve(__dirname, '__fixtures__/jsdc.gcode');
        const content = fs.readFileSync(file, 'utf8');
        const context = {
          xmin: 0,
          xmax: 100,
          ymin: 0,
          ymax: 100,
          zmin: -2,
          zmax: 50
        };
        const ok = sender.load(path.basename(file), content, context);
        expect(ok).toEqual(true);

        expect(sender.toJSON()).toEqual({
          sp: SP_TYPE_SEND_RESPONSE,
          hold: false,
          holdReason: null,
          name: path.basename(file),
          context: context,
          size: sender.state.gcode.length,
          total: sender.state.total,
          sent: 0,
          received: 0,
          startTime: sender.state.startTime,
          finishTime: sender.state.finishTime,
          elapsedTime: sender.state.elapsedTime,
          remainingTime: sender.state.remainingTime
        });

        sender.on('data', () => {
          sender.ack();
        });

        sender.on('end', () => {
          expect(sender.toJSON()).toEqual({
            sp: SP_TYPE_SEND_RESPONSE,
            hold: false,
            holdReason: null,
            name: path.basename(file),
            context: context,
            size: sender.state.gcode.length,
            total: sender.state.total,
            sent: sender.state.sent,
            received: sender.state.received,
            startTime: sender.state.startTime,
            finishTime: sender.state.finishTime,
            elapsedTime: sender.state.elapsedTime,
            remainingTime: sender.state.remainingTime
          });

          sender.unload();

          expect(sender.sp.type).toEqual(SP_TYPE_SEND_RESPONSE);
          expect(sender.state).toEqual({
            name: '',
            hold: false,
            holdReason: null,
            context: {},
            gcode: '',
            lines: [],
            total: 0,
            sent: 0,
            received: 0,
            startTime: 0,
            finishTime: 0,
            elapsedTime: 0,
            remainingTime: 0
          });
          expect(sender.toJSON()).toEqual({
            sp: SP_TYPE_SEND_RESPONSE,
            hold: false,
            holdReason: null,
            name: '',
            context: {},
            size: 0,
            total: 0,
            sent: 0,
            received: 0,
            startTime: 0,
            finishTime: 0,
            elapsedTime: 0,
            remainingTime: 0
          });

          resolve();
        });

        while (sender.state.sent < sender.state.total) {
          sender.next();
        }
      });
    });
  });

  describe('character-counting streaming protocol', () => {
    test('should process G-code file with buffer management', () => {
      return new Promise((resolve) => {
        const sender = new Sender(SP_TYPE_CHAR_COUNTING, {
        bufferSize: 256
      });
      expect(sender.sp.type).toEqual(SP_TYPE_CHAR_COUNTING);

      // Validation
      sender.sp.bufferSize = 0;
      expect(sender.sp.bufferSize).toEqual(256);
      sender.sp.bufferSize = 128;
      expect(sender.sp.bufferSize).toEqual(128);
      sender.sp.dataLength = 120;
      sender.sp.bufferSize = 100;
      expect(sender.sp.bufferSize).toEqual(120); // Cannot reduce below data length
      sender.sp.clear();
      sender.sp.bufferSize = 256;
      expect(sender.sp.bufferSize).toEqual(256);
      expect(sender.sp.dataLength).toEqual(0);
      expect(sender.sp.queue.length).toEqual(0);
      expect(sender.sp.line).toEqual('');

      const file = path.resolve(__dirname, '__fixtures__/jsdc.gcode');
      const content = fs.readFileSync(file, 'utf8');
      const context = {
        xmin: 0,
        xmax: 100,
        ymin: 0,
        ymax: 100,
        zmin: -2,
        zmax: 50
      };
      const ok = sender.load(path.basename(file), content, context);
      expect(ok).toEqual(true);

      expect(sender.toJSON()).toEqual({
        sp: SP_TYPE_CHAR_COUNTING,
        hold: false,
        holdReason: null,
        name: path.basename(file),
        context: context,
        size: sender.state.gcode.length,
        total: sender.state.total,
        sent: 0,
        received: 0,
        startTime: sender.state.startTime,
        finishTime: sender.state.finishTime,
        elapsedTime: sender.state.elapsedTime,
        remainingTime: sender.state.remainingTime
      });

      sender.on('data', () => {
        sender.ack();
      });

      sender.on('end', () => {
        expect(sender.toJSON()).toEqual({
          sp: SP_TYPE_CHAR_COUNTING,
          hold: false,
          holdReason: null,
          name: path.basename(file),
          context: context,
          size: sender.state.gcode.length,
          total: sender.state.total,
          sent: sender.state.sent,
          received: sender.state.received,
          startTime: sender.state.startTime,
          finishTime: sender.state.finishTime,
          elapsedTime: sender.state.elapsedTime,
          remainingTime: sender.state.remainingTime
        });

        sender.unload();

        expect(sender.sp.type).toEqual(SP_TYPE_CHAR_COUNTING);
        expect(sender.state).toEqual({
          hold: false,
          holdReason: null,
          name: '',
          gcode: '',
          context: {},
          lines: [],
          total: 0,
          sent: 0,
          received: 0,
          startTime: 0,
          finishTime: 0,
          elapsedTime: 0,
          remainingTime: 0
        });
        expect(sender.toJSON()).toEqual({
          sp: SP_TYPE_CHAR_COUNTING,
          hold: false,
          holdReason: null,
          name: '',
          context: {},
          size: 0,
          total: 0,
          sent: 0,
          received: 0,
          startTime: 0,
          finishTime: 0,
          elapsedTime: 0,
          remainingTime: 0
        });

        resolve();
      });

      while (sender.state.sent < sender.state.total) {
        sender.next();
      }
      });
    });
  });

  describe('line-counting streaming protocol', () => {
    const inflight = (sender) => sender.state.sent - sender.state.received;

    test('should default to a reserve of 2 and coerce the free slots to a number', () => {
      const sender = new Sender(SP_TYPE_LINE_COUNTING);
      expect(sender.sp.type).toEqual(SP_TYPE_LINE_COUNTING);
      expect(sender.sp.reserve).toEqual(2);
      expect(sender.sp.freeSlots).toEqual(0);
      sender.sp.freeSlots = 'abc';
      expect(sender.sp.freeSlots).toEqual(0);
      sender.sp.freeSlots = 7;
      expect(sender.sp.freeSlots).toEqual(7);
      expect(new Sender(SP_TYPE_LINE_COUNTING, { reserve: 1 }).sp.reserve).toEqual(1);
    });

    test('should switch the streaming protocol and keep the loaded program', () => {
      const sender = new Sender(SP_TYPE_SEND_RESPONSE);
      const lines = [];
      sender.on('data', (line) => lines.push(line));
      sender.load('test.nc', 'G0 X1\nG0 X2\nG0 X3\nG0 X4');
      sender.next();

      sender.setStreamingProtocol(SP_TYPE_LINE_COUNTING, { reserve: 1 });
      expect(sender.sp.type).toEqual(SP_TYPE_LINE_COUNTING);
      expect(sender.sp.reserve).toEqual(1);
      sender.sp.freeSlots = 4;
      sender.ack();
      sender.next();
      expect(lines).toEqual(['G0 X1\n', 'G0 X2\n', 'G0 X3\n', 'G0 X4\n']);

      sender.setStreamingProtocol(null);
      expect(sender.sp).toEqual(null);
    });

    test('should send one line at a time when no free slots are reported', () => {
      const sender = new Sender(SP_TYPE_LINE_COUNTING);
      const lines = [];
      sender.on('data', (line) => lines.push(line));
      sender.load('test.nc', 'G0 X1\nG0 X2\nG0 X3');

      sender.next();
      expect(lines).toEqual(['G0 X1\n']);
      sender.next();
      expect(lines).toEqual(['G0 X1\n']);

      sender.ack();
      sender.next();
      expect(lines).toEqual(['G0 X1\n', 'G0 X2\n']);
    });

    test('should keep lines in flight while the free slots less the lines in flight exceed the reserve', () => {
      const sender = new Sender(SP_TYPE_LINE_COUNTING);
      const lines = [];
      sender.on('data', (line) => lines.push(line));
      sender.load('test.nc', Array.from({ length: 20 }, (v, i) => `G1 X${i}`).join('\n'));

      sender.sp.freeSlots = 10;
      sender.next();
      expect(lines).toHaveLength(8); // 10 - 8 = 2 slots left for control commands

      // A response whose footer reports 3 free slots: 3 - 7 in flight leaves no room
      sender.sp.freeSlots = 3;
      sender.ack();
      sender.next();
      expect(lines).toHaveLength(8);

      // The board has caught up: 6 in flight, so 2 more lines go out
      sender.sp.freeSlots = 10;
      sender.ack();
      sender.next();
      expect(inflight(sender)).toEqual(8);
      expect(lines).toHaveLength(10);
    });

    test('should stream a G-code file to a board that reports its free line slots in each response footer', () => {
      return new Promise((resolve) => {
        const slots = 10; // free line slots reported by an idle board
        const sender = new Sender(SP_TYPE_LINE_COUNTING);
        const board = []; // lines received by the board and not answered yet
        let maxInflight = 0;

        const file = path.resolve(__dirname, '__fixtures__/jsdc.gcode');
        const content = fs.readFileSync(file, 'utf8');
        sender.load(path.basename(file), content);

        sender.on('data', (line) => {
          const inflightBefore = inflight(sender) - 1;
          expect((inflightBefore === 0) || (sender.sp.freeSlots - inflightBefore > sender.sp.reserve)).toBe(true);
          maxInflight = Math.max(maxInflight, inflightBefore + 1);
          board.push(line);
        });

        sender.on('end', () => {
          expect(sender.state.sent).toEqual(sender.state.total);
          expect(sender.state.received).toEqual(sender.state.total);
          expect(maxInflight).toEqual(slots - sender.sp.reserve);
          resolve();
        });

        sender.sp.freeSlots = slots;
        sender.next();
        while (board.length > 0) {
          board.shift(); // the board processes a line and replies with {"r":{...},"f":[3,0,free]}
          sender.sp.freeSlots = slots - board.length;
          sender.ack();
          sender.next();
        }
      });
    });

    test('should evaluate built-in commands and expressions only when every line sent before them is answered', () => {
      const filtered = [];
      const sender = new Sender(SP_TYPE_LINE_COUNTING, {
        dataFilter: (line, context) => {
          filtered.push(line);
          if (line[0] === '%') {
            return '';
          }
          return line.replace('[_x]', '5');
        }
      });
      const lines = [];
      sender.on('data', (line) => lines.push(line));
      sender.load('test.nc', 'G0 X1\nG0 X2\n%_x=posx\nG0 X[_x]\nG0 X3');

      sender.sp.freeSlots = 10;
      sender.next();
      expect(filtered).toEqual(['G0 X1', 'G0 X2']);

      sender.ack();
      sender.next();
      expect(filtered).toEqual(['G0 X1', 'G0 X2']);

      sender.ack();
      sender.next();
      expect(filtered).toEqual(['G0 X1', 'G0 X2', '%_x=posx', 'G0 X[_x]', 'G0 X3']);
      expect(lines).toEqual(['G0 X1\n', 'G0 X2\n', 'G0 X5\n', 'G0 X3\n']);
      expect(inflight(sender)).toEqual(2);
    });

    test('should stop sending on hold and ack lines that are filtered out', () => {
      const sender = new Sender(SP_TYPE_LINE_COUNTING, {
        dataFilter: (line) => {
          if (line === 'M0') {
            sender.hold({ data: 'M0' });
          }
          return line.replace(/\(.*\)/, '');
        }
      });
      const lines = [];
      sender.on('data', (line) => lines.push(line));
      sender.load('test.nc', 'G0 X1\n(comment)\nM0\nG0 X2');

      sender.sp.freeSlots = 10;
      sender.next();
      expect(lines).toEqual(['G0 X1\n', 'M0\n']);
      expect(sender.state.sent).toEqual(3);
      expect(inflight(sender)).toEqual(2);

      sender.unhold();
      sender.next();
      expect(lines).toEqual(['G0 X1\n', 'M0\n', 'G0 X2\n']);
    });
  });
});
