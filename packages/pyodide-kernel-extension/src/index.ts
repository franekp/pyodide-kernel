// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';

import { PageConfig, URLExt } from '@jupyterlab/coreutils';

import { IServiceWorkerManager } from '@jupyterlite/server';

import { IBroadcastChannelWrapper } from '@jupyterlite/contents';

import { IKernel, IKernelSpecs } from '@jupyterlite/kernel';

import KERNEL_ICON_SVG_STR from '../style/img/pyodide.svg';

export * as KERNEL_SETTINGS_SCHEMA from '../schema/kernel.v0.schema.json';

const KERNEL_ICON_URL = `data:image/svg+xml;base64,${btoa(KERNEL_ICON_SVG_STR)}`;

/**
 * The default CDN fallback for Pyodide
 */
const PYODIDE_CDN_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.js';

/**
 * The id for the extension, and key in the litePlugins.
 */
const PLUGIN_ID = '@jupyterlite/pyodide-kernel-extension:kernel';

/**
 * A plugin to register the Pyodide kernel.
 */
const kernel: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  requires: [IKernelSpecs],
  optional: [IServiceWorkerManager, IBroadcastChannelWrapper],
  activate: (
    app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    serviceWorker?: IServiceWorkerManager,
    broadcastChannel?: IBroadcastChannelWrapper,
  ) => {
    const contentsManager = app.serviceManager.contents;

    console.log("log");

    const config =
      JSON.parse(PageConfig.getOption('litePluginSettings') || '{}')[PLUGIN_ID] || {};

    const baseUrl = PageConfig.getBaseUrl();

    const url = config.pyodideUrl || PYODIDE_CDN_URL;

    const pyodideUrl = URLExt.parse(url).href;
    const pipliteWheelUrl = config.pipliteWheelUrl
      ? URLExt.parse(config.pipliteWheelUrl).href
      : undefined;
    const rawPipUrls = config.pipliteUrls || [];
    const pipliteUrls = rawPipUrls.map((pipUrl: string) => URLExt.parse(pipUrl).href);
    const disablePyPIFallback = !!config.disablePyPIFallback;
    const loadPyodideOptions = config.loadPyodideOptions || {};

    for (const [key, value] of Object.entries(loadPyodideOptions)) {
      if (key.endsWith('URL') && typeof value === 'string') {
        loadPyodideOptions[key] = new URL(value, baseUrl).href;
      }
    }

    kernelspecs.register({
      spec: {
        name: 'python',
        display_name: 'Python (Pyodide)',
        language: 'python',
        argv: [],
        resources: {
          'logo-32x32': KERNEL_ICON_URL,
          'logo-64x64': KERNEL_ICON_URL,
        },
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        const { PyodideKernel } = await import('@jupyterlite/pyodide-kernel');

        const mountDrive = !!(
          (serviceWorker?.enabled && broadcastChannel?.enabled) ||
          crossOriginIsolated
        );

        if (mountDrive) {
          console.info('Pyodide contents will be synced with Jupyter Contents');
        } else {
          console.warn('Pyodide contents will NOT be synced with Jupyter Contents');
        }

        return new PyodideKernel({
          ...options,
          pyodideUrl,
          pipliteWheelUrl,
          pipliteUrls,
          disablePyPIFallback,
          mountDrive,
          loadPyodideOptions,
          contentsManager,
        });
      },
    });
  },
};

const plugins: JupyterFrontEndPlugin<any>[] = [kernel];

export default plugins;
