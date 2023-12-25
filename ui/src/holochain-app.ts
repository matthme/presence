import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  AppAgentWebsocket,
  AppAgentClient,
} from '@holochain/client';
import { provide } from '@lit-labs/context';
import {
  WeClient,
  initializeHotReload,
  isWeContext,
} from '@lightningrodlabs/we-applet';

import { clientContext, unzoomStoreContext } from './contexts';
import { UnzoomStore } from './unzoom-store';
import { UnzoomClient } from './unzoom-client';

import './main-view';

@customElement('holochain-app')
export class HolochainApp extends LitElement {
  @state() loading = true;

  @provide({ context: unzoomStoreContext })
  @property({ type: Object })
  unzoomStore!: UnzoomStore;

  @provide({ context: clientContext })
  @property({ type: Object })
  client!: AppAgentClient;

  async firstUpdated() {
    if ((import.meta as any).env.DEV) {
      try {
        await initializeHotReload();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          'Could not initialize applet hot-reloading. This is only expected to work in a We context in dev mode.'
        );
      }
    }
    if (isWeContext()) {
      const weClient = await WeClient.connect();
      if (
        weClient.renderInfo.type !== 'applet-view' ||
        weClient.renderInfo.view.type !== 'main'
      )
        throw new Error('This Applet only implements the applet main view.');
      this.client = weClient.renderInfo.appletClient;
    } else {
      // We pass an unused string as the url because it will dynamically be replaced in launcher environments
      this.client = await AppAgentWebsocket.connect(
        new URL('https://UNUSED'),
        'unzoom'
      );
    }
    this.unzoomStore = new UnzoomStore(
      new UnzoomClient(this.client, 'unzoom', 'unzoom')
    );
    this.loading = false;
  }


  render() {
    if (this.loading) return html` loading... `;

    return html` <main-view  class="main-view" .unzoomStore=${this.unzoomStore}></main-view> `;
  }

  static styles = css`
    :host {
      min-height: 100vh;
      min-width: 100vw;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      font-size: calc(10px + 2vmin);
      color: #1a2b42;
      max-width: 960px;
      margin: 0;
      text-align: center;
      background: #383b4d;
    }

    .main-view {
      display: flex;
      flex: 1;
      margin: 0;
    }

    .app-footer {
      font-size: calc(12px + 0.5vmin);
      align-items: center;
    }

    .app-footer a {
      margin-left: 5px;
    }
  `;
}
