import { LitElement, PropertyValueMap, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  AppAgentClient,
  CellType,
  ClonedCell,
  ProvisionedCell,
  encodeHashToBase64,
} from '@holochain/client';
import { mdiContentCopy, mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';

import '@shoelace-style/shoelace/dist/components/input/input';
import '@shoelace-style/shoelace/dist/components/icon/icon';

import './room-container';
import { consume } from '@lit/context';
import { sharedStyles } from './sharedStyles';
import { clientContext } from './contexts';
import { RoomClient } from './room-client';
import { DescendentRoom, RoomInfo } from './types';
import { getCellTypes, groupRoomNetworkSeed } from './utils';
import { GroupRoomInfo } from './presence-app';

enum PageView {
  Loading,
  Home,
  Room,
}

@customElement('shared-room-card')
export class SharedRoomCard extends LitElement {
  @consume({ context: clientContext })
  @state()
  client!: AppAgentClient;

  @property()
  groupRoomInfo!: GroupRoomInfo;

  @state()
  _showSecretWords = false;

  @state()
  _roomInfo: RoomInfo | undefined;

  @state()
  _myCell: ClonedCell | undefined;

  @state()
  _networkSeed: string | undefined;

  async updateRoomInfo() {
    const appInfo = await this.client.appInfo();
    if (!appInfo) throw new Error('AppInfo is null');
    const cellTypes = getCellTypes(appInfo);
    const appletNetworkSeed = cellTypes.provisioned.dna_modifiers.network_seed;

    const networkSeed = groupRoomNetworkSeed(
      appletNetworkSeed,
      this.groupRoomInfo.room.network_seed_appendix
    );

    const myCell = cellTypes.cloned.find(
      clonedCell => networkSeed === clonedCell.dna_modifiers.network_seed
    );
    this._networkSeed = networkSeed;
    if (myCell) {
      this._myCell = myCell;
      const roomClient = new RoomClient(this.client, myCell.clone_id);
      const roomInfo = await roomClient.getRoomInfo();
      if (roomInfo) {
        this._roomInfo = roomInfo;
      }
    } else {
      this._roomInfo = {
        name: this.groupRoomInfo.room.name,
        icon_src: this.groupRoomInfo.room.icon_src,
        meta_data: this.groupRoomInfo.room.meta_data,
      };
    }
  }

  async firstUpdated() {
    await this.updateRoomInfo();
  }
  async willUpdate(
    changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ) {
    if (changedProperties.has('groupRoomInfo')) {
      await this.updateRoomInfo();
    }
  }

  async handleOpenRoom() {
    // If the cell is not installed yet, install it first
    if (!this._myCell) {
      console.log('Installing cell.');
      // network seed must be defined at this point
      if (!this._networkSeed) throw new Error('Network seed undefined.');
      this._myCell = await this.client.createCloneCell({
        role_name: 'presence',
        modifiers: {
          network_seed: this._networkSeed,
        },
      });
      const roomClient = new RoomClient(this.client, this._myCell.clone_id);
      const roomInfo = await roomClient.getRoomInfo();
      if (roomInfo) {
        this._roomInfo = roomInfo;
      }
    }

    this.dispatchEvent(
      new CustomEvent('request-open-room', {
        detail: {
          cloneId: this._myCell!.clone_id,
        },
        composed: true,
        bubbles: true,
      })
    );
  }

  render() {
    return html`
      <div
        class="column shared-room-card"
        style="align-items: flex-start; flex: 1;"
      >
        <div class="row secondary-font" style="align-items: flex-start; flex: 1; width: 100%;">
          <div
            style="margin-bottom: 15px; font-size: 26px; font-weight: bold;${this._roomInfo?.name
              ? ''
              : 'opacity: 0.6'}"
          >
            ${this._roomInfo ? this._roomInfo.name : '[unknown]'}
          </div>
          <span style="display: flex; flex: 1;"></span>
          <button
            @click=${() => this.handleOpenRoom()}
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
      .shared-room-card {
        align-items: flex-start;
        min-width: 600px;
        /* background: #40638f; */
        /* background: #668fc2; */
        /* background: #102a4d; */
        /* background: #b2b9e0; */
        background: linear-gradient(#b2b9e0, #9ba3d0);
        /* background-image: url(); */
        /* object-fit: cover; */
        /* background-position: center center; */
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
