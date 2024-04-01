import { LitElement, PropertyValueMap, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit/context';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import '@holochain-open-dev/elements/dist/elements/holo-identicon.js';
import {
  AppletInfo,
  AssetLocationAndInfo,
  WAL,
  WeClient,
  weaveUrlToLocation,
} from '@lightningrodlabs/we-applet';
import { EntryRecord } from '@holochain-open-dev/utils';

import { sharedStyles } from './sharedStyles';
import './avatar-with-nickname';
import { Attachment, weClientContext } from './types';

@localized()
@customElement('attachment-element')
export class AttachmentElement extends LitElement {
  @consume({ context: weClientContext })
  @state()
  _weClient!: WeClient;

  @property()
  entryRecord!: EntryRecord<Attachment>;

  @state()
  _error: string | undefined;

  @state()
  _assetInfo: AssetLocationAndInfo | undefined;

  @state()
  _assetAppletInfo: AppletInfo | undefined;

  @state()
  _wal: WAL | undefined;

  async updateAssetInfo() {
    const weaveLocation = weaveUrlToLocation(this.entryRecord.entry.wal);
    if (weaveLocation.type !== 'asset') {
      this._error = 'Invalid URL';
      return;
    }
    this._assetInfo = await this._weClient.assetInfo(weaveLocation.wal);
    this._wal = weaveLocation.wal;
    this._assetAppletInfo = this._assetInfo
      ? await this._weClient.appletInfo(this._assetInfo.appletHash)
      : undefined;
  }

  async firstUpdated() {
    await this.updateAssetInfo();
  }
  protected async willUpdate(changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>) {
      if (changedProperties.has('entryRecord')) {
        await this.updateAssetInfo();
      }
  }

  async openAsset() {
    await this._weClient.openWal(this._wal!);
  }

  removeAttachment() {
    if (this._wal) {
      this.dispatchEvent(
        new CustomEvent('remove-attachment', {
          detail: this.entryRecord,
        })
      );
    }
  }

  render() {
    return html`
      <div
        class="btn secondary-font ${this._assetInfo ? '' : 'disabled'}"
        tabindex="0"
        @click=${() => this.openAsset()}
        @keypress=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            this.openAsset();
          }
        }}
      >
        <div class="row" style="align-items: center;">
          ${this._assetInfo
            ? html`
                <div
                  class="row open-area"
                  style="align-items: center; padding: 5px 12px;"
                >
                  ${this._assetAppletInfo
                    ? html`
                        <img
                          .src=${this._assetAppletInfo.appletIcon}
                          alt="${this._assetAppletInfo.appletName} icon"
                          class="applet-icon"
                        />
                      `
                    : html``}

                  <img
                    .src=${this._assetInfo.assetInfo.icon_src}
                    alt="${this._assetInfo.assetInfo.name} icon"
                    class="asset-icon"
                  />

                  ${this._assetInfo.assetInfo.name}
                </div>
                <sl-tooltip
                  .content=${msg('remove for everyone')}
                  style="color: white;"
                  hoist
                >
                  <div
                    tabindex="0"
                    class="row center-content delete-btn tertiary-font"
                    @click=${(e: any) => {
                      this.removeAttachment();
                      e.stopPropagation();

                    }}
                    @keypress=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        this.removeAttachment();
                      }
                    }}
                  >
                    X
                  </div>
                </sl-tooltip>
              `
            : html`<div class="row center-content" style="margin: 0;">Asset not found.</div>`}
        </div>
      </div>
    `;
  }

  static styles = [
    sharedStyles,
    css`
      .btn {
        /* all: unset; */
        font-size: 18px;
        border-radius: 20px;
        height: 38px;
        cursor: pointer;
        margin: 0;
        position: relative;
        box-shadow: 0 0 2px 1px #081c366d
      }

      .btn:focus-visible {
        outline: 2px solid white;
      }

      .open-area {
        background: #c3c9eb;
        color: #081c36;
        border-radius: 20px 0 0 20px;
      }

      .open-area:hover {
        background: #eaecfb;
      }

      .open-area:focus-visible {
        background: #eaecfb;
      }

      .disabled {
        cursor: auto;
        opacity: 0.7;
      }

      .applet-icon {
        height: 26px;
        border-radius: 5px;
        margin-right: 4px;
      }

      .asset-icon {
        height: 26px;
        margin-right: 4px;
      }

      .delete-btn {
        background: #c32424;
        font-weight: bold;
        color: #ffdada;
        border-radius: 0 20px 20px 0;
        height: 38px;
        width: 32px;
        padding-right: 2px;
      }

      .delete-btn:hover {
        background: #d76565;
        color: #4d0202;
      }

      .delete-btn:focus-visible {
        background: #d76565;
        color: #4d0202;
      }

      sl-tooltip::part(body) {
        background-color: red;
        background: #c32424;
        color: #ffdada;
        padding: 2px 8px;
        border-radius: 10px;
      }
    `,
  ];
}
