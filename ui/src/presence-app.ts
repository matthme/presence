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
import {
  AppAgentWebsocket,
  AppAgentClient,
  ClonedCell,
  RoleName,
  encodeHashToBase64,
  AgentPubKey,
  ProvisionedCell,
  ActionHash,
} from '@holochain/client';
import { provide } from '@lit/context';
import {
  GroupProfile,
  WeClient,
  initializeHotReload,
  isWeContext,
} from '@lightningrodlabs/we-applet';
import { generateSillyPassword } from 'silly-password-generator';
import {
  ProfilesStore,
  profilesStoreContext,
} from '@holochain-open-dev/profiles';
import { msg } from '@lit/localize';
import { v4 as uuidv4 } from 'uuid';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { mdiAccountGroup, mdiLock, mdiLockOpenOutline } from '@mdi/js';

import '@shoelace-style/shoelace/dist/components/input/input';
import '@shoelace-style/shoelace/dist/components/icon/icon';

import { clientContext } from './contexts';

import './room-container';
import './private-room-card';
import './shared-room-card';
import './list-online-agents';
import { sharedStyles } from './sharedStyles';
import { RoomClient } from './room-client';
import { DescendentRoom, weClientContext } from './types';
import { RoomStore } from './room-store';
import { CellTypes, getCellTypes, groupRoomNetworkSeed } from './utils';

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
  client!: AppAgentClient;

  @provide({ context: weClientContext })
  @property({ type: Object })
  _weClient!: WeClient;

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
  _activeMainRoomParticipants: {
    pubkey: AgentPubKey;
    lastSeen: number;
  }[] = [];

  @state()
  _pingInterval: number | undefined;

  @state()
  _unsubscribe: (() => void) | undefined;

  disconnectedCallback(): void {
    if (this._pingInterval) window.clearInterval(this._pingInterval);
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
    if (isWeContext()) {
      const weClient = await WeClient.connect();
      this._weClient = weClient;
      if (
        weClient.renderInfo.type !== 'applet-view' ||
        weClient.renderInfo.view.type !== 'main'
      )
        throw new Error('This Applet only implements the applet main view.');
      this.client = weClient.renderInfo.appletClient;
      this._profilesStore = new ProfilesStore(
        weClient.renderInfo.profilesClient
      );
    } else {
      // We pass an unused string as the url because it will dynamically be replaced in launcher environments
      this.client = await AppAgentWebsocket.connect('presence');
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

    this._unsubscribe = this._mainRoomStore.client.onSignal(async signal => {
      if (signal.type === 'PongUi') {
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
    await this.pingMainRoomAgents();
    this._pingInterval = window.setInterval(async () => {
      await this.pingMainRoomAgents();
      // remove all agents from list that haven't responded in more than 16 seconds, i.e. they missed ~3 pings
      const now = Date.now();
      const newOnlineAgentsList = this._activeMainRoomParticipants.filter(
        info => info.lastSeen + 11000 > now
      );
      this._activeMainRoomParticipants = newOnlineAgentsList;
    }, 5000);
  }

  async pingMainRoomAgents() {
    if (this._mainRoomStore) {
      const allAgents = await this._mainRoomStore.client.getAllAgents();
      await this._mainRoomStore?.client.pingFrontend(allAgents);
    }
  }

  notifyError(msg: string) {
    this._displayError = msg;
    setTimeout(() => {
      this._displayError = undefined;
    }, 4000);
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
    const roomNameInput = this.shadowRoot?.getElementById(
      'private-room-name-input'
    ) as HTMLInputElement | null | undefined;
    if (!roomNameInput)
      throw new Error('Room name input field not found in DOM.');
    if (roomNameInput.value === "" || !roomNameInput.value) {
      this.notifyError("Room name must not be empty.");
      return;
    }
    const randomWords = generateSillyPassword({ wordCount: 5 });
    const clonedCell = await this.client.createCloneCell({
      role_name: 'presence',
      modifiers: {
        network_seed: `privateRoom#${randomWords}`,
      },
    });
    const roomClient = new RoomClient(this.client, clonedCell.clone_id);
    await roomClient.setRoomInfo({
      name: roomNameInput.value,
      icon_src: undefined,
      meta_data: undefined,
    });
    await this.updateRoomLists();
    roomNameInput.value = '';
  }

  async createGroupRoom() {
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
    const appletNetworkSeed = this._provisionedCell.dna_modifiers.network_seed;
    const networkSeed = groupRoomNetworkSeed(appletNetworkSeed, uuid);
    const clonedCell = await this.client.createCloneCell({
      role_name: 'presence',
      modifiers: {
        network_seed: networkSeed,
      },
      name: roomNameInput.value,
    });

    // register it in the main room
    const descendentRoom = {
      network_seed_appendix: uuid,
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
    const clonedCell = await this.client.createCloneCell({
      role_name: 'presence',
      modifiers: {
        network_seed: `privateRoom#${secretWordsInput.value}`,
      },
    });
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
          <div class="secondary-font" style="margin-left: 5px;">${msg('+ Create New Private Room')}</div>
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
              @click=${async () => this.createPrivateRoom()}
            >
              ${msg('Create')}
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
        ${this._personalRooms
          .sort((cell_a, cell_b) =>
            encodeHashToBase64(cell_b.cell_id[0]).localeCompare(
              encodeHashToBase64(cell_a.cell_id[0])
            )
          )
          .map(
            clonedCell => html`
              <private-room-card
                .clonedCell=${clonedCell}
                @request-open-room=${(e: CustomEvent) => {
                  this._selectedRoleName = e.detail.cloneId;
                  this._pageView = PageView.Room;
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
    return groupRooms
      .sort((info_a, info_b) =>
        info_a.room.name.localeCompare(info_b.room.name)
      )
      .map(
        roomInfo => html`
          <shared-room-card
            .groupRoomInfo=${roomInfo}
            @request-open-room=${(e: CustomEvent) => {
              this._selectedRoleName = e.detail.cloneId;
              this._pageView = PageView.Room;
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
          <div class="secondary-font" style="margin-left: 5px;">${msg('+ Create New Shared Room')}</div>
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
              @click=${async () => this.createGroupRoom()}
            >
              ${msg('Create')}
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
          <div class="entry-logo">presence.</div>
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
              >v0.5.0</span
            >
            <div class="column top-panel">
              <div style="position: absolute; top: 0; right: 20px;">
                presence.
              </div>
              <div style="margin-top: 120px; margin-bottom: 20px;">
                <button
                  class="enter-main-room-btn"
                  @click=${() => {
                    this._selectedRoleName = 'presence';
                    this._pageView = PageView.Room;
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
                  ? html`<span class="blue-dark">${msg('The main room is empty.')}</span>`
                  : html`<div class="row blue-dark" style="align-items: center;">
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
              <div
                class="row center-content"
                style="border-radius: 15px; margin-top: 45px;"
              >
                <div
                  tabindex="0"
                  class="row center-content slider-button ${this._showGroupRooms
                    ? 'btn-selected'
                    : ''}"
                  style="border-radius: 15px 0 0 15px;"
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
                  style="border-radius: 0 15px 15px 0;"
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
        if (!this._weClient) return html`loading...`;
        return html`
          <room-container
            class="room-container"
            .roleName=${this._selectedRoleName}
            @quit-room=${() => {
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
        background: linear-gradient(#b2b9e0, #838bb2);
        /* background: #b2b9e0; */
        /* background: #bbc4f2; */
        /* background: #ced5fa; */
        /* background: #668fc2; */
        display: flex;
        align-items: center;
        min-height: 320px;
        margin: 0;
        width: 100%;
        position: relative;
        box-shadow: 0 0 60px 10px #1e2137;
      }

      .bottom-panel {
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
        background: linear-gradient(#243e61, #0c203a);
        /* box-shadow: 0 0 1px 1px #102a4d; */
      }

      .enter-main-room-btn:focus {
        background: linear-gradient(#243e61, #0c203a);
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
        border-radius: 15px 0 0 15px;
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
        background: linear-gradient(#cdd3ec, #afb6da 30%, #afb6da, #929bca);
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

      .btn {
        background: linear-gradient(#cdd3ec, #afb6da 30%, #afb6da, #929bca);
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
