import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { AppClient, RoleName } from '@holochain/client';
import { localized } from '@lit/localize';
import { consume, provide } from '@lit/context';
import { WAL, WeaveClient } from '@theweave/api';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import './room-view';

import { RoomStore } from './room-store';
import {
  clientContext,
  roomStoreContext,
  streamsStoreContext,
} from './contexts';
import { RoomClient } from './room-client';
import { sharedStyles } from './sharedStyles';
import { getCellTypes } from './utils';
import { weaveClientContext } from './types';
import { StreamsStore } from './streams-store';

@localized()
@customElement('room-container')
export class RoomContainer extends LitElement {
  @provide({ context: roomStoreContext })
  @property({ type: Object })
  roomStore!: RoomStore;

  @provide({ context: streamsStoreContext })
  @property({ type: Object })
  streamsStore!: StreamsStore;

  @consume({ context: clientContext })
  @state()
  client!: AppClient;

  @consume({ context: weaveClientContext })
  @state()
  weaveClient!: WeaveClient;

  @state()
  @property()
  roleName!: RoleName;

  @property()
  wal!: WAL;

  @state()
  _private = false;

  @state()
  loading = true;

  async firstUpdated() {
    this.roomStore = new RoomStore(
      new RoomClient(this.client, this.roleName, 'room')
    );
    const appInfo = await this.client.appInfo();
    if (!appInfo) throw new Error('AppInfo is null');

    const cellTypes = getCellTypes(appInfo);
    const myCell = cellTypes.cloned.find(
      cell => cell.clone_id === this.roleName
    );
    if (
      myCell &&
      myCell.dna_modifiers.network_seed.startsWith('privateRoom#')
    ) {
      this._private = true;
    }

    this.streamsStore = await StreamsStore.connect(this.roomStore, () =>
      this.weaveClient.userSelectScreen()
    );

    this.loading = false;
  }

  render() {
    if (this.loading) return html``;
    return html` <room-view ?private=${this._private} .wal=${this.wal}></room-view> `;
  }

  static styles = [sharedStyles, css``];
}
