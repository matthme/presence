import '@fontsource/pacifico';
import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  AppAgentWebsocket,
  AppAgentClient,
  ClonedCell,
  CellType,
  RoleName,
  encodeHashToBase64,
  AgentPubKey,
} from '@holochain/client';
import { createContext, provide } from '@lit/context';
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
import { mdiDoor } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';

import '@shoelace-style/shoelace/dist/components/input/input';
import '@shoelace-style/shoelace/dist/components/icon/icon';

import { clientContext } from './contexts';

import './room-container';
import './personal-room-card';
import './list-online-agents';
import { sharedStyles } from './sharedStyles';
import { UnzoomStore } from './unzoom-store';
import { UnzoomClient } from './unzoom-client';

enum PageView {
  Loading,
  Home,
  Room,
}

export const weClientContext = createContext<WeClient>('we_client');

@customElement('unzoom-app')
export class UnzoomApp extends LitElement {
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
  _selectedRoleName: RoleName | undefined;

  @state()
  _displayError: string | undefined;

  @state()
  _groupProfile: GroupProfile | undefined;

  @state()
  _mainRoomClient: UnzoomStore | undefined;

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
      this.client = await AppAgentWebsocket.connect(
        new URL('https://UNUSED'),
        'unzoom'
      );
    }
    this._mainRoomClient = new UnzoomStore(
      new UnzoomClient(this.client, 'unzoom', 'unzoom')
    );
    // Get all personal rooms
    const appInfo = await this.client.appInfo();
    const clonedCells = appInfo.cell_info.unzoom
      .filter(cellInfo => CellType.Cloned in cellInfo)
      .map(
        cellInfo =>
          (cellInfo as { [CellType.Cloned]: ClonedCell })[CellType.Cloned]
      );
    this._personalRooms = clonedCells;
    const loadFinished = Date.now();
    const timeElapsed = loadFinished - start;
    if (timeElapsed > 3000) {
      this._pageView = PageView.Home;
    } else {
      setTimeout(() => {
        this._pageView = PageView.Home;
      }, 3000 - timeElapsed);
    }

    this._unsubscribe = this._mainRoomClient.client.onSignal(async signal => {
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
    if (this._mainRoomClient) {
      const allAgents = await this._mainRoomClient.client.getAllAgents();
      await this._mainRoomClient?.client.pingFrontend(allAgents);
    }
  }

  notifyError(msg: string) {
    this._displayError = msg;
    setTimeout(() => {
      this._displayError = undefined;
    }, 4000);
  }

  async createRoom() {
    if (this._pageView !== PageView.Home) return;
    const roomNameInput = this.shadowRoot?.getElementById('room-name-input') as
      | HTMLInputElement
      | null
      | undefined;
    if (!roomNameInput)
      throw new Error('Room name input field not found in DOM.');
    const networkSeed = generateSillyPassword({ wordCount: 5 });
    const clonedCell = await this.client.createCloneCell({
      role_name: 'unzoom',
      modifiers: {
        network_seed: networkSeed,
      },
      name: roomNameInput.value,
    });
    this._personalRooms = [clonedCell, ...this._personalRooms];
    roomNameInput.value = '';
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
    const roomNameInput2 = this.shadowRoot?.getElementById(
      'room-name-input2'
    ) as HTMLInputElement | null | undefined;
    if (!roomNameInput2)
      throw new Error('Room name input field 2 not found in DOM.');
    if (roomNameInput2.value === '') {
      this.notifyError('Error: Secret words must not be empty.');
      throw new Error('Room name must not be empty.');
    }
    const clonedCell = await this.client.createCloneCell({
      role_name: 'unzoom',
      modifiers: {
        network_seed: secretWordsInput.value,
      },
      name: roomNameInput2.value,
    });
    this._personalRooms = [clonedCell, ...this._personalRooms];
    roomNameInput2.value = '';
    secretWordsInput.value = '';
  }

  render() {
    switch (this._pageView) {
      case PageView.Loading:
        return html`<div class="column center-content" style="color: #c8ddf9; height: 100vh;">
        <div class="entry-logo">unzoom.</div>
          <div>...to see the bigger picture</div>
          <div style="position: absolute; bottom: 20px;">loading...</div>
        </div>`;
      case PageView.Home:
        return html`
          <div
            class="error-message"
            style="${this._displayError ? '' : 'display: none;'}"
          >
            ${this._displayError}
          </div>
          <div
            class="column"
            style="align-items: center; display: flex; flex: 1; width: 100vw;"
          >
            <div class="column top-panel">
              <div style="position: absolute; top: 0; right: 20px;">
                unzoom.
              </div>
              <div style="margin-top: 120px; margin-bottom: 20px;">
                <button
                  class="enter-group-room-btn"
                  @click=${() => {
                    this._selectedRoleName = 'unzoom';
                    this._pageView = PageView.Room;
                  }}
                >
                <div class="row" style="align-items: center;">
                  <sl-icon .src=${wrapPathInSvg(mdiDoor)} style="height: 45px; width: 45px;"></sl-icon><span>${msg("Enter Main Room")}</span>
                </div>
                </button>
              </div>
              ${this._profilesStore
                ? this._activeMainRoomParticipants.length === 0
                  ? html`${msg("The main room is empty.")}`
                  : html`<div class="row" style="align-items: center;">
                  <span style="margin-right: 10px;">${msg("Currently in the main room: ")}</span>
                      <list-online-agents
                        .agents=${this._activeMainRoomParticipants.map(
                          info => info.pubkey
                        )}
                      ></list-online-agents>
                    </div>`
                : html``}
            </div>
            <div class="column bottom-panel">
              <h2>${msg("Personal Rooms:")}</h2>
              <div
                class="row"
                style="flex-wrap: wrap; justify-content: center; align-items: center;"
              >
                <div
                  class="column"
                  style="margin: 0 10px; align-items: center;"
                >
                  <div>${msg("+ Create New Room")}</div>
                  <input
                    id="room-name-input"
                    class="input-field"
                    placeholder="room name (not seen by others)"
                    type="text"
                  />
                  <button
                    class="btn"
                    style="margin-top: 10px;"
                    @click=${async () => this.createRoom()}
                  >
                    ${msg("Create")}
                  </button>
                </div>
                <div
                  class="column"
                  style="margin: 0 10px; align-items: center;"
                >
                  <div>${msg("Join Room")}</div>
                  <input
                    id="room-name-input2"
                    class="input-field"
                    style="margin-bottom: 10px;"
                    placeholder="room name (not seen by others)"
                    type="text"
                  />
                  <input
                    id="secret-words-input"
                    class="input-field"
                    placeholder="secret words"
                    type="text"
                  />
                  <button
                    class="btn"
                    style="margin-top: 10px;"
                    @click=${async () => this.joinRoom()}
                  >
                  ${msg("Join")}
                  </button>
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
                      <personal-room-card
                        .clonedCell=${clonedCell}
                        @request-open-room=${(e: CustomEvent) => {
                          this._selectedRoleName = e.detail.cloneId;
                          this._pageView = PageView.Room;
                        }}
                        style="margin: 7px 0;"
                      ></personal-room-card>
                    `
                  )}
              </div>
              <span style="display: flex; flex: 1;"></span>
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
        max-width: 960px;
        margin: 0;
        text-align: center;
        background: #383b4d;
        font-family: 'Pacifico', sans-serif;
        font-size: 30px;
      }

      .error-message {
        position: fixed;
        bottom: 10px;
        right: 10px;
        padding: 5px 10px;
        border-radius: 10px;
        color: #f3b227;
        background: #7b0e0e;
        box-shadow: 0 0 3px 1px #f3b227;
      }

      .entry-logo {
        font-size: 100px;
        font-family: 'Pacifico' sans-serif;
      }

      h2 {
        font-weight: normal;
      }

      .top-panel {
        background: #ced5fa;
        /* background: #668fc2; */
        display: flex;
        align-items: center;
        min-height: 320px;
        margin: 0;
        width: 100%;
        position: relative;
      }

      .bottom-panel {
        align-items: center;
        color: #c8ddf9;
      }

      .enter-group-room-btn {
        background: #102a4d;
        border-radius: 40px;
        color: #fff0f0;
        border: none;
        padding: 10px 15px;
        padding-right: 25px;
        font-family: 'Pacifico', sans-serif;
        font-size: 30px;
        cursor: pointer;
      }

      .enter-group-room-btn:hover {
        background: #668fc2;
      }

      .enter-group-room-btn:focus {
        background: #668fc2;
      }

      .input-field {
        height: 35px;
        border-radius: 10px;
        border: none;
        font-size: 18px;
        padding-left: 8px;
        min-width: 350px;
      }

      .btn {
        background: #c8ddf9;
        border-radius: 10px;
        color: #081c36;
        border: none;
        padding: 5px 5px;
        font-family: 'Pacifico', sans-serif;
        font-size: 20px;
        width: 80px;
        cursor: pointer;
      }

      .btn:hover {
        background: #ffffff;
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
