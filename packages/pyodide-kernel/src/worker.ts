// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type Pyodide from 'pyodide';

import type { DriveFS } from '@jupyterlite/contents';

import { KernelMessage } from '@jupyterlab/services';

import type { IPyodideWorkerKernel } from './tokens';

class Timer {
  lastTime: number;
  constructor() {
    this.lastTime = performance.now();
  }

  stage(name: string) {
    const now = performance.now();
    const elapsed = (now - this.lastTime) / 1000;
    console.log(`KERNEL INIT: ${name} took ${elapsed.toFixed(2)}s`);
    this.lastTime = now;
  }

  elapsed(): string {
    const now = performance.now();
    return ((now - this.lastTime) / 1000).toFixed(2) + 's';
  }
}

export class PyodideRemoteKernel {
  constructor() {
    this._initialized = new Promise((resolve, reject) => {
      this._initializer = { resolve, reject };
    });
  }

  /**
   * Accept the URLs from the host
   **/
  async initialize(options: IPyodideWorkerKernel.IOptions): Promise<void> {
    this._options = options;

    if (options.location.includes(':')) {
      const parts = options.location.split(':');
      this._driveName = parts[0];
      this._localPath = parts[1];
    } else {
      this._driveName = '';
      this._localPath = options.location;
    }
    const t = new Timer();
    await this.initRuntime(options);
    t.stage("initRuntime()");
    await this.mountJupyterLiteDriveFS(options);
    t.stage("mountJupyterLiteDriveFS()");

    const cacheIsPopulated = await this.mountPackageCacheFS();
    t.stage("mountPackageCacheFS()");

    await this.initPackageManager(options, cacheIsPopulated);
    t.stage("initPackageManager()");
    await this.initPackages(options, cacheIsPopulated);
    t.stage("initPackages()");
    await this.initKernel(options);
    t.stage("initKernel()");
    await this.initGlobals(options);
    t.stage("initGlobals()");
    this._initializer?.resolve();
  }

  protected async initRuntime(options: IPyodideWorkerKernel.IOptions): Promise<void> {
    const { pyodideUrl, indexUrl } = options;
    let loadPyodide: typeof Pyodide.loadPyodide;
    if (pyodideUrl.endsWith('.mjs')) {
      // note: this does not work at all in firefox
      const pyodideModule: typeof Pyodide = await import(
        /* webpackIgnore: true */ pyodideUrl
      );
      loadPyodide = pyodideModule.loadPyodide;
    } else {
      importScripts(pyodideUrl);
      loadPyodide = (self as any).loadPyodide;
    }
    console.log('| |> options.loadPyodideOptions = ', options.loadPyodideOptions);
    this._pyodide = await loadPyodide({
      indexURL: indexUrl,
      ...options.loadPyodideOptions,
    });
    console.log('| |> this._pyodide.loadedPackages = ', JSON.parse(JSON.stringify(this._pyodide.loadedPackages)));
    const packageDirContent = this._pyodide.FS.readdir('/lib/python3.12/site-packages/');
    console.log('| |> packageDirContent = ', packageDirContent);
  }

  protected async mountPackageCacheFS(): Promise<boolean> {
    this._pyodide.FS.mount(
      this._pyodide.FS.filesystems.IDBFS, {},
      '/lib/python3.12/site-packages/',
    );

    await this.syncPackageCacheFS(true);  // populate site-packages from IndexedDB

    const packages = this._pyodide.FS.readdir('/lib/python3.12/site-packages/')
      .filter(p => p != '.' && p != '..');
    return packages.length > 0;
  }

  protected async initPackageManager(
    options: IPyodideWorkerKernel.IOptions,
    cacheIsPopulated: boolean,
  ): Promise<void> {

    if (cacheIsPopulated) {
      const readFile = this._pyodide.FS.readFile as any;
      const loadedPackagesJsonStr: string = readFile(
        '/lib/python3.12/site-packages/.loadedPackages.json', {encoding: 'utf8'},
      );
      const loadedPackagesJson: Record<string, string> = JSON.parse(loadedPackagesJsonStr);
      Object.assign(this._pyodide.loadedPackages, loadedPackagesJson);
    }

    const { pipliteWheelUrl, disablePyPIFallback, pipliteUrls, loadPyodideOptions } =
      options;

    const preloaded = (loadPyodideOptions || {}).packages || [];

    if (!preloaded.includes('micropip') && !cacheIsPopulated) {
      await this._pyodide.loadPackage(['micropip']);
    }

    if (!preloaded.includes('piplite') && !cacheIsPopulated) {
      await this._pyodide.runPythonAsync(`
      import micropip
      await micropip.install('${pipliteWheelUrl}', keep_going=True)
    `);
    }

    // get piplite early enough to impact pyodide-kernel dependencies
    await this._pyodide.runPythonAsync(`
      import piplite.piplite
      piplite.piplite._PIPLITE_DISABLE_PYPI = ${disablePyPIFallback ? 'True' : 'False'}
      piplite.piplite._PIPLITE_URLS = ${JSON.stringify(pipliteUrls)}
    `);
  }

  protected async initPackages(
    options: IPyodideWorkerKernel.IOptions,
    cacheIsPopulated: boolean,
  ): Promise<void> {
    if (cacheIsPopulated) {
      return
    }
    const preloaded = (options.loadPyodideOptions || {}).packages || [];

    const packages = [
        'ssl', 'sqlite3', 'ipykernel', 'comm', 'pyodide_kernel', 'ipython',
        'nbformat', 'numpy', 'pandas', 'polars', 'ipywidgets', 'plotly', 'plotly-express',
        'tqdm', 'mmh3',

        // the following packages are disabled for now; installing them crashed browser tab with SIGILL
        // TODO: binsearch to find the culprit
        // 'scikit-learn', 'scipy', 'statsmodels', 'seaborn', 'itables', 'sweetviz',
        // 'matplotlib', 'pillow', 'dotmap', 'Jinja2', 'pytz', 'PyYAML', 'toml', 'requests', 'bokeh', 'ipyaggrid', 
    ]
    const toInstall = packages.filter(p => !preloaded.includes(p));

    await this._pyodide.runPythonAsync(`await piplite.install(${JSON.stringify(toInstall)}, keep_going=True)`);

    for (let packageName of packages) {
      const importName = packageName
        .replace('plotly-express', 'plotly.express')
        .replace('scikit-learn', 'sklearn')
        .replace('Jinja2', 'jinja2')
        .replace('PyYAML', 'yaml')
        .replace('ipython', 'IPython');

      // import packages to pre-generate .pyc files, so that next time they are already available
      // this form of import doesn't pollute the global namespace
      try {
        await this._pyodide.pyimport(importName);
      } catch (e) {
        console.error(`| |> ERROR importing module ${importName}`);
        console.error(e);
      }
    }

    // save this._pyodide.loadedPackages, so that when we mount pre-populated site-packages
    // dir next time (mountPackageCacheFS), pyodide will know that these packages have already
    // been loaded
    this._pyodide.FS.writeFile(
      '/lib/python3.12/site-packages/.loadedPackages.json',
      JSON.stringify(this._pyodide.loadedPackages),
    );

    await this.syncPackageCacheFS(false);  // save site-packages to IndexedDB
  }

  protected async initKernel(options: IPyodideWorkerKernel.IOptions): Promise<void> {
    const scriptLines: string[] = [];

    // import the kernel
    scriptLines.push('import pyodide_kernel');

    // cd to the kernel location
    if (options.mountDrive && this._localPath) {
      scriptLines.push('import os', `os.chdir("${this._localPath}")`);
    }

    // from this point forward, only use piplite (but not %pip)
    await this._pyodide.runPythonAsync(scriptLines.join('\n'));
  }

  protected async initGlobals(options: IPyodideWorkerKernel.IOptions): Promise<void> {
    const { globals } = this._pyodide;
    this._kernel = globals.get('pyodide_kernel').kernel_instance.copy();
    this._stdout_stream = globals.get('pyodide_kernel').stdout_stream.copy();
    this._stderr_stream = globals.get('pyodide_kernel').stderr_stream.copy();
    this._interpreter = this._kernel.interpreter.copy();
    this._interpreter.send_comm = this.sendComm.bind(this);
  }

  /**
   * Setup custom Emscripten FileSystem
   */
  protected async mountJupyterLiteDriveFS(
    options: IPyodideWorkerKernel.IOptions,
  ): Promise<void> {
    if (options.mountDrive) {
      const mountpoint = '/drive';
      const { FS, PATH, ERRNO_CODES } = this._pyodide;
      const { baseUrl } = options;
      const { DriveFS } = await import('@jupyterlite/contents');

      const driveFS = new DriveFS({
        FS: FS as any,
        PATH,
        ERRNO_CODES,
        baseUrl,
        driveName: this._driveName,
        mountpoint,
      });
      FS.mkdirTree(mountpoint);
      FS.mount(driveFS, {}, mountpoint);
      FS.chdir(mountpoint);
      this._driveFS = driveFS;
    }
  }

  protected syncPackageCacheFS(populate: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      (this._pyodide.FS.syncfs as any)(populate, (err: any) => {
        if (err) reject(err);
        else resolve(undefined);
      });
    });
  }

  /**
   * Recursively convert a Map to a JavaScript object
   * @param obj A Map, Array, or other  object to convert
   */
  mapToObject(obj: any) {
    const out: any = obj instanceof Array ? [] : {};
    obj.forEach((value: any, key: string) => {
      out[key] =
        value instanceof Map || value instanceof Array
          ? this.mapToObject(value)
          : value;
    });
    return out;
  }

  /**
   * Format the response from the Pyodide evaluation.
   *
   * @param res The result object from the Pyodide evaluation
   */
  formatResult(res: any): any {
    if (!(res instanceof this._pyodide.ffi.PyProxy)) {
      return res;
    }
    // TODO: this is a bit brittle
    const m = res.toJs();
    const results = this.mapToObject(m);
    return results;
  }

  /**
   * Register the callback function to send messages from the worker back to the main thread.
   * @param callback the callback to register
   */
  registerCallback(callback: (msg: any) => void): void {
    this._sendWorkerMessage = callback;
  }

  /**
   * Makes sure pyodide is ready before continuing, and cache the parent message.
   */
  async setup(parent: any): Promise<void> {
    await this._initialized;
    this._kernel._parent_header = this._pyodide.toPy(parent);
  }

  /**
   * Execute code with the interpreter.
   *
   * @param content The incoming message with the code to execute.
   */
  async execute(content: any, parent: any) {
    console.log("|E|> execute request: content = ", content);
    const t = new Timer();
    await this.setup(parent);

    const publishExecutionResult = (
      prompt_count: any,
      data: any,
      metadata: any,
    ): void => {
      const bundle = {
        execution_count: prompt_count,
        data: this.formatResult(data),
        metadata: this.formatResult(metadata),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'execute_result',
      });
    };

    const publishExecutionError = (ename: any, evalue: any, traceback: any): void => {
      const bundle = {
        ename: ename,
        evalue: evalue,
        traceback: traceback,
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'execute_error',
      });
    };

    const clearOutputCallback = (wait: boolean): void => {
      const bundle = {
        wait: this.formatResult(wait),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'clear_output',
      });
    };

    const displayDataCallback = (data: any, metadata: any, transient: any): void => {
      const bundle = {
        data: this.formatResult(data),
        metadata: this.formatResult(metadata),
        transient: this.formatResult(transient),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'display_data',
      });
    };

    const updateDisplayDataCallback = (
      data: any,
      metadata: any,
      transient: any,
    ): void => {
      const bundle = {
        data: this.formatResult(data),
        metadata: this.formatResult(metadata),
        transient: this.formatResult(transient),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'update_display_data',
      });
    };

    const publishStreamCallback = (name: any, text: any): void => {
      const bundle = {
        name: this.formatResult(name),
        text: this.formatResult(text),
      };

      this._sendWorkerMessage({
        parentHeader: this.formatResult(this._kernel._parent_header)['header'],
        bundle,
        type: 'stream',
      });
    };

    this._stdout_stream.publish_stream_callback = publishStreamCallback;
    this._stderr_stream.publish_stream_callback = publishStreamCallback;
    this._interpreter.display_pub.clear_output_callback = clearOutputCallback;
    this._interpreter.display_pub.display_data_callback = displayDataCallback;
    this._interpreter.display_pub.update_display_data_callback =
      updateDisplayDataCallback;
    this._interpreter.displayhook.publish_execution_result = publishExecutionResult;
    this._interpreter.input = this.input.bind(this);
    this._interpreter.getpass = this.getpass.bind(this);

    const res = await this._kernel.run(content.code);
    const results = this.formatResult(res);

    console.log(`|E|> execute complete: ${results.status}; elapsed ${t.elapsed()}`);
    console.log('| |> this._pyodide.loadedPackages = ', JSON.parse(JSON.stringify(this._pyodide.loadedPackages)));
    const packageDirContent = this._pyodide.FS.readdir('/lib/python3.12/site-packages/');
    console.log('| |> packageDirContent = ', packageDirContent);

    if (results['status'] === 'error') {
      publishExecutionError(results['ename'], results['evalue'], results['traceback']);
    }

    return results;
  }

  /**
   * Complete the code submitted by a user.
   *
   * @param content The incoming message with the code to complete.
   */
  async complete(content: any, parent: any) {
    await this.setup(parent);

    const res = this._kernel.complete(content.code, content.cursor_pos);
    const results = this.formatResult(res);
    return results;
  }

  /**
   * Inspect the code submitted by a user.
   *
   * @param content The incoming message with the code to inspect.
   */
  async inspect(
    content: { code: string; cursor_pos: number; detail_level: 0 | 1 },
    parent: any,
  ) {
    await this.setup(parent);

    const res = this._kernel.inspect(
      content.code,
      content.cursor_pos,
      content.detail_level,
    );
    const results = this.formatResult(res);
    return results;
  }

  /**
   * Check code for completeness submitted by a user.
   *
   * @param content The incoming message with the code to check.
   */
  async isComplete(content: { code: string }, parent: any) {
    await this.setup(parent);

    const res = this._kernel.is_complete(content.code);
    const results = this.formatResult(res);
    return results;
  }

  /**
   * Respond to the commInfoRequest.
   *
   * @param content The incoming message with the comm target name.
   */
  async commInfo(
    content: any,
    parent: any,
  ): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    await this.setup(parent);

    const res = this._kernel.comm_info(content.target_name);
    const results = this.formatResult(res);

    return {
      comms: results,
      status: 'ok',
    };
  }

  /**
   * Respond to the commOpen.
   *
   * @param content The incoming message with the comm open.
   */
  async commOpen(content: any, parent: any) {
    await this.setup(parent);

    const res = this._kernel.comm_manager.comm_open(
      this._pyodide.toPy(null),
      this._pyodide.toPy(null),
      this._pyodide.toPy(content),
    );
    const results = this.formatResult(res);

    return results;
  }

  /**
   * Respond to the commMsg.
   *
   * @param content The incoming message with the comm msg.
   */
  async commMsg(content: any, parent: any) {
    await this.setup(parent);

    const res = this._kernel.comm_manager.comm_msg(
      this._pyodide.toPy(null),
      this._pyodide.toPy(null),
      this._pyodide.toPy(content),
    );
    const results = this.formatResult(res);

    return results;
  }

  /**
   * Respond to the commClose.
   *
   * @param content The incoming message with the comm close.
   */
  async commClose(content: any, parent: any) {
    await this.setup(parent);

    const res = this._kernel.comm_manager.comm_close(
      this._pyodide.toPy(null),
      this._pyodide.toPy(null),
      this._pyodide.toPy(content),
    );
    const results = this.formatResult(res);

    return results;
  }

  /**
   * Resolve the input request by getting back the reply from the main thread
   *
   * @param content The incoming message with the reply
   */
  async inputReply(content: any, parent: any) {
    await this.setup(parent);

    this._resolveInputReply(content);
  }

  /**
   * Send a input request to the front-end.
   *
   * @param prompt the text to show at the prompt
   * @param password Is the request for a password?
   */
  async sendInputRequest(prompt: string, password: boolean) {
    const content = {
      prompt,
      password,
    };

    this._sendWorkerMessage({
      type: 'input_request',
      parentHeader: this.formatResult(this._kernel._parent_header)['header'],
      content,
    });
  }

  async getpass(prompt: string) {
    prompt = typeof prompt === 'undefined' ? '' : prompt;
    await this.sendInputRequest(prompt, true);
    const replyPromise = new Promise((resolve) => {
      this._resolveInputReply = resolve;
    });
    const result: any = await replyPromise;
    return result['value'];
  }

  async input(prompt: string) {
    prompt = typeof prompt === 'undefined' ? '' : prompt;
    await this.sendInputRequest(prompt, false);
    const replyPromise = new Promise((resolve) => {
      this._resolveInputReply = resolve;
    });
    const result: any = await replyPromise;
    return result['value'];
  }

  /**
   * Send a comm message to the front-end.
   *
   * @param type The type of the comm message.
   * @param content The content.
   * @param metadata The metadata.
   * @param ident The ident.
   * @param buffers The binary buffers.
   */
  async sendComm(type: string, content: any, metadata: any, ident: any, buffers: any) {
    this._sendWorkerMessage({
      type: type,
      content: this.formatResult(content),
      metadata: this.formatResult(metadata),
      ident: this.formatResult(ident),
      buffers: this.formatResult(buffers),
      parentHeader: this.formatResult(this._kernel._parent_header)['header'],
    });
  }

  /**
   * Initialization options.
   */
  protected _options: IPyodideWorkerKernel.IOptions | null = null;
  /**
   * A promise that resolves when all initiaization is complete.
   */
  protected _initialized: Promise<void>;
  private _initializer: {
    reject: () => void;
    resolve: () => void;
  } | null = null;
  protected _pyodide: Pyodide.PyodideInterface = null as any;
  /** TODO: real typing */
  protected _localPath = '';
  protected _driveName = '';
  protected _kernel: any;
  protected _interpreter: any;
  protected _stdout_stream: any;
  protected _stderr_stream: any;
  protected _resolveInputReply: any;
  protected _driveFS: DriveFS | null = null;
  protected _sendWorkerMessage: (msg: any) => void = () => {};
}
