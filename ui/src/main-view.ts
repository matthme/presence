import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  AppAgentWebsocket,
  AppAgentClient,
  encodeHashToBase64,
} from '@holochain/client';
import { provide } from '@lit-labs/context';
import { WeClient, initializeHotReload, isWeContext } from '@lightningrodlabs/we-applet';
import { StoreSubscriber } from '@holochain-open-dev/stores';

import { clientContext, unzoomStoreContext } from './contexts';
import { UnzoomStore } from './unzoom-store';
import { UnzoomClient } from './unzoom-client';

@customElement('main-view')
export class MainView extends LitElement {

  @property({ type: Object })
  unzoomStore!: UnzoomStore;

  _allAgents = new StoreSubscriber(
    this,
    () => this.unzoomStore.allAgents,
    () => [this.unzoomStore]
  )

  async firstUpdated() {
  }

  render() {
    switch (this._allAgents.value.status) {
      case "error":
        return html`ERROR: ${this._allAgents.value.error}`
      case "pending":
        return html`Searching other agents...`
      case "complete":
        return html`
          Found agents: ${this._allAgents.value.value.map((hash) => encodeHashToBase64(hash))}
        `
      default:
        return html`Invalid store status.`
    }
  }

  static styles = css`
    :host {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      font-size: calc(10px + 2vmin);
      color: #1a2b42;
      max-width: 960px;
      margin: 0 auto;
      text-align: center;
      background-color: var(--lit-element-background-color);
    }

    main {
      flex-grow: 1;
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
