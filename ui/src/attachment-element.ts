import { LitElement, PropertyValueMap, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit/context';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import {
  AppletInfo,
  AssetLocationAndInfo,
  WAL,
  WeaveClient,
  weaveUrlToLocation,
} from '@theweave/api';
import { EntryRecord } from '@holochain-open-dev/utils';
import { mdiTrashCan } from '@mdi/js';

import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { sharedStyles } from './sharedStyles';
import './avatar-with-nickname';
import { Attachment, weaveClientContext } from './types';

@localized()
@customElement('attachment-element')
export class AttachmentElement extends LitElement {
  @consume({ context: weaveClientContext })
  @state()
  _weaveClient!: WeaveClient;

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
    this._assetInfo = await this._weaveClient.assetInfo(weaveLocation.wal);
    this._wal = weaveLocation.wal;
    this._assetAppletInfo = this._assetInfo
      ? await this._weaveClient.appletInfo(this._assetInfo.appletHash)
      : undefined;
  }

  async firstUpdated() {
    await this.updateAssetInfo();
  }

  protected async willUpdate(
    changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ) {
    if (changedProperties.has('entryRecord')) {
      await this.updateAssetInfo();
    }
  }

  async openAsset() {
    if (this._wal) {
      await this._weaveClient.openWal(this._wal);
    }
  }

  removeAttachment() {
    this.dispatchEvent(
      new CustomEvent('remove-attachment', {
        detail: this.entryRecord,
      })
    );
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
        <div class="row" style="align-items: stretch;">
          <div
            class="row open-area ${this._assetInfo ? 'active' : ''}"
            style="align-items: center; padding: 5px 12px;"
          >
            ${this._assetInfo
              ? html`
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
                `
              : html`Asset not found`}
          </div>
          <sl-tooltip
            .content=${msg('remove for everyone')}
            style="color: white;"
            hoist
          >
            <div
              tabindex="0"
              class="column center-content delete-btn tertiary-font"
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
              <sl-icon
                style="font-size: 23px;"
                .src=${wrapPathInSvg(mdiTrashCan)}
              ></sl-icon>
            </div>
          </sl-tooltip>
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
        min-height: 38px;
        cursor: pointer;
        margin: 0;
        position: relative;
        box-shadow: 0 0 2px 1px #081c366d;
      }

      .btn:focus-visible {
        outline: 2px solid white;
      }

      .open-area {
        background: #c3c9eb;
        color: #081c36;
        border-radius: 20px 0 0 20px;
        max-width: 280px;
        overflow: hidden;
      }

      .active:hover {
        background: #eaecfb;
      }

      .active:focus-visible {
        background: #eaecfb;
      }

      .disabled {
        cursor: default;
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
        min-height: 38px;
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
