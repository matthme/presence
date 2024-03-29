import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { localized } from '@lit/localize';
import { consume } from '@lit/context';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import '@holochain-open-dev/elements/dist/elements/holo-identicon.js';
import {
  AssetInfo,
  AssetLocationAndInfo,
  WAL,
  WeClient,
  weaveUrlToLocation,
} from '@lightningrodlabs/we-applet';

import { sharedStyles } from './sharedStyles';
import './avatar-with-nickname';
import { weClientContext } from './types';

@localized()
@customElement('attachment-element')
export class AttachmentElement extends LitElement {
  @consume({ context: weClientContext })
  @state()
  _weClient!: WeClient;

  @property()
  src!: string;

  @state()
  _error: string | undefined;

  @state()
  _assetInfo: AssetLocationAndInfo | undefined;

  @state()
  _wal: WAL | undefined;

  async firstUpdated() {
    const weaveLocation = weaveUrlToLocation(this.src);
    if (weaveLocation.type !== 'asset') {
      this._error = 'Invalid URL';
      return;
    }
    this._assetInfo = await this._weClient.assetInfo(weaveLocation.wal);
    this._wal = weaveLocation.wal;
  }

  async openAsset() {
    await this._weClient.openWal(this._wal!);
  }

  render() {
    return html`
      <button @click=${() => this.openAsset()}>
        ${this._assetInfo ? this._assetInfo.assetInfo.name : ''}
      </button>
    `;
  }

  static styles = [sharedStyles, css``];
}
