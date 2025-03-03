'use strict';

const assert = require('assert');
const fixtures = require('../common/fixtures');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const events = require('events');
const os = require('os');
const { inspect } = require('util');
const { Worker } = require('worker_threads');

const workerPath = path.join(__dirname, 'wpt/worker.js');

function getBrowserProperties() {
  const { node: version } = process.versions; // e.g. 18.13.0, 20.0.0-nightly202302078e6e215481
  const release = /^\d+\.\d+\.\d+$/.test(version);
  const browser = {
    browser_channel: release ? 'stable' : 'experimental',
    browser_version: version,
  };

  return browser;
}

/**
 * Return one of three expected values
 * https://github.com/web-platform-tests/wpt/blob/1c6ff12/tools/wptrunner/wptrunner/tests/test_update.py#L953-L958
 */
function getOs() {
  switch (os.type()) {
    case 'Linux':
      return 'linux';
    case 'Darwin':
      return 'mac';
    case 'Windows_NT':
      return 'win';
    default:
      throw new Error('Unsupported os.type()');
  }
}

// https://github.com/web-platform-tests/wpt/blob/b24eedd/resources/testharness.js#L3705
function sanitizeUnpairedSurrogates(str) {
  return str.replace(
    /([\ud800-\udbff]+)(?![\udc00-\udfff])|(^|[^\ud800-\udbff])([\udc00-\udfff]+)/g,
    function(_, low, prefix, high) {
      let output = prefix || '';  // Prefix may be undefined
      const string = low || high;  // Only one of these alternates can match
      for (let i = 0; i < string.length; i++) {
        output += codeUnitStr(string[i]);
      }
      return output;
    });
}

function codeUnitStr(char) {
  return 'U+' + char.charCodeAt(0).toString(16);
}

class WPTReport {
  constructor(path) {
    this.filename = `report-${path.replaceAll('/', '-')}.json`;
    this.results = [];
    this.time_start = Date.now();
  }

  addResult(name, status) {
    const result = {
      test: name,
      status,
      subtests: [],
      addSubtest(name, status, message) {
        const subtest = {
          status,
          // https://github.com/web-platform-tests/wpt/blob/b24eedd/resources/testharness.js#L3722
          name: sanitizeUnpairedSurrogates(name),
        };
        if (message) {
          // https://github.com/web-platform-tests/wpt/blob/b24eedd/resources/testharness.js#L4506
          subtest.message = sanitizeUnpairedSurrogates(message);
        }
        this.subtests.push(subtest);
        return subtest;
      },
    };
    this.results.push(result);
    return result;
  }

  write() {
    this.time_end = Date.now();
    this.results = this.results.filter((result) => {
      return result.status === 'SKIP' || result.subtests.length !== 0;
    }).map((result) => {
      const url = new URL(result.test, 'http://wpt');
      url.pathname = url.pathname.replace(/\.js$/, '.html');
      result.test = url.href.slice(url.origin.length);
      return result;
    });

    /**
     * Return required and some optional properties
     * https://github.com/web-platform-tests/wpt.fyi/blob/60da175/api/README.md?plain=1#L331-L335
     */
    this.run_info = {
      product: 'node.js',
      ...getBrowserProperties(),
      revision: process.env.WPT_REVISION || 'unknown',
      os: getOs(),
    };

    fs.writeFileSync(`out/wpt/${this.filename}`, JSON.stringify(this));
  }
}

// https://github.com/web-platform-tests/wpt/blob/HEAD/resources/testharness.js
// TODO: get rid of this half-baked harness in favor of the one
// pulled from WPT
const harnessMock = {
  test: (fn, desc) => {
    try {
      fn();
    } catch (err) {
      console.error(`In ${desc}:`);
      throw err;
    }
  },
  assert_equals: assert.strictEqual,
  assert_true: (value, message) => assert.strictEqual(value, true, message),
  assert_false: (value, message) => assert.strictEqual(value, false, message),
  assert_throws: (code, func, desc) => {
    assert.throws(func, function(err) {
      return typeof err === 'object' &&
             'name' in err &&
             err.name.startsWith(code.name);
    }, desc);
  },
  assert_array_equals: assert.deepStrictEqual,
  assert_unreached(desc) {
    assert.fail(`Reached unreachable code: ${desc}`);
  },
};

class ResourceLoader {
  constructor(path) {
    this.path = path;
  }

  toRealFilePath(from, url) {
    // We need to patch this to load the WebIDL parser
    url = url.replace(
      '/resources/WebIDLParser.js',
      '/resources/webidl2/lib/webidl2.js',
    );
    const base = path.dirname(from);
    return url.startsWith('/') ?
      fixtures.path('wpt', url) :
      fixtures.path('wpt', base, url);
  }

  /**
   * Load a resource in test/fixtures/wpt specified with a URL
   * @param {string} from the path of the file loading this resource,
   *                      relative to the WPT folder.
   * @param {string} url the url of the resource being loaded.
   */
  read(from, url) {
    const file = this.toRealFilePath(from, url);
    return fs.readFileSync(file, 'utf8');
  }

  /**
   * Load a resource in test/fixtures/wpt specified with a URL
   * @param {string} from the path of the file loading this resource,
   *                      relative to the WPT folder.
   * @param {string} url the url of the resource being loaded.
   */
  async readAsFetch(from, url) {
    const file = this.toRealFilePath(from, url);
    const data = await fsPromises.readFile(file);
    return {
      ok: true,
      json() { return JSON.parse(data.toString()); },
      text() { return data.toString(); },
    };
  }
}

class StatusRule {
  constructor(key, value, pattern) {
    this.key = key;
    this.requires = value.requires || [];
    this.fail = value.fail;
    this.skip = value.skip;
    if (pattern) {
      this.pattern = this.transformPattern(pattern);
    }
    // TODO(joyeecheung): implement this
    this.scope = value.scope;
    this.comment = value.comment;
  }

  /**
   * Transform a filename pattern into a RegExp
   * @param {string} pattern
   * @returns {RegExp}
   */
  transformPattern(pattern) {
    const result = path.normalize(pattern).replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
    return new RegExp(result.replace('*', '.*'));
  }
}

class StatusRuleSet {
  constructor() {
    // We use two sets of rules to speed up matching
    this.exactMatch = {};
    this.patternMatch = [];
  }

  /**
   * @param {object} rules
   */
  addRules(rules) {
    for (const key of Object.keys(rules)) {
      if (key.includes('*')) {
        this.patternMatch.push(new StatusRule(key, rules[key], key));
      } else {
        const normalizedPath = path.normalize(key);
        this.exactMatch[normalizedPath] = new StatusRule(key, rules[key]);
      }
    }
  }

  match(file) {
    const result = [];
    const exact = this.exactMatch[file];
    if (exact) {
      result.push(exact);
    }
    for (const item of this.patternMatch) {
      if (item.pattern.test(file)) {
        result.push(item);
      }
    }
    return result;
  }
}

// A specification of WPT test
class WPTTestSpec {
  #content;

  /**
   * @param {string} mod name of the WPT module, e.g.
   *                     'html/webappapis/microtask-queuing'
   * @param {string} filename path of the test, relative to mod, e.g.
   *                          'test.any.js'
   * @param {StatusRule[]} rules
   * @param {string} variant test file variant
   */
  constructor(mod, filename, rules, variant = '') {
    this.module = mod;
    this.filename = filename;
    this.variant = variant;

    this.requires = new Set();
    this.failedTests = [];
    this.flakyTests = [];
    this.skipReasons = [];
    for (const item of rules) {
      if (item.requires.length) {
        for (const req of item.requires) {
          this.requires.add(req);
        }
      }
      if (Array.isArray(item.fail?.expected)) {
        this.failedTests.push(...item.fail.expected);
      }
      if (Array.isArray(item.fail?.flaky)) {
        this.failedTests.push(...item.fail.flaky);
        this.flakyTests.push(...item.fail.flaky);
      }
      if (item.skip) {
        this.skipReasons.push(item.skip);
      }
    }

    this.failedTests = [...new Set(this.failedTests)];
    this.flakyTests = [...new Set(this.flakyTests)];
    this.skipReasons = [...new Set(this.skipReasons)];
  }

  /**
   * @param {string} mod
   * @param {string} filename
   * @param {StatusRule[]} rules
   */
  static from(mod, filename, rules) {
    const spec = new WPTTestSpec(mod, filename, rules);
    const meta = spec.getMeta();
    return meta.variant?.map((variant) => new WPTTestSpec(mod, filename, rules, variant)) || [spec];
  }

  getRelativePath() {
    return path.join(this.module, this.filename);
  }

  getAbsolutePath() {
    return fixtures.path('wpt', this.getRelativePath());
  }

  /**
   * @returns {string}
   */
  getContent() {
    this.#content ||= fs.readFileSync(this.getAbsolutePath(), 'utf8');
    return this.#content;
  }

  /**
   * @returns {{ script?: string[]; variant?: string[]; [key: string]: string }} parsed META tags of a spec file
   */
  getMeta() {
    const matches = this.getContent().match(/\/\/ META: .+/g);
    if (!matches) {
      return {};
    }
    const result = {};
    for (const match of matches) {
      const parts = match.match(/\/\/ META: ([^=]+?)=(.+)/);
      const key = parts[1];
      const value = parts[2];
      if (key === 'script' || key === 'variant') {
        if (result[key]) {
          result[key].push(value);
        } else {
          result[key] = [value];
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}

const kIntlRequirement = {
  none: 0,
  small: 1,
  full: 2,
  // TODO(joyeecheung): we may need to deal with --with-intl=system-icu
};

class IntlRequirement {
  constructor() {
    this.currentIntl = kIntlRequirement.none;
    if (process.config.variables.v8_enable_i18n_support === 0) {
      this.currentIntl = kIntlRequirement.none;
      return;
    }
    // i18n enabled
    if (process.config.variables.icu_small) {
      this.currentIntl = kIntlRequirement.small;
    } else {
      this.currentIntl = kIntlRequirement.full;
    }
  }

  /**
   * @param {Set} requires
   * @returns {string|false} The config that the build is lacking, or false
   */
  isLacking(requires) {
    const current = this.currentIntl;
    if (requires.has('full-icu') && current !== kIntlRequirement.full) {
      return 'full-icu';
    }
    if (requires.has('small-icu') && current < kIntlRequirement.small) {
      return 'small-icu';
    }
    return false;
  }
}

const intlRequirements = new IntlRequirement();

class StatusLoader {
  /**
   * @param {string} path relative path of the WPT subset
   */
  constructor(path) {
    this.path = path;
    this.rules = new StatusRuleSet();
    /** @type {WPTTestSpec[]} */
    this.specs = [];
  }

  /**
   * Grep for all .*.js file recursively in a directory.
   * @param {string} dir
   */
  grep(dir) {
    let result = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filepath = path.join(dir, file);
      const stat = fs.statSync(filepath);
      if (stat.isDirectory()) {
        const list = this.grep(filepath);
        result = result.concat(list);
      } else {
        if (!(/\.\w+\.js$/.test(filepath))) {
          continue;
        }
        result.push(filepath);
      }
    }
    return result;
  }

  load() {
    const dir = path.join(__dirname, '..', 'wpt');
    const statusFile = path.join(dir, 'status', `${this.path}.json`);
    const result = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    this.rules.addRules(result);

    const subDir = fixtures.path('wpt', this.path);
    const list = this.grep(subDir);
    for (const file of list) {
      const relativePath = path.relative(subDir, file);
      const match = this.rules.match(relativePath);
      this.specs.push(...WPTTestSpec.from(this.path, relativePath, match));
    }
  }
}

const kPass = 'pass';
const kFail = 'fail';
const kSkip = 'skip';
const kTimeout = 'timeout';
const kIncomplete = 'incomplete';
const kUncaught = 'uncaught';
const NODE_UNCAUGHT = 100;

const limit = (concurrency) => {
  let running = 0;
  const queue = [];

  const execute = async (fn) => {
    if (running < concurrency) {
      running++;
      try {
        await fn();
      } finally {
        running--;
        if (queue.length > 0) {
          execute(queue.shift());
        }
      }
    } else {
      queue.push(fn);
    }
  };

  return execute;
};

class WPTRunner {
  constructor(path) {
    this.path = path;
    this.resource = new ResourceLoader(path);

    this.flags = [];
    this.globalThisInitScripts = [];
    this.initScript = null;

    this.status = new StatusLoader(path);
    this.status.load();
    this.specs = new Set(this.status.specs);

    this.results = {};
    this.inProgress = new Set();
    this.workers = new Map();
    this.unexpectedFailures = [];

    if (process.env.WPT_REPORT != null) {
      this.report = new WPTReport(path);
    }
  }

  /**
   * Sets the Node.js flags passed to the worker.
   * @param {string[]} flags
   */
  setFlags(flags) {
    this.flags = flags;
  }

  /**
   * Sets a script to be run in the worker before executing the tests.
   * @param {string} script
   */
  setInitScript(script) {
    this.initScript = script;
  }

  /**
   * Set the scripts modifier for each script.
   * @param {(meta: { code: string, filename: string }) => void} modifier
   */
  setScriptModifier(modifier) {
    this.scriptsModifier = modifier;
  }

  /**
   * @param {WPTTestSpec} spec
   */
  fullInitScript(spec) {
    const url = new URL(`/${spec.getRelativePath().replace(/\.js$/, '.html')}${spec.variant}`, 'http://wpt');
    const title = spec.getMeta().title;
    let { initScript } = this;

    initScript = `${initScript}\n\n//===\nglobalThis.location = new URL("${url.href}");`;

    if (title) {
      initScript = `${initScript}\n\n//===\nglobalThis.META_TITLE = "${title}";`;
    }

    if (this.globalThisInitScripts.length === null) {
      return initScript;
    }

    const globalThisInitScript = this.globalThisInitScripts.join('\n\n//===\n');

    if (initScript === null) {
      return globalThisInitScript;
    }

    return `${globalThisInitScript}\n\n//===\n${initScript}`;
  }

  /**
   * Pretend the runner is run in `name`'s environment (globalThis).
   * @param {'Window'} name
   * @see {@link https://github.com/nodejs/node/blob/24673ace8ae196bd1c6d4676507d6e8c94cf0b90/test/fixtures/wpt/resources/idlharness.js#L654-L671}
   */
  pretendGlobalThisAs(name) {
    switch (name) {
      case 'Window': {
        this.globalThisInitScripts.push('globalThis.Window = Object.getPrototypeOf(globalThis).constructor;');
        this.loadLazyGlobals();
        break;
      }

      // TODO(XadillaX): implement `ServiceWorkerGlobalScope`,
      // `DedicateWorkerGlobalScope`, etc.
      //
      // e.g. `ServiceWorkerGlobalScope` should implement dummy
      // `addEventListener` and so on.

      default: throw new Error(`Invalid globalThis type ${name}.`);
    }
  }

  loadLazyGlobals() {
    const lazyProperties = [
      'DOMException',
      'Performance', 'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure',
      'PerformanceObserver', 'PerformanceObserverEntryList', 'PerformanceResourceTiming',
      'Blob', 'atob', 'btoa',
      'MessageChannel', 'MessagePort', 'MessageEvent',
      'EventTarget', 'Event',
      'AbortController', 'AbortSignal',
      'performance',
      'TransformStream', 'TransformStreamDefaultController',
      'WritableStream', 'WritableStreamDefaultController', 'WritableStreamDefaultWriter',
      'ReadableStream', 'ReadableStreamDefaultReader',
      'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest',
      'ReadableByteStreamController', 'ReadableStreamDefaultController',
      'ByteLengthQueuingStrategy', 'CountQueuingStrategy',
      'TextEncoderStream', 'TextDecoderStream',
      'CompressionStream', 'DecompressionStream',
    ];
    if (Boolean(process.versions.openssl) && !process.env.NODE_SKIP_CRYPTO) {
      lazyProperties.push('crypto', 'Crypto', 'CryptoKey', 'SubtleCrypto');
    }
    const script = lazyProperties.map((name) => `globalThis.${name};`).join('\n');
    this.globalThisInitScripts.push(script);
  }

  // TODO(joyeecheung): work with the upstream to port more tests in .html
  // to .js.
  async runJsTests() {
    const queue = this.buildQueue();

    const run = limit(os.availableParallelism());

    for (const spec of queue) {
      const content = spec.getContent();
      const meta = spec.getMeta(content);

      const absolutePath = spec.getAbsolutePath();
      const relativePath = spec.getRelativePath();
      const harnessPath = fixtures.path('wpt', 'resources', 'testharness.js');

      // Scripts specified with the `// META: script=` header
      const scriptsToRun = meta.script?.map((script) => {
        const obj = {
          filename: this.resource.toRealFilePath(relativePath, script),
          code: this.resource.read(relativePath, script),
        };
        this.scriptsModifier?.(obj);
        return obj;
      }) ?? [];
      // The actual test
      const obj = {
        code: content,
        filename: absolutePath,
      };
      this.scriptsModifier?.(obj);
      scriptsToRun.push(obj);

      run(async () => {
        const worker = new Worker(workerPath, {
          execArgv: this.flags,
          workerData: {
            testRelativePath: relativePath,
            wptRunner: __filename,
            wptPath: this.path,
            initScript: this.fullInitScript(spec),
            harness: {
              code: fs.readFileSync(harnessPath, 'utf8'),
              filename: harnessPath,
            },
            scriptsToRun,
            needsGc: !!meta.script?.find((script) => script === '/common/gc.js'),
          },
        });
        this.inProgress.add(spec);
        this.workers.set(spec, worker);

        let reportResult;
        worker.on('message', (message) => {
          switch (message.type) {
            case 'result':
              reportResult ||= this.report?.addResult(`/${relativePath}${spec.variant}`, 'OK');
              return this.resultCallback(spec, message.result, reportResult);
            case 'completion':
              return this.completionCallback(spec, message.status);
            default:
              throw new Error(`Unexpected message from worker: ${message.type}`);
          }
        });

        worker.on('error', (err) => {
          if (!this.inProgress.has(spec)) {
            // The test is already finished. Ignore errors that occur after it.
            // This can happen normally, for example in timers tests.
            return;
          }
          this.fail(
            spec,
            {
              status: NODE_UNCAUGHT,
              name: 'evaluation in WPTRunner.runJsTests()',
              message: err.message,
              stack: inspect(err),
            },
            kUncaught,
          );
          this.inProgress.delete(spec);
        });

        await events.once(worker, 'exit').catch(() => {});
      });
    }

    process.on('exit', () => {
      for (const spec of this.inProgress) {
        this.fail(spec, { name: 'Unknown' }, kIncomplete);
      }
      inspect.defaultOptions.depth = Infinity;
      // Sorts the rules to have consistent output
      console.log('');
      console.log(JSON.stringify(Object.keys(this.results).sort().reduce(
        (obj, key) => {
          obj[key] = this.results[key];
          return obj;
        },
        {},
      ), null, 2));

      const failures = [];
      let expectedFailures = 0;
      let skipped = 0;
      for (const [key, item] of Object.entries(this.results)) {
        if (item.fail?.unexpected) {
          failures.push(key);
        }
        if (item.fail?.expected) {
          expectedFailures++;
        }
        if (item.skip) {
          skipped++;
        }
      }

      const unexpectedPasses = [];
      for (const specs of queue) {
        const key = specs.filename;

        // File has no expected failures
        if (!specs.failedTests.length) {
          continue;
        }

        // File was (maybe even conditionally) skipped
        if (this.results[key]?.skip) {
          continue;
        }

        // Full check: every expected to fail test is present
        if (specs.failedTests.some((expectedToFail) => {
          if (specs.flakyTests.includes(expectedToFail)) {
            return false;
          }
          return this.results[key]?.fail?.expected?.includes(expectedToFail) !== true;
        })) {
          unexpectedPasses.push(key);
          continue;
        }
      }

      this.report?.write();

      const ran = queue.length;
      const total = ran + skipped;
      const passed = ran - expectedFailures - failures.length;
      console.log('');
      console.log(`Ran ${ran}/${total} tests, ${skipped} skipped,`,
                  `${passed} passed, ${expectedFailures} expected failures,`,
                  `${failures.length} unexpected failures,`,
                  `${unexpectedPasses.length} unexpected passes`);
      if (failures.length > 0) {
        const file = path.join('test', 'wpt', 'status', `${this.path}.json`);
        throw new Error(
          `Found ${failures.length} unexpected failures. ` +
          `Consider updating ${file} for these files:\n${failures.join('\n')}`);
      }
      if (unexpectedPasses.length > 0) {
        const file = path.join('test', 'wpt', 'status', `${this.path}.json`);
        throw new Error(
          `Found ${unexpectedPasses.length} unexpected passes. ` +
          `Consider updating ${file} for these files:\n${unexpectedPasses.join('\n')}`);
      }
    });
  }

  // Map WPT test status to strings
  getTestStatus(status) {
    switch (status) {
      case 1:
        return kFail;
      case 2:
        return kTimeout;
      case 3:
        return kIncomplete;
      case NODE_UNCAUGHT:
        return kUncaught;
      default:
        return kPass;
    }
  }

  /**
   * Report the status of each specific test case (there could be multiple
   * in one test file).
   * @param {WPTTestSpec} spec
   * @param {Test} test  The Test object returned by WPT harness
   */
  resultCallback(spec, test, reportResult) {
    const status = this.getTestStatus(test.status);
    if (status !== kPass) {
      this.fail(spec, test, status, reportResult);
    } else {
      this.succeed(test, status, reportResult);
    }
  }

  /**
   * Report the status of each WPT test (one per file)
   * @param {WPTTestSpec} spec
   * @param {object} harnessStatus - The status object returned by WPT harness.
   */
  completionCallback(spec, harnessStatus) {
    // Treat it like a test case failure
    if (harnessStatus.status === 2) {
      this.resultCallback(spec, { status: 2, name: 'Unknown' });
    }
    this.inProgress.delete(spec);
    // Always force termination of the worker. Some tests allocate resources
    // that would otherwise keep it alive.
    this.workers.get(spec).terminate();
  }

  addTestResult(spec, item) {
    let result = this.results[spec.filename];
    if (!result) {
      result = this.results[spec.filename] = {};
    }
    if (item.status === kSkip) {
      // { filename: { skip: 'reason' } }
      result[kSkip] = item.reason;
    } else {
      // { filename: { fail: { expected: [ ... ],
      //                      unexpected: [ ... ] } }}
      if (!result[item.status]) {
        result[item.status] = {};
      }
      const key = item.expected ? 'expected' : 'unexpected';
      if (!result[item.status][key]) {
        result[item.status][key] = [];
      }
      const hasName = result[item.status][key].includes(item.name);
      if (!hasName) {
        result[item.status][key].push(item.name);
      }
    }
  }

  succeed(test, status, reportResult) {
    console.log(`[${status.toUpperCase()}] ${test.name}`);
    reportResult?.addSubtest(test.name, 'PASS');
  }

  fail(spec, test, status, reportResult) {
    const expected = spec.failedTests.includes(test.name);
    if (expected) {
      console.log(`[EXPECTED_FAILURE][${status.toUpperCase()}] ${test.name}`);
    } else {
      console.log(`[UNEXPECTED_FAILURE][${status.toUpperCase()}] ${test.name}`);
    }
    if (status === kFail || status === kUncaught) {
      console.log(test.message);
      console.log(test.stack);
    }
    const command = `${process.execPath} ${process.execArgv}` +
                    ` ${require.main.filename} '${spec.filename}${spec.variant}'`;
    console.log(`Command: ${command}\n`);

    reportResult?.addSubtest(test.name, 'FAIL', test.message);

    this.addTestResult(spec, {
      name: test.name,
      expected,
      status: kFail,
      reason: test.message || status,
    });
  }

  skip(spec, reasons) {
    const joinedReasons = reasons.join('; ');
    console.log(`[SKIPPED] ${spec.filename}${spec.variant}: ${joinedReasons}`);
    this.addTestResult(spec, {
      status: kSkip,
      reason: joinedReasons,
    });
  }

  buildQueue() {
    const queue = [];
    let argFilename;
    let argVariant;
    if (process.argv[2]) {
      ([argFilename, argVariant = ''] = process.argv[2].split('?'));
    }
    for (const spec of this.specs) {
      if (argFilename) {
        if (spec.filename === argFilename && (!argVariant || spec.variant.substring(1) === argVariant)) {
          queue.push(spec);
        }
        continue;
      }

      if (spec.skipReasons.length > 0) {
        this.skip(spec, spec.skipReasons);
        continue;
      }

      const lackingIntl = intlRequirements.isLacking(spec.requires);
      if (lackingIntl) {
        this.skip(spec, [ `requires ${lackingIntl}` ]);
        continue;
      }

      queue.push(spec);
    }

    // If the tests are run as `node test/wpt/test-something.js subset.any.js`,
    // only `subset.any.js` (all variants) will be run by the runner.
    // If the tests are run as `node test/wpt/test-something.js 'subset.any.js?1-10'`,
    // only the `?1-10` variant of `subset.any.js` will be run by the runner.
    if (argFilename && queue.length === 0) {
      throw new Error(`${process.argv[2]} not found!`);
    }

    return queue;
  }
}

module.exports = {
  harness: harnessMock,
  ResourceLoader,
  WPTRunner,
};
