import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ClonedCell, encodeHashToBase64 } from '@holochain/client';
import { mdiContentCopy, mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';

import '@shoelace-style/shoelace/dist/components/input/input';
import '@shoelace-style/shoelace/dist/components/icon/icon';

import './room-container';
import { sharedStyles } from './sharedStyles';

enum PageView {
  Loading,
  Home,
  Room,
}

@customElement('personal-room-card')
export class PersonalRoomCard extends LitElement {
  @property()
  clonedCell!: ClonedCell;

  @state()
  _showSecretWords = false;

  render() {
    return html`
      <div class="row personal-room-card">
        <div class="column" style="align-items: flex-start">
          <div
            style="margin-bottom: 15px; font-weight: bold;${this.clonedCell.name
              ? ''
              : 'opacity: 0.6'}"
          >
            ${this.clonedCell.name ? this.clonedCell.name : '(no name)'}
          </div>
          <div class="row" style="align-items: center">
            <div class="column" style="align-items: flex-start;">
              <span style="font-size: 18px;">secret words:</span>
              <div class="row" style="align-items: center">
                <span class="secret-words"
                  >${this._showSecretWords
                    ? this.clonedCell.dna_modifiers.network_seed
                    : '•••••• •••••• •••••• •••••• ••••••'}</span
                >
                <sl-icon
                  class="eye-icon"
                  title="${this._showSecretWords ? 'Hide' : 'Show'}"
                  .src=${this._showSecretWords
                    ? wrapPathInSvg(mdiEyeOffOutline)
                    : wrapPathInSvg(mdiEyeOutline)}
                  @click=${() => {
                    this._showSecretWords = !this._showSecretWords;
                  }}
                ></sl-icon>
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
              </div>
              <div class="column" style="align-items: flex-start; margin-top: 10px;">
                <div style="font-size: 18px;">dna hash:</div>
                <div style="font-family: sans-serif; font-size: 15px;">${encodeHashToBase64(this.clonedCell.cell_id[0])}</div>
              </div>
            </div>
          </div>
        </div>
        <span style="display: flex; flex: 1;"></span>

        <div>
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
            class="enter-room-btn"
          >
            Join
          </button>
        </div>
      </div>
    `;
  }

  static styles = [
    sharedStyles,
    css`
      .personal-room-card {
        align-items: center;
        min-width: 600px;
        /* background: #40638f; */
        /* background: #668fc2; */
        /* background: #102a4d; */
        background: #ced5fa;
        padding: 15px 23px;
        border-radius: 25px;
        color: #071b31;
        font-size: 20px;
        box-shadow: 1px 1px 2px 1px #000000;
      }

      .enter-room-btn {
        background: #102a4d;
        border-radius: 10px;
        color: #fff0f0;
        border: none;
        padding: 5px 5px;
        font-family: 'Pacifico', sans-serif;
        font-size: 20px;
        width: 80px;
        cursor: pointer;
      }

      .enter-room-btn:hover {
        background: #102a4d95;
      }

      .enter-room-btn:focus {
        background: #102a4d95;
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
        color: #42f03c;
      }
    `,
  ];
}
