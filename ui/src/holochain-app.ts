import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  AppAgentWebsocket,
  AppAgentClient,
  ClonedCell,
  CellType,
  RoleName,
} from '@holochain/client';
import { provide } from '@lit-labs/context';
import {
  WeClient,
  initializeHotReload,
  isWeContext,
} from '@lightningrodlabs/we-applet';
import { generateSillyPassword } from 'silly-password-generator';
import '@fontsource/pacifico';

import '@shoelace-style/shoelace/dist/components/input/input';
import '@shoelace-style/shoelace/dist/components/icon/icon';

import { clientContext } from './contexts';

import './room-container';
import './personal-room-card';
import { sharedStyles } from './sharedStyles';

enum PageView {
  Loading,
  Home,
  Room,
}

@customElement('holochain-app')
export class HolochainApp extends LitElement {
  @provide({ context: clientContext })
  @property({ type: Object })
  client!: AppAgentClient;

  @state()
  _pageView: PageView = PageView.Loading;

  @state()
  _personalRooms: ClonedCell[] = [];

  @state()
  _selectedRoleName: RoleName | undefined;

  async firstUpdated() {
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
      if (
        weClient.renderInfo.type !== 'applet-view' ||
        weClient.renderInfo.view.type !== 'main'
      )
        throw new Error('This Applet only implements the applet main view.');
      this.client = weClient.renderInfo.appletClient;
    } else {
      // We pass an unused string as the url because it will dynamically be replaced in launcher environments
      this.client = await AppAgentWebsocket.connect(
        new URL('https://UNUSED'),
        'unzoom'
      );
    }
    // Get all personal rooms
    const appInfo = await this.client.appInfo();
    const clonedCells = appInfo.cell_info.unzoom
      .filter(cellInfo => CellType.Cloned in cellInfo)
      .map(
        cellInfo =>
          (cellInfo as { [CellType.Cloned]: ClonedCell })[CellType.Cloned]
      );
    this._personalRooms = clonedCells;
    this._pageView = PageView.Home;
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
  }

  render() {
    switch (this._pageView) {
      case PageView.Loading:
        return html` loading... `;
      case PageView.Home:
        return html`
          <div class="column" style="align-items: center; display: flex; flex: 1; width: 100vw;">
            <div class="column top-panel">
              <div style="position: absolute; top: 0; right: 10px;">unzoom.</div>
              <div style="margin-top: 120px;">
                <button
                  class="enter-group-room-btn"
                  @click=${() => {
                    this._selectedRoleName = 'unzoom';
                    this._pageView = PageView.Room;
                  }}
                >
                  Enter Group Room
                </button>
              </div>
              <div>Show active participants here (0 in room etc.)</div>
            </div>
            <h3>Personal Rooms:</h3>
            <input
              id="room-name-input"
              class="input-field"
              placeholder="room name (optional, not seen by others)"
              type="text"
            />
            <button @click=${async () => this.createRoom()}>
              Create new Room
            </button>
            <div class="column">
              ${this._personalRooms.map(
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
        `;
      case PageView.Room:
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
      }

      h3 {
        color: #c8ddf9;
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

      .enter-group-room-btn {
        background: #102a4d;
        border-radius: 40px;
        color: #fff0f0;
        border: none;
        padding: 10px 15px;
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
        height: 30px;
        border-radius: 10px;
        border: none;
        font-size: 18px;
        width: 400px;
        padding-left: 8px;
      }

      .room-container {
        display: flex;
        flex: 1;
        margin: 0;
      }
    `,
  ];
}
