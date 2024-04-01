import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  AppAgentClient,
  RoleName,
} from '@holochain/client';
import { localized } from '@lit/localize';
import { consume, provide } from '@lit/context';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import '@holochain-open-dev/elements/dist/elements/holo-identicon.js';
import './room-view';

import { RoomStore } from './room-store';
import { clientContext, roomStoreContext } from './contexts';
import { RoomClient } from './room-client';
import { sharedStyles } from './sharedStyles';
import { getCellTypes } from './utils';


@localized()
@customElement('room-container')
export class RoomContainer extends LitElement {

  @provide({ context: roomStoreContext })
  @property({ type: Object })
  roomStore!: RoomStore;

  @consume({ context: clientContext })
  @state()
  client!: AppAgentClient;

  @state()
  @property()
  roleName!: RoleName;

  @state()
  _private = false;

  async firstUpdated() {
    this.roomStore = new RoomStore(
      new RoomClient(this.client, this.roleName, 'room')
    );
    const appInfo = await this.client.appInfo();
    if (!appInfo) throw new Error('AppInfo is null');

    const cellTypes = getCellTypes(appInfo);
    const myCell = cellTypes.cloned.find((cell) => cell.clone_id === this.roleName);
    if (myCell && myCell.dna_modifiers.network_seed.startsWith("privateRoom#")) {
      this._private = true;
    }

  }

  render() {
    return html`
      <room-view ?private=${this._private}></room-view>
    `;
  }

  static styles = [sharedStyles,
  css``
];
}


