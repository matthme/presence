/* eslint-disable no-console */
import '@fontsource/pacifico';
import '@fontsource/gabriela';
import '@fontsource-variable/noto-sans-sc';
// Supports weights 400-800
import '@fontsource-variable/baloo-2';
import '@fontsource/ubuntu/300-italic.css';
import '@fontsource/ubuntu/400-italic.css';
import '@fontsource/ubuntu/500-italic.css';
import '@fontsource/ubuntu/700-italic.css';
import '@fontsource/ubuntu/300.css';
import '@fontsource/ubuntu/400.css';
import '@fontsource/ubuntu/500.css';
import '@fontsource/ubuntu/700.css';
import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import {
  AppWebsocket,
  AppClient,
  ClonedCell,
  RoleName,
  encodeHashToBase64,
  AgentPubKey,
  ProvisionedCell,
  ActionHash,
} from '@holochain/client';
import { provide } from '@lit/context';
import {
  AppletServices,
  MossAccountability,
  GroupProfile,
  NULL_HASH,
  WAL,
  WeaveClient,
  initializeHotReload,
  isWeaveContext,
} from '@theweave/api';
import { generateSillyPassword } from 'silly-password-generator';
import {
  ProfilesStore,
  profilesStoreContext,
} from '@holochain-open-dev/profiles';
import { msg } from '@lit/localize';
import { v4 as uuidv4 } from 'uuid';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import {
  mdiAccountGroup,
  mdiDoor,
  mdiLock,
  mdiLockOpenOutline,
  mdiRefresh,
} from '@mdi/js';

import '@shoelace-style/shoelace/dist/components/input/input';
import '@shoelace-style/shoelace/dist/components/icon/icon';

import { clientContext } from './contexts';

import './room/room-container';
import './lobby/private-room-card';
import './lobby/shared-room-card';
import './lobby/list-online-agents';
import { sharedStyles } from './sharedStyles';
import { RoomClient } from './room/room-client';
import { DescendentRoom, weaveClientContext } from './types';
import { RoomStore } from './room/room-store';
import { CellTypes, getCellTypes, groupRoomNetworkSeed } from './utils';

declare const __APP_VERSION__: string;

enum PageView {
  Loading,
  Home,
  Room,
}

export type GroupRoomInfo = {
  room: DescendentRoom;
  creator: AgentPubKey;
  linkActionHash: ActionHash;
};

@customElement('presence-app')
export class PresenceApp extends LitElement {
  @provide({ context: clientContext })
  @property({ type: Object })
  client!: AppClient;

  @provide({ context: weaveClientContext })
  @property({ type: Object })
  _weaveClient!: WeaveClient;

  @provide({ context: profilesStoreContext })
  @property({ type: Object })
  _profilesStore!: ProfilesStore;

  @state()
  _pageView: PageView = PageView.Loading;

  @state()
  _personalRooms: ClonedCell[] = [];

  @state()
  _groupRooms: GroupRoomInfo[] = [];

  @state()
  _selectedRoleName: RoleName | undefined;

  @state()
  _selectedWal: WAL | undefined;

  @state()
  _displayError: string | undefined;

  @state()
  _groupProfile: GroupProfile | undefined;

  @state()
  _mainRoomStore: RoomStore | undefined;

  @state()
  _showGroupRooms = true;

  @state()
  _provisionedCell: ProvisionedCell | undefined;

  @state()
  _myAccountabilities: MossAccountability[] | undefined;

  @state()
  _activeMainRoomParticipants: {
    pubkey: AgentPubKey;
    lastSeen: number;
  }[] = [];

  @state()
  _clearActiveParticipantsInterval: number | undefined;

  @state()
  _refreshing = false;

  @state()
  _creatingRoom = false;

  @state()
  externalWindow = false;

  @state()
  _unsubscribe: (() => void) | undefined;

  disconnectedCallback(): void {
    if (this._clearActiveParticipantsInterval)
      window.clearInterval(this._clearActiveParticipantsInterval);
    if (this._unsubscribe) this._unsubscribe();
  }

  async firstUpdated() {
    const start = Date.now();
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
    if (isWeaveContext()) {
      const appletServices: AppletServices = {
        creatables: {},
        blockTypes: {},
        getAssetInfo: async (appletClient, wal, _recordInfo) => {
          // eslint-disable-next-line no-debugger
          // debugger;
          const appInfo = await appletClient.appInfo();
          if (!appInfo) throw new Error('AppInfo undefined.');
          const cellTypes = getCellTypes(appInfo as any);
          const dnaHashB64 = encodeHashToBase64(wal.hrl[0]);
          // alert(dnaHashB64);
          const mainRoomCell = cellTypes.provisioned;
          if (encodeHashToBase64(mainRoomCell.cell_id[0]) === dnaHashB64) {
            return {
              name: 'Main Room',
              icon_src: wrapPathInSvg(mdiDoor),
            };
          }
          // take room info from cached value if it exists
          const maybeRoomInfo = this._groupRooms.find(
            roomInfo =>
              encodeHashToBase64(roomInfo.room.dna_hash) === dnaHashB64
          );
          if (maybeRoomInfo) {
            return {
              name: maybeRoomInfo.room.name,
              icon_src: wrapPathInSvg(mdiDoor),
            };
          }

          const maybeClonedCell = cellTypes.cloned.find(
            cell => encodeHashToBase64(cell.cell_id[0]) === dnaHashB64
          );
          if (maybeClonedCell) {
            const roomClient = new RoomClient(
              this.client,
              maybeClonedCell.clone_id
            );
            const roomInfo = await roomClient.getRoomInfo();
            if (roomInfo)
              return {
                name: roomInfo.name,
                icon_src: wrapPathInSvg(mdiDoor),
              };
          }
          return Promise.resolve(undefined);
        },
        search: () => Promise.resolve([]),
      };
      const weaveClient = await WeaveClient.connect(appletServices);
      this._weaveClient = weaveClient;
      if (
        weaveClient.renderInfo.type !== 'applet-view' ||
        !['main', 'asset'].includes(weaveClient.renderInfo.view.type)
      )
        throw new Error(
          'This Applet only implements the applet main and asset views.'
        );
      this.client = weaveClient.renderInfo.appletClient as any;
      this._profilesStore = new ProfilesStore(
        weaveClient.renderInfo.profilesClient as any
      );
    } else {
      // We pass an unused string as the url because it will dynamically be replaced in launcher environments
      this.client = await AppWebsocket.connect();
    }

    if (
      this._weaveClient.renderInfo.type === 'applet-view' &&
      this._weaveClient.renderInfo.view.type === 'asset'
    ) {
      this.externalWindow = true;
      const appInfo = await this.client.appInfo();
      if (!appInfo) throw new Error('AppInfo is null');

      const cellTypes = getCellTypes(appInfo);

      const wal = this._weaveClient.renderInfo.view.wal;
      const dnaHash = wal.hrl[0];
      const dnaHashB64 = encodeHashToBase64(dnaHash);

      this._selectedWal = wal;

      if (encodeHashToBase64(cellTypes.provisioned.cell_id[0]) === dnaHashB64) {
        this._selectedRoleName = 'presence';
        this._pageView = PageView.Room;
        return;
      }
      const clonedCell = cellTypes.cloned.find(
        cellInfo => encodeHashToBase64(cellInfo.cell_id[0]) === dnaHashB64
      );
      if (!clonedCell) throw Error('No cell found for WAL');
      this._selectedRoleName = clonedCell.clone_id;
      this._pageView = PageView.Room;
      return;
    }

    this._mainRoomStore = new RoomStore(
      new RoomClient(this.client, 'presence', 'room')
    );

    const cellTypes = await this.updateRoomLists();

    this._provisionedCell = cellTypes.provisioned;

    const loadFinished = Date.now();
    const timeElapsed = loadFinished - start;
    if (timeElapsed > 3000) {
      this._pageView = PageView.Home;
    } else {
      setTimeout(() => {
        this._pageView = PageView.Home;
      }, 3000 - timeElapsed);
    }

    this._clearActiveParticipantsInterval = window.setInterval(() => {
      const now = Date.now();
      // If an agent hasn't sent a ping for more than 10 seconds, assume that they are no longer in the room
      this._activeMainRoomParticipants =
        this._activeMainRoomParticipants.filter(
          info => now - info.lastSeen < 10000
        );
    }, 10000);

    this._unsubscribe = this._mainRoomStore.client.onSignal(async signal => {
      if (signal.type === 'PingUi') {
        // This is the case if the other agent is in the main room
        const newOnlineAgentsList = this._activeMainRoomParticipants.filter(
          info => info.pubkey.toString() !== signal.from_agent.toString()
        );
        newOnlineAgentsList.push({
          pubkey: signal.from_agent,
          lastSeen: Date.now(),
        });
        this._activeMainRoomParticipants = newOnlineAgentsList;
      }
    });
  }

  notifyError(msg: string) {
    this._displayError = msg;
    setTimeout(() => {
      this._displayError = undefined;
    }, 4000);
  }

  async checkPermission(): Promise<void> {
    let accountabilities: MossAccountability[] = this._myAccountabilities || [];
    if (!this._myAccountabilities && this._weaveClient.renderInfo.type === 'applet-view') {
      const accountbilitiesPerGroup = await this._weaveClient.myAccountabilitiesPerGroup();
      if (this._weaveClient.renderInfo.groupHash) {
        const groupHash = encodeHashToBase64(this._weaveClient.renderInfo.groupHash);
        const maybeAccountabilities = accountbilitiesPerGroup.find(([hash,_])=> encodeHashToBase64(hash) ===groupHash)
        if (maybeAccountabilities) {
          accountabilities = maybeAccountabilities[1]
          this._myAccountabilities = accountabilities
        }
      }
    }
    let amIPrivieged = false
    for (const acc of accountabilities) {
      if (acc.role.name === 'Steward' || acc.role.name === 'Progenitor') {
        amIPrivieged = true;
      }
    }
    if (!amIPrivieged) {
      this.notifyError(
        'Only group Stewards are allowed to create shared rooms.'
      );
      throw new Error(
        'Only group Stewards are allowed to create shared rooms.'
      );
    }
  }

  async updateRoomLists(): Promise<CellTypes> {
    // Get all personal rooms
    const appInfo = await this.client.appInfo();
    if (!appInfo) throw new Error('AppInfo is null');

    const cellTypes = getCellTypes(appInfo);

    this._personalRooms = cellTypes.cloned.filter(cell =>
      cell.dna_modifiers.network_seed.startsWith('privateRoom#')
    );

    const allDescendentRooms =
      await this._mainRoomStore!.client.getAllDescendentRooms();
    this._groupRooms = allDescendentRooms.map(
      ([room, creator, linkActionHash]) => ({ room, creator, linkActionHash })
    );

    return cellTypes;
  }

  async createPrivateRoom() {
    if (this._pageView !== PageView.Home) return;
    this._creatingRoom = true;
    try {
      const roomNameInput = this.shadowRoot?.getElementById(
        'private-room-name-input'
      ) as HTMLInputElement | null | undefined;
      if (!roomNameInput)
        throw new Error('Room name input field not found in DOM.');
      if (roomNameInput.value === '' || !roomNameInput.value) {
        this.notifyError('Room name must not be empty.');
        return;
      }
      const randomWords = generateSillyPassword({ wordCount: 5 });
      const clonedCell = await this._weaveClient.createCloneCell(
        {
          role_name: 'presence',
          modifiers: {
            network_seed: `privateRoom#${randomWords}`,
          },
        },
        false // This is a private clone
      );
      // Get AppInfo to update cachedAppInfo in AppClient (this should be fixed either with
      // a workaround in Moss or in the js-client)
      await this.client.appInfo();
      const roomClient = new RoomClient(this.client, clonedCell.clone_id);
      await roomClient.setRoomInfo({
        name: roomNameInput.value,
        icon_src: undefined,
        meta_data: undefined,
      });
      await this.updateRoomLists();
      roomNameInput.value = '';
      this._creatingRoom = false;
    } catch (e) {
      this._creatingRoom = false;
      throw e;
    }
  }

  async createGroupRoom() {
    this._creatingRoom = true;
    try {
      await this.checkPermission();
      if (this._pageView !== PageView.Home) return;
      const roomNameInput = this.shadowRoot?.getElementById(
        'group-room-name-input'
      ) as HTMLInputElement | null | undefined;
      if (!roomNameInput)
        if (!roomNameInput)
          throw new Error('Group room name input field not found in DOM.');
      if (roomNameInput.value === '') {
        this.notifyError('Error: Room name input field must not be empty.');
        throw new Error('Room name must not be empty.');
      }

      if (!this._provisionedCell)
        throw new Error('Provisioned cell not defined.');
      if (!this._mainRoomStore)
        throw new Error('Main Room Store is not defined.');
      // network seed is composed of
      const uuid = uuidv4();
      const appletNetworkSeed =
        this._provisionedCell.dna_modifiers.network_seed;
      const networkSeed = groupRoomNetworkSeed(appletNetworkSeed, uuid);
      const clonedCell = await this._weaveClient.createCloneCell(
        {
          role_name: 'presence',
          modifiers: {
            network_seed: networkSeed,
          },
          name: roomNameInput.value,
        },
        true // This is a public clone
      );

      // Get AppInfo to update cachedAppInfo in AppClient (this should be fixed either with
      // a workaround in Moss or in the js-client)
      await this.client.appInfo();

      // register it in the main room
      const descendentRoom = {
        network_seed_appendix: uuid,
        dna_hash: clonedCell.cell_id[0],
        name: roomNameInput.value,
        icon_src: undefined,
        meta_data: undefined,
      };
      const linkActionHash =
        await this._mainRoomStore.client.createDescendentRoom(descendentRoom);

      const roomClient = new RoomClient(this.client, clonedCell.clone_id);
      await roomClient.setRoomInfo({
        name: roomNameInput.value,
        icon_src: undefined,
        meta_data: undefined,
      });

      roomNameInput.value = '';

      const groupRoomInfo: GroupRoomInfo = {
        room: descendentRoom,
        creator: clonedCell.cell_id[1],
        linkActionHash,
      };
      this._groupRooms = [...this._groupRooms, groupRoomInfo];
      this._creatingRoom = false;
    } catch (e) {
      this._creatingRoom = false;
      throw e;
    }
  }

  async joinRoom() {
    if (this._pageView !== PageView.Home) return;
    const secretWordsInput = this.shadowRoot?.getElementById(
      'secret-words-input'
    ) as HTMLInputElement | null | undefined;
    if (!secretWordsInput)
      throw new Error('Secret words input field not found in DOM.');
    if (secretWordsInput.value === '') {
      this.notifyError('Error: Secret words must not be empty.');
      throw new Error('Secret words must not be empty.');
    }
    const clonedCell = await this._weaveClient.createCloneCell(
      {
        role_name: 'presence',
        modifiers: {
          network_seed: `privateRoom#${secretWordsInput.value}`,
        },
      },
      false // This is a private clone
    );
    // Get AppInfo to update cachedAppInfo in AppClient (this should be fixed either with
    // a workaround in Moss or in the js-client)
    await this.client.appInfo();
    this._personalRooms = [clonedCell, ...this._personalRooms];
    secretWordsInput.value = '';
  }

  renderPrivateRooms() {
    return html`
      <div
        class="column"
        style="flex-wrap: wrap; justify-content: center; align-items: center; margin-top: 30px;"
      >
        <div
          class="column"
          style="margin: 0 10px; align-items: flex-start; color: #e1e5fc;"
        >
          <div class="secondary-font" style="margin-left: 5px;">
            ${msg('+ Create New Private Room')}
          </div>
          <div class="row" style="align-items: center;">
            <input
              id="private-room-name-input"
              class="input-field"
              placeholder="room name"
              type="text"
            />
            <button
              class="btn"
              style="margin-left: 10px;"
              ?disabled=${this._creatingRoom}
              @click=${async () => this.createPrivateRoom()}
            >
              ${this._creatingRoom ? msg('...') : msg('Create')}
            </button>
          </div>
        </div>
        <div
          class="column"
          style="margin: 0 10px; align-items: flex-start; color: #e1e5fc; margin-top: 12px;"
        >
          <div class="row" style="align-items: center;">
            <sl-icon
              .src=${wrapPathInSvg(mdiLockOpenOutline)}
              style="margin-right: 3px; margin-bottom: 4px; margin-left: 5px;"
            ></sl-icon>
            <div class="secondary-font">${msg('Join Private Room')}</div>
          </div>
          <div class="row" style="align-items: center;">
            <input
              id="secret-words-input"
              class="input-field"
              placeholder="secret words"
              type="text"
            />
            <button
              class="btn"
              style="margin-left: 10px;"
              @click=${async () => this.joinRoom()}
            >
              ${msg('Join')}
            </button>
          </div>
        </div>
      </div>
      <div
        class="column"
        style="margin-top: 40px; align-items: center; margin-bottom: 80px;"
      >
        ${repeat(
          this._personalRooms.sort((cell_a, cell_b) =>
            encodeHashToBase64(cell_b.cell_id[0]).localeCompare(
              encodeHashToBase64(cell_a.cell_id[0])
            )
          ),
          clonedCell => clonedCell.clone_id,
          clonedCell => html`
            <private-room-card
              .clonedCell=${clonedCell}
              @request-open-room=${async (e: CustomEvent) => {
                try {
                  await (this._weaveClient as any).openAsset(
                    {
                      hrl: [clonedCell.cell_id[0], NULL_HASH],
                    },
                    'window'
                  );
                } catch (err) {
                  console.warn('Failed to open room in external window: ', err);
                  this._selectedRoleName = clonedCell.clone_id;
                  this._pageView = PageView.Room;
                }
              }}
              style="margin: 7px 0;"
            ></private-room-card>
          `
        )}
      </div>
      <span style="display: flex; flex: 1;"></span>
    `;
  }

  renderSharedRoomCards(groupRooms: GroupRoomInfo[]) {
    if (this._refreshing)
      return html`<span style="margin-top: 50px;"
        >Refreshing...<span></span
      ></span>`;
    return repeat(
      groupRooms.sort((info_a, info_b) =>
        info_a.room.name.localeCompare(info_b.room.name)
      ),
      roomInfo => encodeHashToBase64(roomInfo.linkActionHash),
      roomInfo => html`
        <shared-room-card
          .groupRoomInfo=${roomInfo}
          @request-open-room=${async (e: { detail: ClonedCell }) => {
            try {
              await (this._weaveClient as any).openAsset(
                {
                  hrl: [e.detail.cell_id[0], NULL_HASH],
                },
                'window'
              );
            } catch (err) {
              console.warn('Failed to open room in external window: ', err);
              this._selectedRoleName = e.detail.clone_id;
              this._pageView = PageView.Room;
            }
          }}
          style="margin: 7px 0;"
        ></shared-room-card>
      `
    );
  }

  renderGroupRooms() {
    return html`
      <div
        class="row"
        style="flex-wrap: wrap; justify-content: center; align-items: center; margin-top: 30px;"
      >
        <div
          class="column"
          style="margin: 0 10px; align-items: flex-start; color: #e1e5fc;"
        >
          <div class="secondary-font" style="margin-left: 5px;">
            ${msg('+ Create New Shared Room')}
          </div>
          <div class="row" style="align-items: center;">
            <input
              id="group-room-name-input"
              class="input-field"
              placeholder="room name"
              type="text"
            />
            <button
              class="btn"
              style="margin-left: 10px;"
              ?disabled=${this._creatingRoom}
              @click=${async () => this.createGroupRoom()}
            >
              ${this._creatingRoom ? msg('...') : msg('Create')}
            </button>
          </div>
        </div>
      </div>
      <div
        class="column"
        style="margin-top: 40px; align-items: center; margin-bottom: 80px;"
      >
        ${this.renderSharedRoomCards(this._groupRooms)}
      </div>
      <span style="display: flex; flex: 1;"></span>
    `;
  }

  render() {
    switch (this._pageView) {
      case PageView.Loading:
        return html`<div
          class="column center-content"
          style="color: #c8ddf9; height: 100vh;"
        >
          <div class="entry-logo">presence</div>
          <!-- <div>...and see the bigger picture</div> -->
          <div style="position: absolute; bottom: 20px;">loading...</div>
        </div>`;
      case PageView.Home:
        return html`
          <div
            class="error-message secondary-font"
            style="${this._displayError ? '' : 'display: none;'}"
          >
            ${this._displayError}
          </div>
          <div
            class="column"
            style="align-items: center; display: flex; flex: 1; width: 100vw;"
          >
            <span
              style="position: fixed; bottom: 0; left: 5px; color: #c8ddf9; font-size: 16px;"
              >${__APP_VERSION__}</span
            >
            <div class="column top-panel">
              <div style="position: absolute; top: 0; right: 20px;">
                presence.
              </div>
              <div style="margin-top: 120px; margin-bottom: 20px;">
                <button
                  class="enter-main-room-btn"
                  @click=${async () => {
                    await (this._weaveClient as any).openAsset(
                      {
                        hrl: [this._provisionedCell!.cell_id[0], NULL_HASH],
                      },
                      'window'
                    );
                    // this._selectedRoleName = 'presence';
                    // this._pageView = PageView.Room;
                  }}
                >
                  <div class="row" style="align-items: center;">
                    <img
                      src="door.png"
                      alt="icon of a door"
                      style="height: 45px; margin-right: 10px; margin-left: 10px; transform: scaleX(-1);"
                    />
                    <span>${msg('Enter Main Room')}</span>
                  </div>
                </button>
              </div>
              ${this._profilesStore
                ? this._activeMainRoomParticipants.length === 0
                  ? html`<span class="blue-dark"
                      >${msg('The main room is empty.')}</span
                    >`
                  : html`<div
                      class="row blue-dark"
                      style="align-items: center;"
                    >
                      <span style="margin-right: 10px;"
                        >${msg('Currently in the main room: ')}</span
                      >
                      <list-online-agents
                        .agents=${this._activeMainRoomParticipants.map(
                          info => info.pubkey
                        )}
                      ></list-online-agents>
                    </div>`
                : html``}
            </div>
            <div class="column bottom-panel">
              <button
                class="refresh-btn"
                @click=${async () => {
                  this._refreshing = true;
                  await this.updateRoomLists();
                  setTimeout(() => {
                    this._refreshing = false;
                  }, 200);
                }}
              >
                <div class="row center-content">
                  <sl-icon .src=${wrapPathInSvg(mdiRefresh)}></sl-icon>
                  <span style="margin-left: 2px;"> ${msg('refresh')}</span>
                </div>
              </button>
              <div
                class="row center-content"
                style="border-radius: 15px; margin-top: 48px;"
              >
                <div
                  tabindex="0"
                  class="row center-content slider-button ${this._showGroupRooms
                    ? 'btn-selected'
                    : ''}"
                  @click=${() => {
                    this._showGroupRooms = true;
                  }}
                  @keypress=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                      this._showGroupRooms = true;
                    }
                  }}
                >
                  <sl-icon
                    .src=${wrapPathInSvg(mdiAccountGroup)}
                    style="font-size: 30px; margin-right: 5px;"
                  ></sl-icon>
                  <div style="margin-bottom: -6px;">${msg('Shared Rooms')}</div>
                </div>
                <div
                  tabindex="0"
                  class="row center-content slider-button ${this._showGroupRooms
                    ? ''
                    : 'btn-selected'}"
                  style="border-radius: 3px 25px 25px 3px;"
                  @click=${() => {
                    this._showGroupRooms = false;
                  }}
                  @keypress=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                      this._showGroupRooms = false;
                    }
                  }}
                >
                  <sl-icon
                    .src=${wrapPathInSvg(mdiLock)}
                    style="font-size: 30px; margin-right: 5px;"
                  ></sl-icon>
                  <div style="margin-bottom: -6px;">
                    ${msg('Private Rooms')}
                  </div>
                </div>
              </div>
              ${this._showGroupRooms
                ? this.renderGroupRooms()
                : this.renderPrivateRooms()}
            </div>
          </div>
        `;
      case PageView.Room:
        if (!this._weaveClient) return html`loading...`;
        return html`
          <room-container
            class="room-container"
            .roleName=${this._selectedRoleName}
            .wal=${this._selectedWal}
            @quit-room=${async () => {
              if (this.externalWindow) {
                console.log('Closing window.');
                await this._weaveClient.requestClose();
              }
              this._pageView = PageView.Home;
            }}
          ></room-container>
        `;
      default:
        return PageView.Home;
    }
  }

  static styles = [
    sharedStyles,
    css`
      :host {
        min-height: 100vh;
        min-width: 100vw;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        font-size: calc(10px + 2vmin);
        color: #102a4d;
        margin: 0;
        padding: 0;
        text-align: center;
        background: #2b304a;
        /* background: #383b4d; */
        font-family: 'Pacifico', sans-serif;
        font-size: 30px;
      }

      .error-message {
        position: fixed;
        bottom: 10px;
        right: 10px;
        padding: 5px 10px;
        border-radius: 10px;
        color: #f8c7c7;
        background: linear-gradient(#8b1616, #8b1616 30%, #6e0a0a);
        /* background: #7b0e0e; */
        box-shadow: 0 0 3px 1px #721c1c;
      }

      .entry-logo {
        font-size: 100px;
        font-family: 'Pacifico' sans-serif;
      }

      h2 {
        font-weight: normal;
      }

      .top-panel {
        /* background: linear-gradient(#b2b9e0, #838bb2); */
        /* background: linear-gradient(#9da6db, #717bae); */
        background: linear-gradient(#a1aad9, #7780af);
        /* background: #b2b9e0; */
        /* background: #bbc4f2; */
        /* background: #ced5fa; */
        /* background: #668fc2; */
        display: flex;
        align-items: center;
        min-height: 315px;
        margin: 0;
        width: 100%;
        position: relative;
        box-shadow: 0 0 60px 10px #1e2137;
      }

      .bottom-panel {
        width: 100vw;
        position: relative;
        align-items: center;
        color: #bbc4f2;
      }

      .enter-main-room-btn {
        background: linear-gradient(#102a4d, #071931);
        /* background: linear-gradient(#102a4d, #0d2646); */
        border-radius: 40px;
        color: #fff0f0;
        border: none;
        padding: 10px 15px;
        padding-right: 25px;
        font-family: 'Pacifico', sans-serif;
        font-size: 35px;
        box-shadow: 1px 1px 4px 2px #03162f;
        cursor: pointer;
      }

      .enter-main-room-btn:hover {
        background: linear-gradient(#293c7f, #0c203a);
        /* box-shadow: 0 0 1px 1px #102a4d; */
      }

      .enter-main-room-btn:focus-visible {
        background: linear-gradient(#2c477f, #0c203a);
        /* box-shadow: 0 0 1px 1px #102a4d; */
      }

      .blue-dark {
        color: #0a1c35;
      }

      .slider-button {
        align-items: center;
        /* background: #383b4d; */
        /* background: #2f3141; */
        background: linear-gradient(#1b1f35, #282b42 30%, #282b42);
        color: #e1e5fc;
        height: 54px;
        border-radius: 25px 3px 3px 25px;
        padding: 2px 15px;
        box-shadow: 0 0 4px 2px black inset;
        cursor: pointer;
        font-family: 'Baloo 2 Variable', sans-serif;
        font-weight: 600;
        font-size: 26px;
      }

      .slider-button:hover:not(.btn-selected) {
        background: linear-gradient(#4d547a52, #7b82ad52 30%, #7981ad52);
        /* background: #8b90ae52; */
        /* color: #383b4d; */
      }

      .slider-button:focus:not(.btn-selected) {
        background: linear-gradient(#4d547a52, #7b82ad52 30%, #7981ad52);
        /* background: #8b90ae52; */
        /* color: #383b4d; */
      }

      .btn-selected {
        /* background: #b1bbee; */
        /* background: #afb6da; */
        /* background: linear-gradient(#cdd3ec, #afb6da 30%, #afb6da, #929bca); */
        background: linear-gradient(#c2cae8, #a5add8 30%, #a5add8, #8994c7);
        /* background: linear-gradient(#aeb8e5, #96a1d4 30%, #96a1d4, #7a86c3); */
        /* background: linear-gradient(#b3bce4, #9ca6d4 30%, #9ca6d4, #838ec5); */
        color: #1d1f2c;
        padding: 0 15px;
        box-shadow: 0 0 6px 2px black;
      }

      .input-field {
        height: 40px;
        border-radius: 10px;
        border: none;
        font-size: 18px;
        padding-left: 8px;
        min-width: 350px;
        box-shadow: 0 0 2px 1px #1c1e2e inset;
        background: linear-gradient(#eaecf3, #eaecf3 20%, #ffffff);
      }

      .refresh-btn {
        background: transparent;
        color: #e1e5fc;
        font-size: 1.2rem;
        position: absolute;
        top: 20px;
        right: 20px;
        border: none;
        font-weight: 600;
        font-family: 'Baloo 2 Variable', sans-serif;
        cursor: pointer;
      }

      .refresh-btn:active {
        color: #ffffff;
      }

      .btn {
        /* background: linear-gradient(#cdd3ec, #afb6da 30%, #1b1d24, #929bca); */
        background: linear-gradient(#c2cae8, #a5add8 30%, #a5add8, #8994c7);
        /* background: linear-gradient(#aeb8e5, #96a1d4 30%, #96a1d4, #7a86c3); */
        /* background: linear-gradient(#b3bce4, #9ca6d4 30%, #9ca6d4, #838ec5); */
        box-shadow: 0 0 5px 1px #1d1d1d;
        /* background: #bbc4f2; */
        border-radius: 10px;
        color: #081c36;
        border: none;
        padding: 5px 5px;
        /* font-family: 'Pacifico', sans-serif; */
        font-family: 'Baloo 2 Variable', sans-serif;
        font-weight: 600;
        font-size: 20px;
        width: 80px;
        cursor: pointer;
      }

      .btn:hover {
        background: linear-gradient(#e9ecf9, #c8cee8 30%, #c8cee8, #929bca);
      }

      .btn:focus {
        background: #ffffff;
      }

      .room-container {
        display: flex;
        flex: 1;
        margin: 0;
      }
    `,
  ];
}
