import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  AppAgentClient,
  ClonedCell,
  encodeHashToBase64,
} from '@holochain/client';
import {
  mdiContentCopy,
  mdiEyeOffOutline,
  mdiEyeOutline,
  mdiLock,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { localized, msg } from '@lit/localize';

import '@shoelace-style/shoelace/dist/components/input/input';
import '@shoelace-style/shoelace/dist/components/icon/icon';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip';

import './room-container';
import { consume } from '@lit/context';
import { sharedStyles } from './sharedStyles';
import { clientContext } from './contexts';
import { RoomClient } from './room-client';
import { RoomInfo } from './types';

@localized()
@customElement('private-room-card')
export class PrivateRoomCard extends LitElement {
  @consume({ context: clientContext })
  @state()
  client!: AppAgentClient;

  @property()
  clonedCell!: ClonedCell;

  @state()
  _showSecretWords = false;

  @state()
  _roomInfo: RoomInfo | undefined;

  async firstUpdated() {
    const roomClient = new RoomClient(this.client, this.clonedCell.clone_id);
    const roomInfo = await roomClient.getRoomInfo();
    if (roomInfo) {
      this._roomInfo = roomInfo;
    }
  }

  render() {
    return html`
      <div class="row personal-room-card secondary-font">
        <div class="column" style="align-items: flex-start">
          <div class="row" style="align-items: center; margin-bottom: 15px; ">
            <sl-icon
              .src=${wrapPathInSvg(mdiLock)}
              style="font-size: 28px; margin-right: 3px; margin-bottom: 4px;"
            ></sl-icon>
            <div
              style="font-weight: bold;${this.clonedCell.name
                ? ''
                : 'opacity: 0.6'}"
            >
              ${this._roomInfo ? this._roomInfo.name : '[unknown]'}
            </div>
          </div>
          <div class="row" style="align-items: center">
            <div class="column" style="align-items: flex-start;">
              <span style="font-size: 18px; font-weight: 600;"
                >secret words:</span
              >
              <div class="row" style="align-items: center">
                <span class="secret-words"
                  >${this._showSecretWords
                    ? this.clonedCell.dna_modifiers.network_seed.replace(
                        'privateRoom#',
                        ''
                      )
                    : '•••••• •••••• •••••• •••••• ••••••'}</span
                >
                <sl-tooltip
                  .content=${this._showSecretWords ? msg('Hide') : msg('Show')}
                >
                  <sl-icon
                    class="eye-icon"
                    title="${this._showSecretWords ? msg('Hide') : msg('Show')}"
                    .src=${this._showSecretWords
                      ? wrapPathInSvg(mdiEyeOffOutline)
                      : wrapPathInSvg(mdiEyeOutline)}
                    @click=${() => {
                      this._showSecretWords = !this._showSecretWords;
                    }}
                  ></sl-icon>
                </sl-tooltip>
                <sl-tooltip .content=${msg('Copy')}>
                  <sl-icon
                    class="copy-icon"
                    title="Copy"
                    .src=${wrapPathInSvg(mdiContentCopy)}
                    @click=${() => {
                      navigator.clipboard.writeText(
                        this.clonedCell.dna_modifiers.network_seed
                      );
                    }}
                  ></sl-icon>
                </sl-tooltip>
              </div>
              <div
                class="column"
                style="align-items: flex-start; margin-top: 10px;"
              >
                <div style="font-size: 18px; font-weight: 600;">dna hash:</div>
                <div style="font-family: sans-serif; font-size: 15px;">
                  ${encodeHashToBase64(this.clonedCell.cell_id[0])}
                </div>
              </div>
            </div>
          </div>
        </div>
        <span style="display: flex; flex: 1;"></span>

        <div class="column" style="justify-content: flex-start;">
          <button
            @click=${() =>
              this.dispatchEvent(
                new CustomEvent('request-open-room', {
                  detail: {
                    cloneId: this.clonedCell.clone_id,
                  },
                  composed: true,
                  bubbles: true,
                })
              )}
            class="enter-room-btn secondary-font"
          >
            <div class="row center-content">
              <img
                src="door.png"
                alt="icon of a door"
                style="height: 25px; margin-right: 6px; transform: scaleX(-1);"
              />
              <span> Enter</span>
            </div>
          </button>
        </div>
      </div>
    `;
  }

  static styles = [
    sharedStyles,
    css`
      .personal-room-card {
        align-items: flex-start;
        min-width: 600px;
        /* background: #40638f; */
        /* background: #668fc2; */
        /* background: #102a4d; */
        background: #b2b9e0;
        /* background: linear-gradient(#b2b9e0, #9ba3d0); */
        background: linear-gradient(#a7aed8, #8f98c9);
        /* background: #ced5fa; */
        padding: 20px 20px;
        border-radius: 25px;
        color: #071b31;
        font-size: 20px;
        box-shadow: 1px 1px 8px 2px #020b16b8;
      }

      .enter-room-btn {
        background: linear-gradient(#102a4d, #071931);
        border-radius: 10px;
        color: #fff0f0;
        border: none;
        padding: 5px 10px;
        box-shadow: 0px 0px 2px 0px #03162f;
        font-weight: 600;
        font-size: 20px;
        cursor: pointer;
      }

      .enter-room-btn:hover {
        background: linear-gradient(#243e61, #0c203a);
      }

      .enter-room-btn:focus {
        background: linear-gradient(#243e61, #0c203a);
      }

      sl-tooltip::part(body) {
        background-color: #05162c;
        color: #ffffff;
        font-size: 16px;
        padding: 0 8px;
        border-radius: 10px;
        box-shadow: 0 0 2px 1px #05162c;
      }

      .secret-words {
        color: #061426;
        font-size: 18px;
        /* background: #cde3ff; */
        font-family: sans-serif;
        background: #fff0f0;
        padding: 3px 8px;
        border-radius: 5px;
        min-width: 400px;
        text-align: center;
      }

      .eye-icon {
        cursor: pointer;
        margin: 0 5px;
      }
      .eye-icon:hover {
        color: white;
      }

      .copy-icon {
        cursor: pointer;
      }
      .copy-icon:hover {
        color: white;
      }
      .copy-icon:active {
        color: #5782dd;
      }
    `,
  ];
}
