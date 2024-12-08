/* eslint-disable no-console */
import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  encodeHashToBase64,
  AgentPubKeyB64,
  decodeHashFromBase64,
} from '@holochain/client';

import { StoreSubscriber, lazyLoadAndPoll } from '@holochain-open-dev/stores';
import SimplePeer from 'simple-peer';
import {
  mdiAccount,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiLock,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiMonitorScreenshot,
  mdiPaperclip,
  mdiPhoneRefresh,
  mdiVideo,
  mdiVideoOff,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit/context';
import { repeat } from 'lit/directives/repeat.js';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import { WeaveClient, weaveUrlFromWal } from '@theweave/api';
import { EntryRecord } from '@holochain-open-dev/utils';

import { roomStoreContext, streamsStoreContext } from './contexts';
import { sharedStyles } from './sharedStyles';
import './avatar-with-nickname';
import { Attachment, RoomInfo, weaveClientContext } from './types';
import { RoomStore } from './room-store';
import './attachment-element';
import './agent-connection-status';
import './agent-connection-status-icon';
import './toggle-switch';
import { sortConnectionStatuses } from './utils';
import { StreamsStore } from './streams-store';

const ICE_CONFIG = [
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/**
 * If an InitRequest does not succeed within this duration (ms) another InitRequest will be sent
 */
const INIT_RETRY_THRESHOLD = 5000;

const PING_INTERVAL = 2000;

type ConnectionId = string;

type RTCMessage =
  | {
      type: 'action';
      message: 'video-off' | 'audio-off' | 'audio-on';
    }
  | {
      type: 'text';
      message: string;
    };

type OpenConnectionInfo = {
  connectionId: ConnectionId;
  peer: SimplePeer.Instance;
  video: boolean;
  audio: boolean;
  connected: boolean;
  direction: 'outgoing' | 'incoming' | 'duplex'; // In which direction streams are expected
};

type PendingInit = {
  /**
   * UUID to identify the connection
   */
  connectionId: ConnectionId;
  /**
   * Timestamp when init was sent. If InitAccept is not received within a certain duration
   * after t0, a next InitRequest is sent.
   */
  t0: number;
};

type PendingAccept = {
  /**
   * UUID to identify the connection
   */
  connectionId: ConnectionId;
  /**
   * Peer instance that was created with this accept. Gets destroyed if another Peer object makes it through
   * to connected state instead for a connection with the same Agent.
   */
  peer: SimplePeer.Instance;
};

type PongMetaData<T> = {
  formatVersion: number;
  data: T;
};

type PongMetaDataV1 = {
  connectionStatuses: ConnectionStatuses;
  screenShareConnectionStatuses?: ConnectionStatuses;
  knownAgents?: Record<AgentPubKeyB64, AgentInfo>;
  appVersion?: string;
};

type ConnectionStatuses = Record<AgentPubKeyB64, ConnectionStatus>;

/**
 * Connection status with a peer
 */
export type ConnectionStatus =
  | {
      /**
       * No WebRTC connection or freshly disconnected
       */
      type: 'Disconnected';
    }
  | {
      /**
       * Waiting for an init of a peer whose pubkey is alphabetically higher than ours
       */
      type: 'AwaitingInit';
    }
  | {
      /**
       * Waiting for an Accept of a peer whose pubkey is alphabetically lower than ours
       */
      type: 'InitSent';
      attemptCount?: number;
    }
  | {
      /**
       * Waiting for SDP exchange to start
       */
      type: 'AcceptSent';
      attemptCount?: number;
    }
  | {
      /**
       * SDP exchange is ongoing
       */
      type: 'SdpExchange';
    }
  | {
      /**
       * WebRTC connection is established
       */
      type: 'Connected';
    };

type AgentInfo = {
  pubkey: AgentPubKeyB64;
  /**
   * If I know from the all_agents anchor that this agent exists in the Room, the
   * type is "known". If I've learnt about this agent only from other's Pong meta data
   * or from receiving a Pong from that agent themselves the type is "told".
   */
  type: 'known' | 'told';
  /**
   * last time when a PongUi from this agent was received
   */
  lastSeen?: number;
  appVersion?: string;
};

@localized()
@customElement('room-view')
export class RoomView extends LitElement {
  @consume({ context: roomStoreContext, subscribe: true })
  @state()
  roomStore!: RoomStore;

  @consume({ context: streamsStoreContext, subscribe: true })
  @state()
  streamsStore!: StreamsStore;

  @consume({ context: weaveClientContext })
  @state()
  _weaveClient!: WeaveClient;

  @property({ type: Boolean })
  private = false;

  @state()
  pingInterval: number | undefined;

  _allAgentsFromAnchor = new StoreSubscriber(
    this,
    () => this.roomStore.allAgents,
    () => [this.roomStore]
  );

  _allAttachments = new StoreSubscriber(
    this,
    () =>
      lazyLoadAndPoll(async () => {
        const allAttachments = this.roomStore.client.getAllAttachments();
        const recentlyChangedAttachments = this._recentAttachmentChanges;
        recentlyChangedAttachments.added = [];
        recentlyChangedAttachments.deleted = [];
        this._recentAttachmentChanges = recentlyChangedAttachments;
        return allAttachments;
      }, 5000),
    () => [this.roomStore]
  );

  @state()
  _recentAttachmentChanges: Record<string, EntryRecord<Attachment>[]> = {
    added: [],
    deleted: [],
  };

  @state()
  _roomInfo: RoomInfo | undefined;

  _knownAgents = new StoreSubscriber(
    this,
    () => this.streamsStore._knownAgents,
    () => [this.streamsStore]
  );

  _connectionStatuses = new StoreSubscriber(
    this,
    () => this.streamsStore._connectionStatuses,
    () => [this.streamsStore]
  );

  _screenShareConnectionStatuses = new StoreSubscriber(
    this,
    () => this.streamsStore._screenShareConnectionStatuses,
    () => [this.streamsStore]
  );

  _othersConnectionStatuses = new StoreSubscriber(
    this,
    () => this.streamsStore._othersConnectionStatuses,
    () => [this.streamsStore]
  );

  _openConnections = new StoreSubscriber(
    this,
    () => this.streamsStore._openConnections,
    () => [this.streamsStore]
  );

  _screenShareConnectionsOutgoing = new StoreSubscriber(
    this,
    () => this.streamsStore._screenShareConnectionsOutgoing,
    () => [this.streamsStore]
  );

  _screenShareConnectionsIncoming = new StoreSubscriber(
    this,
    () => this.streamsStore._screenShareConnectionsIncoming,
    () => [this.streamsStore]
  );

  @state()
  _microphone = false;

  @state()
  _camera = false;

  @state()
  _hoverCamera = false;

  @state()
  _hoverMicrophone = false;

  @state()
  _hoverScreen = false;

  @state()
  _maximizedVideo: string | undefined; // id of the maximized video if any

  @state()
  _displayError: string | undefined;

  @state()
  _joinAudio = new Audio('doorbell.mp3');

  @state()
  _leaveAudio = new Audio('percussive-drum-hit.mp3');

  @state()
  _showAttachmentsPanel = false;

  @state()
  _panelMode: 'attachments' | 'people' = 'attachments';

  @state()
  _showConnectionDetails = false;

  @state()
  _unsubscribe: (() => void) | undefined;

  sideClickListener = (e: MouseEvent) => {
    if (this._showAttachmentsPanel) {
      this._showAttachmentsPanel = false;
    }
  };

  notifyError(msg: string) {
    this._displayError = msg;
    setTimeout(() => {
      this._displayError = undefined;
    }, 4000);
  }

  quitRoom() {
    this.streamsStore.disconnect();
    this.dispatchEvent(
      new CustomEvent('quit-room', { bubbles: true, composed: true })
    );
  }

  async firstUpdated() {
    this.addEventListener('click', this.sideClickListener);
    this.streamsStore.onEvent(async event => {
      switch (event.type) {
        case 'error': {
          this.notifyError(event.error);
          break;
        }
        case 'my-audio-off': {
          this._microphone = false;
          break;
        }
        case 'my-audio-on': {
          this._microphone = true;
          break;
        }
        case 'my-video-on': {
          const myVideo = this.shadowRoot?.getElementById(
            'my-own-stream'
          ) as HTMLVideoElement;
          myVideo.autoplay = true;
          myVideo.srcObject = this.streamsStore.mainStream!;
          this._camera = true;
          break;
        }
        case 'my-video-off': {
          this._camera = false;
          break;
        }
        case 'my-screen-share-on': {
          const myScreenVideo = this.shadowRoot?.getElementById(
            'my-own-screen'
          ) as HTMLVideoElement;
          if (myScreenVideo) {
            myScreenVideo.autoplay = true;
            myScreenVideo.srcObject = this.streamsStore.screenShareStream!;
          }
          break;
        }
        case 'my-screen-share-off': {
          if (this._maximizedVideo === 'my-own-screen') {
            this._maximizedVideo = undefined;
          }
          break;
        }
        case 'peer-connected': {
          await this._joinAudio.play();
          break;
        }
        case 'peer-disconnected': {
          if (this._maximizedVideo === event.connectionId) {
            this._maximizedVideo = undefined;
          }
          await this._leaveAudio.play();
          break;
        }
        case 'peer-stream': {
          // We want to make sure that the video element is actually in the DOM
          // so we add a timeout here.
          setTimeout(() => {
            const videoEl = this.shadowRoot?.getElementById(
              event.connectionId
            ) as HTMLVideoElement | undefined;
            if (videoEl) {
              videoEl.autoplay = true;
              videoEl.srcObject = event.stream;
            }
          }, 200);
          break;
        }
        case 'peer-screen-share-stream': {
          console.log('&&&& GOT SCREEN STREAM');
          // We want to make sure that the video element is actually in the DOM
          // so we add a timeout here.
          setTimeout(() => {
            const videoEl = this.shadowRoot?.getElementById(
              event.connectionId
            ) as HTMLVideoElement | undefined;
            console.log('&&&& Trying to set video element (screen share)');
            if (videoEl) {
              videoEl.autoplay = true;
              videoEl.srcObject = event.stream;
            }
          }, 200);
          break;
        }
        case 'peer-screen-share-disconnected': {
          if (this._maximizedVideo === event.connectionId) {
            this._maximizedVideo = undefined;
          }
          break;
        }
        default:
          break;
      }
    });
    this._leaveAudio.volume = 0.05;
    this._joinAudio.volume = 0.07;
    this._roomInfo = await this.roomStore.client.getRoomInfo();
  }

  async addAttachment() {
    const wal = await this._weaveClient.userSelectWal();
    console.log('Got WAL: ', wal);
    if (wal) {
      const newAttachment = await this.roomStore.client.createAttachment({
        wal: weaveUrlFromWal(wal, false),
      });
      const recentlyChanged = this._recentAttachmentChanges;
      const recentlyAddedAttachments = [
        ...recentlyChanged.added,
        newAttachment,
      ];
      recentlyChanged.added = recentlyAddedAttachments;
      this._recentAttachmentChanges = recentlyChanged;
      this.requestUpdate();
    }
  }

  async removeAttachment(entryRecord: EntryRecord<Attachment>) {
    await this.roomStore.client.deleteAttachment(entryRecord.actionHash);
    const recentlyChanged = this._recentAttachmentChanges;
    const recentlyDeletedAttachments = [
      ...recentlyChanged.deleted,
      entryRecord,
    ];
    recentlyChanged.deleted = recentlyDeletedAttachments;
    this._recentAttachmentChanges = recentlyChanged;
    this.requestUpdate();
  }

  toggleMaximized(id: string) {
    if (this._maximizedVideo !== id) {
      this._maximizedVideo = id;
    } else {
      this._maximizedVideo = undefined;
    }
  }

  disconnectedCallback(): void {
    if (this.pingInterval) window.clearInterval(this.pingInterval);
    if (this._unsubscribe) this._unsubscribe();
    this.removeEventListener('click', this.sideClickListener);
    this.streamsStore.disconnect();
  }

  idToLayout(id: string) {
    if (id === this._maximizedVideo) return 'maximized';
    if (this._maximizedVideo) return 'hidden';
    const incomingScreenShareNum = Object.keys(
      this._screenShareConnectionsIncoming.value
    ).length;
    const ownScreenShareNum = this.streamsStore.screenShareStream ? 1 : 0;
    const num =
      Object.keys(this._openConnections.value).length +
      incomingScreenShareNum +
      ownScreenShareNum +
      1;

    if (num === 1) {
      return 'single';
    }
    if (num <= 2) {
      return 'double';
    }
    if (num <= 4) {
      return 'quartett';
    }
    if (num <= 6) {
      return 'sextett';
    }
    if (num <= 8) {
      return 'octett';
    }
    return 'unlimited';
  }

  roomName() {
    if (this.roomStore.client.roleName === 'presence') return msg('Main Room');
    if (this._roomInfo) return this._roomInfo.name;
    return '[unknown]';
  }

  renderConnectionDetailsToggle() {
    return html`
      <div class="row toggle-switch-container" style="align-items: center;">
        <toggle-switch
          class="toggle-switch ${this._showConnectionDetails ? 'active' : ''}"
          .toggleState=${this._showConnectionDetails}
          @click=${(e: Event) => {
            e.stopPropagation();
          }}
          @toggle-on=${() => {
            this._showConnectionDetails = true;
          }}
          @toggle-off=${() => {
            this._showConnectionDetails = false;
          }}
        ></toggle-switch>
        <span
          class="secondary-font"
          style="cursor: default; margin-left: 7px; ${this
            ._showConnectionDetails
            ? 'opacity: 0.8;'
            : 'opacity: 0.5;'}"
          >${this._showConnectionDetails
            ? 'Hide connection details'
            : 'Show connection details'}</span
        >
      </div>
    `;
  }

  renderAttachmentButton() {
    const numAttachments =
      this._allAttachments.value.status === 'complete'
        ? this._allAttachments.value.value.length
        : undefined;
    const numPeople = Object.values(this._connectionStatuses.value).filter(
      status => !!status && status.type !== 'Disconnected'
    ).length;
    return html`
      <div
        tabindex="0"
        class="attachments-btn row center-content"
        @click=${(e: MouseEvent) => {
          this._showAttachmentsPanel = true;
          e.stopPropagation();
        }}
        @keypress=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            this._showAttachmentsPanel = true;
          }
        }}
      >
        <div style="margin-bottom: -2px; margin-left: 2px;">
          ${numAttachments || numAttachments === 0 ? numAttachments : ''}
        </div>
        <sl-icon
          .src=${wrapPathInSvg(mdiPaperclip)}
          style="transform: rotate(5deg); margin-left: -2px;"
        ></sl-icon>
        <div style="margin-bottom: -2px; margin-left: 2px;">${numPeople}</div>
        <sl-icon
          .src=${wrapPathInSvg(mdiAccount)}
          style="transform: rotate(3deg); margin-left: -2px;"
        ></sl-icon>
      </div>
    `;
  }

  renderAttachments() {
    switch (this._allAttachments.value.status) {
      case 'pending':
        return html`loading...`;
      case 'error':
        console.error(
          'Failed to load attachments: ',
          this._allAttachments.value.error
        );
        return html`Failed to load attachments:
        ${this._allAttachments.value.error}`;
      case 'complete': {
        const allAttachments = [
          ...this._recentAttachmentChanges.added,
          ...this._allAttachments.value.value,
        ];
        const recentlyDeletedAttachmentHashes =
          this._recentAttachmentChanges.deleted.map(entryRecord =>
            entryRecord.actionHash.toString()
          );
        const allDeduplicatedAttachments = allAttachments
          .filter(
            (value, index, self) =>
              index ===
              self.findIndex(
                t => t.actionHash.toString() === value.actionHash.toString()
              )
          )
          .filter(
            entryRecord =>
              !recentlyDeletedAttachmentHashes.includes(
                entryRecord.actionHash.toString()
              )
          );

        return html`
          <div class="column attachments-list">
            ${repeat(
              allDeduplicatedAttachments.sort(
                (entryRecord_a, entryRecord_b) =>
                  entryRecord_b.action.timestamp -
                  entryRecord_a.action.timestamp
              ),
              entryRecord => encodeHashToBase64(entryRecord.actionHash),
              entryRecord => html`
                <attachment-element
                  style="margin-bottom: 8px;"
                  .entryRecord=${entryRecord}
                  @remove-attachment=${(e: CustomEvent) =>
                    this.removeAttachment(e.detail)}
                ></attachment-element>
              `
            )}
          </div>
        `;
      }
      default:
        return html`unkown territory...`;
    }
  }

  renderConnectionStatuses() {
    const knownAgentsKeysB64 = Object.keys(this._knownAgents.value);

    const presentAgents = knownAgentsKeysB64
      .filter(pubkeyB64 => {
        const status = this._connectionStatuses.value[pubkeyB64];
        return !!status && status.type !== 'Disconnected';
      })
      .sort((key_a, key_b) => key_a.localeCompare(key_b));
    const absentAgents = knownAgentsKeysB64
      .filter(pubkeyB64 => {
        const status = this._connectionStatuses.value[pubkeyB64];
        return !status || status.type === 'Disconnected';
      })
      .sort((key_a, key_b) => key_a.localeCompare(key_b));
    return html`
      <div
        class="column"
        style="padding-left: 10px; align-items: flex-start; margin-top: 10px; height: 100%;"
      >
        <div class="column" style="align-items: flex-end;">
          <div class="connectivity-title">Present</div>
          <hr class="divider" />
        </div>
        ${presentAgents.length > 0
          ? repeat(
              presentAgents,
              pubkey => pubkey,
              pubkey => html`
                <agent-connection-status
                  .agentPubKey=${decodeHashFromBase64(pubkey)}
                  .connectionStatus=${this._connectionStatuses.value[pubkey]}
                  .appVersion=${this._knownAgents.value[pubkey].appVersion}
                ></agent-connection-status>
              `
            )
          : html`<span
              style="color: #c3c9eb; font-size: 20px; font-style: italic; margin-top: 10px; opacity: 0.8;"
              >no one else present.</span
            >`}
        ${absentAgents.length > 0
          ? html`
              <div class="column" style="align-items: flex-end;">
                <div class="connectivity-title">Absent</div>
                <hr class="divider" />
              </div>
              ${repeat(
                absentAgents,
                pubkey => pubkey,
                pubkey => html`
                  <agent-connection-status
                    .agentPubKey=${decodeHashFromBase64(pubkey)}
                    .connectionStatus=${this._connectionStatuses.value[pubkey]}
                  ></agent-connection-status>
                `
              )}
            `
          : html``}
      </div>
    `;
  }

  renderAttachmentPanel() {
    return html`
      <div
        class="column attachment-panel secondary-font"
        style="align-items: flex-start; justify-content: flex-start;"
        @click=${(e: MouseEvent) => e.stopPropagation()}
        @keypress=${() => undefined}
      >
        <div class="row close-panel">
          <div
            tabindex="0"
            class="close-btn"
            style="margin-right: 10px;"
            @click=${() => {
              this._showAttachmentsPanel = false;
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                this._showAttachmentsPanel = false;
              }
            }}
          >
            ${msg('close X')}
          </div>
        </div>
        <div class="row sidepanel-tabs">
          <div
            class="sidepanel-tab ${this._panelMode === 'attachments'
              ? 'tab-selected'
              : ''}"
            tabindex="0"
            @click=${() => {
              this._panelMode = 'attachments';
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ')
                this._panelMode = 'attachments';
            }}
          >
            <div class="row center-content">
              <sl-icon
                .src=${wrapPathInSvg(mdiPaperclip)}
                style="transform: rotate(5deg); margin-right: 2px;"
              ></sl-icon>
              attachments
            </div>
          </div>
          <div
            class="sidepanel-tab ${this._panelMode === 'people'
              ? 'tab-selected'
              : ''}"
            tabindex="0"
            @click=${() => {
              this._panelMode = 'people';
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ')
                this._panelMode = 'people';
            }}
          >
            <div class="row center-content">
              <sl-icon
                .src=${wrapPathInSvg(mdiAccount)}
                style="transform: rotate(2deg); margin-right: 2px;"
              ></sl-icon>
              people
            </div>
          </div>
        </div>
        ${this._panelMode === 'people'
          ? this.renderConnectionStatuses()
          : html`
              <div
                class="column"
                style="margin-top: 18px; padding: 0 20px; align-items: flex-start; position: relative; height: 100%;"
              >
                <div
                  tabindex="0"
                  class="add-attachment-btn"
                  @click=${() => this.addAttachment()}
                  @keypress=${async (e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      await this.addAttachment();
                    }
                  }}
                >
                  + Add Attachment
                </div>
                ${this.renderAttachments()}
              </div>
            `}
      </div>
    `;
  }

  renderToggles() {
    return html`
      <div class="toggles-panel">
        <sl-tooltip
          content="${this._microphone ? msg('Voice Off') : msg('Voice On')}"
          hoist
        >
          <div
            class="toggle-btn ${this._microphone ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this._microphone) {
                await this.streamsStore.audioOff();
              } else {
                await this.streamsStore.audioOn();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._microphone) {
                  await this.streamsStore.audioOff();
                } else {
                  await this.streamsStore.audioOn();
                }
              }
            }}
            @mouseenter=${() => {
              this._hoverMicrophone = true;
            }}
            @mouseleave=${() => {
              this._hoverMicrophone = false;
            }}
            @blur=${() => {
              this._hoverMicrophone = false;
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${(this._hoverMicrophone &&
                !this._microphone) ||
              this._microphone
                ? ''
                : 'btn-icon-off'}"
              .src=${(this._hoverMicrophone && !this._microphone) ||
              this._microphone
                ? wrapPathInSvg(mdiMicrophone)
                : wrapPathInSvg(mdiMicrophoneOff)}
            ></sl-icon>
          </div>
        </sl-tooltip>

        <sl-tooltip
          content="${this._camera ? msg('Camera Off') : msg('Camera On')}"
          hoist
        >
          <div
            class="toggle-btn ${this._camera ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this._camera) {
                await this.streamsStore.videoOff();
              } else {
                await this.streamsStore.videoOn();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._camera) {
                  await this.streamsStore.videoOff();
                } else {
                  await this.streamsStore.videoOn();
                }
              }
            }}
            @mouseenter=${() => {
              this._hoverCamera = true;
            }}
            @mouseleave=${() => {
              this._hoverCamera = false;
            }}
            @blur=${() => {
              this._hoverCamera = false;
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${(this._hoverCamera && !this._camera) ||
              this._camera
                ? ''
                : 'btn-icon-off'}"
              .src=${(this._hoverCamera && !this._camera) || this._camera
                ? wrapPathInSvg(mdiVideo)
                : wrapPathInSvg(mdiVideoOff)}
            ></sl-icon>
          </div>
        </sl-tooltip>

        <sl-tooltip
          content="${this.streamsStore.screenShareStream
            ? msg('Stop Screen Sharing')
            : msg('Share Screen')}"
          hoist
        >
          <div
            class="toggle-btn ${this.streamsStore.screenShareStream
              ? ''
              : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this.streamsStore.screenShareStream) {
                await this.streamsStore.screenShareOff();
              } else {
                await this.streamsStore.screenShareOn();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this.streamsStore.screenShareStream) {
                  await this.streamsStore.screenShareOff();
                } else {
                  await this.streamsStore.screenShareOn();
                }
              }
            }}
            @mouseenter=${() => {
              this._hoverScreen = true;
            }}
            @mouseleave=${() => {
              this._hoverScreen = false;
            }}
            @blur=${() => {
              this._hoverScreen = false;
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${(this._hoverScreen &&
                !this.streamsStore.screenShareStream) ||
              this.streamsStore.screenShareStream
                ? ''
                : 'btn-icon-off'}"
              .src=${wrapPathInSvg(mdiMonitorScreenshot)}
            ></sl-icon>
          </div>
        </sl-tooltip>

        <sl-tooltip content="${msg('Leave Call')}" hoist>
          <div
            class="btn-stop"
            tabindex="0"
            @click=${async () => this.quitRoom()}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                this.quitRoom();
              }
            }}
          >
            <div class="stop-icon"></div>
          </div>
        </sl-tooltip>
      </div>
    `;
  }

  /**
   * Renders connection statuses of agents with icons in a row.
   *
   * @param type
   * @param pubkeyb64
   * @returns
   */
  renderAgentConnectionStatuses(
    type: 'video' | 'my-video' | 'my-screen-share' | 'their-screen-share',
    pubkeyb64?: AgentPubKeyB64
  ) {
    let knownAgents: Record<AgentPubKeyB64, AgentInfo> | undefined;
    let staleInfo: boolean;
    let connectionStatuses: ConnectionStatuses;

    if (type === 'my-screen-share') {
      knownAgents = this._knownAgents.value;
      staleInfo = false;
      connectionStatuses = this._screenShareConnectionStatuses.value;
    } else if (type === 'my-video') {
      knownAgents = this._knownAgents.value;
      staleInfo = false;
      connectionStatuses = this._connectionStatuses.value;
    } else {
      if (!pubkeyb64)
        throw Error(
          "For rendering connection statuses of type 'video' or 'their-screen-share', a public key must be provided."
        );
      const statuses = this._othersConnectionStatuses.value[pubkeyb64];
      if (!statuses)
        return html`<span
          class="tertiary-font"
          style="color: #c3c9eb; font-size: 16px;"
          >Unkown connection statuses</span
        >`;

      knownAgents = statuses.knownAgents;
      const now = Date.now();
      staleInfo = now - statuses.lastUpdated > 2.8 * PING_INTERVAL;

      switch (type) {
        case 'video': {
          connectionStatuses = statuses.statuses;
          break;
        }
        case 'their-screen-share': {
          if (!statuses.screenShareStatuses)
            return html`<span
              class="tertiary-font"
              style="color: #c3c9eb; font-size: 16px;"
              >Unkown connection statuses</span
            >`;
          connectionStatuses = statuses.screenShareStatuses;
          break;
        }
        default:
          throw new Error(`Unknown connection type: ${type}`);
      }
    }

    const nConnections = Object.values(connectionStatuses).filter(
      status => status.type === 'Connected'
    ).length;

    // if the info is older than >2.8 PING_INTERVAL, show the info opaque to indicated that it's outdated
    const sortedStatuses = Object.entries(connectionStatuses).sort(
      sortConnectionStatuses
    );
    return html`
      <div class="row" style="align-items: center; flex-wrap: wrap;">
        ${repeat(
          sortedStatuses,
          ([pubkeyb64, _status]) => pubkeyb64,
          ([pubkeyb64, status]) => {
            // Check whether the agent for which the statuses are rendered has only been told by others that
            // the rendered agent exists
            const onlyToldAbout = !!(
              knownAgents &&
              knownAgents[pubkeyb64] &&
              knownAgents[pubkeyb64].type === 'told'
            );

            const lastSeen = knownAgents
              ? knownAgents[pubkeyb64].lastSeen
              : undefined;

            return html`<agent-connection-status-icon
              style="margin-right: 2px; margin-bottom: 2px; ${staleInfo
                ? 'opacity: 0.5;'
                : ''}"
              .agentPubKey=${decodeHashFromBase64(pubkeyb64)}
              .connectionStatus=${status}
              .onlyToldAbout=${onlyToldAbout}
              .lastSeen=${lastSeen}
            ></agent-connection-status-icon>`;
          }
        )}
        <span
          class="tertiary-font"
          style="color: #c3c9eb; font-size: 24px; margin-left: 5px;"
          >(${nConnections})</span
        >
      </div>
    `;
  }

  render() {
    return html`
      <div class="row center-content room-name">
        ${this.private
          ? html`<sl-icon
              .src=${wrapPathInSvg(mdiLock)}
              style="font-size: 28px; margin-right: 3px;"
            ></sl-icon>`
          : html``}
        ${this.roomName()}
      </div>
      <div class="videos-container">
        <!-- My own screen first if screen sharing is enabled -->
        <div
          style="${this.streamsStore.screenShareStream ? '' : 'display: none;'}"
          class="video-container screen-share ${this.idToLayout(
            'my-own-screen'
          )}"
          @dblclick=${() => this.toggleMaximized('my-own-screen')}
        >
          <video muted id="my-own-screen" class="video-el"></video>

          <!-- Connection states indicators -->
          ${this._showConnectionDetails
            ? html`<div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; background: none;"
              >
                ${this.renderAgentConnectionStatuses('my-screen-share')}
              </div>`
            : html``}

          <!-- Avatar and nickname -->
          <div
            style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
          >
            <avatar-with-nickname
              .size=${36}
              .agentPubKey=${this.roomStore.client.client.myPubKey}
              style="height: 36px;"
            ></avatar-with-nickname>
          </div>
          <sl-icon
            title="${this._maximizedVideo === 'my-own-screen'
              ? 'minimize'
              : 'maximize'}"
            .src=${this._maximizedVideo === 'my-own-screen'
              ? wrapPathInSvg(mdiFullscreenExit)
              : wrapPathInSvg(mdiFullscreen)}
            tabindex="0"
            class="maximize-icon"
            @click=${() => {
              this.toggleMaximized('my-own-screen');
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                this.toggleMaximized('my-own-screen');
              }
            }}
          ></sl-icon>
        </div>
        <!--Then other agents' screens -->

        ${repeat(
          Object.entries(this._screenShareConnectionsIncoming.value).filter(
            ([_, conn]) => conn.direction === 'incoming'
          ),
          ([_pubkeyB64, conn]) => conn.connectionId,
          ([pubkeyB64, conn]) => html`
            <div
              class="video-container screen-share ${this.idToLayout(
                conn.connectionId
              )}"
              @dblclick=${() => this.toggleMaximized(conn.connectionId)}
            >
              <video
                style="${conn.connected ? '' : 'display: none;'}"
                id="${conn.connectionId}"
                class="video-el"
              ></video>
              <div
                style="color: #b98484; ${conn.connected ? 'display: none' : ''}"
              >
                establishing connection...
              </div>

              <!-- Connection states indicators -->
              ${this._showConnectionDetails
                ? html`<div
                    style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; background: none;"
                  >
                    ${this.renderAgentConnectionStatuses(
                      'their-screen-share',
                      pubkeyB64
                    )}
                  </div>`
                : html``}

              <!-- Avatar and nickname -->
              <div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
              >
                <avatar-with-nickname
                  .size=${36}
                  .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                  style="height: 36px;"
                ></avatar-with-nickname>
                <sl-tooltip content="reconnect" class="tooltip-filled">
                  <sl-icon-button
                    class="phone-refresh"
                    style="margin-left: 4px; margin-bottom: -5px;"
                    src=${wrapPathInSvg(mdiPhoneRefresh)}
                    @click=${() => {
                      this.streamsStore.disconnectFromPeerScreen(pubkeyB64);
                    }}
                  ></sl-icon-button>
                </sl-tooltip>
              </div>
              <sl-icon
                title="${this._maximizedVideo === conn.connectionId
                  ? 'minimize'
                  : 'maximize'}"
                .src=${this._maximizedVideo === conn.connectionId
                  ? wrapPathInSvg(mdiFullscreenExit)
                  : wrapPathInSvg(mdiFullscreen)}
                tabindex="0"
                class="maximize-icon"
                @click=${() => {
                  this.toggleMaximized(conn.connectionId);
                }}
                @keypress=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    this.toggleMaximized(conn.connectionId);
                  }
                }}
              ></sl-icon>
            </div>
          `
        )}

        <!-- My own video stream -->
        <div
          class="video-container ${this.idToLayout('my-own-stream')}"
          @dblclick=${() => this.toggleMaximized('my-own-stream')}
        >
          <video
            muted
            style="${this._camera
              ? ''
              : 'display: none;'}; transform: scaleX(-1);"
            id="my-own-stream"
            class="video-el"
          ></video>
          <sl-icon
            style="color: #b98484; height: 30%; width: 30%;${this._camera
              ? 'display: none;'
              : ''}"
            .src=${wrapPathInSvg(mdiVideoOff)}
          ></sl-icon>

          <!-- Connection states indicators -->
          ${this._showConnectionDetails
            ? html`<div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; background: none;"
              >
                ${this.renderAgentConnectionStatuses('my-video')}
              </div>`
            : html``}

          <!-- Avatar and nickname -->
          <div
            style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
          >
            <avatar-with-nickname
              .size=${36}
              .agentPubKey=${this.roomStore.client.client.myPubKey}
              style="height: 36px;"
            ></avatar-with-nickname>
          </div>
          <sl-icon
            style="position: absolute; bottom: 10px; left: 10px; color: red; height: 30px; width: 30px; ${this
              ._microphone
              ? 'display: none'
              : ''}"
            .src=${wrapPathInSvg(mdiMicrophoneOff)}
          ></sl-icon>
        </div>

        <!-- Video stream of others -->
        ${repeat(
          Object.entries(this._openConnections.value),
          ([_pubkeyB64, conn]) => conn.connectionId,
          ([pubkeyB64, conn]) => html`
            <div
              class="video-container ${this.idToLayout(conn.connectionId)}"
              @dblclick=${() => this.toggleMaximized(conn.connectionId)}
            >
              <video
                style="${conn.video ? '' : 'display: none;'}"
                id="${conn.connectionId}"
                class="video-el"
              ></video>
              <sl-icon
                style="color: #b98484; height: 30%; width: 30%;${!conn.connected ||
                conn.video
                  ? 'display: none;'
                  : ''}"
                .src=${wrapPathInSvg(mdiVideoOff)}
              ></sl-icon>
              <div
                style="color: #b98484; ${conn.connected ? 'display: none' : ''}"
              >
                establishing connection...
              </div>

              <!-- Connection states indicators -->
              ${this._showConnectionDetails
                ? html`<div
                    style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; background: none;"
                  >
                    ${this.renderAgentConnectionStatuses('video', pubkeyB64)}
                  </div>`
                : html``}

              <!-- Avatar and nickname -->
              <div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
              >
                <avatar-with-nickname
                  .size=${36}
                  .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                  style="height: 36px;"
                ></avatar-with-nickname>
                <sl-tooltip content="reconnect" class="tooltip-filled">
                  <sl-icon-button
                    class="phone-refresh"
                    style="margin-left: 4px; margin-bottom: -5px;"
                    src=${wrapPathInSvg(mdiPhoneRefresh)}
                    @click=${() => {
                      this.streamsStore.disconnectFromPeerVideo(pubkeyB64);
                    }}
                  ></sl-icon-button>
                </sl-tooltip>
              </div>
              <sl-icon
                style="position: absolute; bottom: 10px; left: 10px; color: red; height: 30px; width: 30px; ${conn.audio
                  ? 'display: none'
                  : ''}"
                .src=${wrapPathInSvg(mdiMicrophoneOff)}
              ></sl-icon>
            </div>
          `
        )}
      </div>
      ${this.renderToggles()}
      ${this._showAttachmentsPanel ? this.renderAttachmentPanel() : undefined}
      ${this._showAttachmentsPanel ? undefined : this.renderAttachmentButton()}
      ${this._maximizedVideo ? html`` : this.renderConnectionDetailsToggle()}

      <div
        class="error-message secondary-font"
        style="${this._displayError ? '' : 'display: none;'}"
      >
        ${this._displayError}
      </div>
      <div
        class="stop-share"
        tabindex="0"
        style="${this.streamsStore.screenShareStream ? '' : 'display: none'}"
        @click=${async () => this.streamsStore.screenShareOff()}
        @keypress=${async (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            await this.streamsStore.screenShareOff();
          }
        }}
      >
        ${msg('Stop Screen Share')}
      </div>
    `;
  }

  static styles = [
    sharedStyles,
    css`
      main {
        flex-grow: 1;
        margin: 0;
        background: #2b304a;
      }

      .attachment-panel {
        position: absolute;
        top: 0;
        bottom: 94px;
        right: 0;
        width: 400px;
        background: linear-gradient(
          #6f7599c4,
          #6f7599c4 80%,
          #6f759979 90%,
          #6f759900
        );
        /* background: #6f7599; */
      }

      .sidepanel-tabs {
        width: 100%;
        align-items: center;
        margin-top: 10px;
        /* #ffffff80 */
      }

      .sidepanel-tab {
        width: 50%;
        height: 40px;
        /* background: #ffffff10; */
        background: linear-gradient(#6f7599c4, #6f759900);
        cursor: pointer;
        font-size: 24px;
        color: #0d1543;
        font-weight: 600;
        padding-top: 4px;
      }

      .sidepanel-tab:hover {
        /* background: #ffffff80; */
        background: linear-gradient(#c6d2ff87, #6f759900);
      }

      .tab-selected {
        /* background: #ffffff80; */
        background: linear-gradient(#c6d2ff87, #6f759900);
      }

      .attachments-list {
        justify-content: flex-start;
        align-items: flex-start;
        overflow-y: auto;
        position: absolute;
        top: 45px;
        bottom: 5px;
        width: 376px;
        padding: 2px;
      }

      .attachments-list::-webkit-scrollbar {
        display: none;
      }

      .close-panel {
        /* background: linear-gradient(-90deg, #2f3052, #6f7599c4); */
        color: #0d1543;
        font-weight: bold;
        width: 400px;
        height: 40px;
        justify-content: flex-end;
        align-items: center;
        /* font-family: 'Ubuntu', sans-serif; */
        font-size: 22px;
      }

      .close-btn {
        cursor: pointer;
      }

      .close-btn:hover {
        color: #c3c9eb;
        /* background: linear-gradient(-90deg, #a0a1cb, #6f7599c4); */
      }

      .add-attachment-btn {
        all: unset;
        text-align: center;
        color: #c3c9eb;
        /* font-family: 'Baloo 2 Variable', sans-serif; */
        /* font-family: 'Ubuntu'; */
        font-size: 22px;
        cursor: pointer;
        margin-bottom: 15px;
        font-weight: 600;
      }

      .add-attachment-btn:hover {
        color: white;
      }

      .add-attachment-btn:focus {
        color: white;
      }

      .divider {
        height: 1px;
        border: 0;
        width: 380px;
        background: #0d1543;
        margin: 0 0 5px 0;
      }

      .connectivity-title {
        font-style: italic;
        font-weight: bold;
        font-size: 16px;
        margin-bottom: -3px;
        color: #0d1543;
      }

      .room-name {
        position: absolute;
        bottom: 5px;
        left: 15px;
        color: #6f7599;
      }

      .toggle-switch-container {
        position: absolute;
        top: 10px;
        left: 10px;
        color: #c3c9eb;
        font-size: 20px;
      }

      .toggle-switch {
        opacity: 0.6;
      }

      /* .toggle-switch:hover {
        opacity: 1;
      } */

      .active {
        opacity: 1;
      }

      .attachments-btn {
        position: absolute;
        top: 10px;
        right: 10px;
        /* background: #c3c9eb; */
        background: linear-gradient(#c3c9ebd6, #a7b0dfd6);
        opacity: 0.8;
        font-weight: 500;
        border-radius: 20px;
        font-family: 'Baloo 2 Variable', sans-serif;
        font-size: 24px;
        padding: 3px 10px;
        cursor: pointer;
        box-shadow: 0px 0px 5px 2px #0b0f28;
      }

      .attachments-btn:hover {
        /* background: #dbdff9; */
        background: linear-gradient(#c3c9eb, #a7b0df);
      }

      .attachments-btn:focus {
        /* background: #dbdff9; */
        background: linear-gradient(#d4d9f3, #bac2e9);
      }

      .stop-share {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        padding: 6px 10px;
        position: absolute;
        top: 10px;
        left: 0;
        right: 0;
        margin-left: auto;
        margin-right: auto;
        width: 300px;
        color: white;
        background: #b60606;
        border-radius: 10px;
        font-family: sans-serif;
        font-size: 20px;
        font-weight: bold;
        box-shadow: 0 0 2px white;
        z-index: 1;
        cursor: pointer;
      }

      .stop-share:hover {
        background: #fd5959;
      }

      .stop-share:focus-visible {
        background: #fd5959;
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

      .videos-container {
        display: flex;
        flex: 1;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        width: 100vw;
        min-height: 100vh;
        margin: 0;
        align-content: center;
      }

      .video-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        position: relative;
        aspect-ratio: 16 / 9;
        border-radius: 20px;
        border: 2px solid #7291c9;
        margin: 5px;
        overflow: hidden;
        background: black;
      }

      .maximized {
        height: 98.5vh;
        width: 98.5vw;
        margin: 0;
      }

      .maximize-icon {
        position: absolute;
        bottom: 5px;
        left: 5px;
        /* color: #facece; */
        color: #ffe100;
        height: 40px;
        width: 40px;
        cursor: pointer;
      }

      .maximize-icon:hover {
        color: #ffe100;
        transform: scale(1.2);
      }

      .maximize-icon:focus-visible {
        color: #ffe100;
        transform: scale(1.2);
      }

      .hidden {
        display: none;
      }

      .screen-share {
        border: 4px solid #ffe100;
      }

      .video-el {
        height: 100%;
        max-width: 100%;
      }

      .identicon canvas {
        width: 180px;
        height: 180px;
      }

      .single {
        height: min(98vh, 100%);
        width: min(98vw, 100%);
        max-height: 98vh;
        border: none;
      }

      .double {
        width: min(48.5%, 48.5vw);
        min-width: max(280px, 48.5vw);
      }

      .quartett {
        width: min(48.5%, 48.5vw, 84vh);
        min-width: min(84vh, max(280px, 48.5vw));
      }

      .sextett {
        width: min(32.5%, 32.5vw);
        min-width: max(280px, 32.5vw);
      }

      .octett {
        width: min(32.5%, 32.5vw, 55vh);
        min-width: min(55vh, max(280px, 32.5vw));
      }

      .btn-stop {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #9c0f0f;
        margin: 0 5px;
        border-radius: 50%;
        height: 60px;
        width: 60px;
        cursor: pointer;
      }

      .btn-stop:hover {
        background: #dc4a4a;
      }

      .stop-icon {
        height: 23px;
        width: 23px;
        border-radius: 3px;
        background: #eba6a6;
      }

      .toggle-btn-icon {
        height: 40px;
        width: 40px;
        /* color: #e7d9aa; */
        color: #facece;
      }

      .btn-icon-off {
        color: #6482c9;
      }

      .toggle-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #17529f;
        margin: 0 5px;
        border-radius: 50%;
        height: 60px;
        width: 60px;
        cursor: pointer;
      }

      .btn-off {
        background: #22365c;
      }

      .toggle-btn:hover {
        background: #17529f;
      }

      .toggle-btn:hover:not(.btn-off) {
        background: #22365c;
      }

      .toggles-panel {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        position: fixed;
        font-size: 19px;
        bottom: 10px;
        right: 10px;
        width: 298px;
        height: 74px;
        border-radius: 37px;
        background: #0e142c;
        color: #facece;
        box-shadow: 0 0 3px 2px #050b21;
        /* left: calc(50% - 150px); */
      }

      sl-icon-button::part(base) {
        color: #24d800;
      }
      sl-icon-button::part(base):hover,
      sl-icon-button::part(base):focus {
        color: #8dff76;
      }
      sl-icon-button::part(base):active {
        color: #8dff76;
      }

      .tooltip-filled {
        --sl-tooltip-background-color: #c3c9eb;
        --sl-tooltip-arrow-size: 6px;
        --sl-tooltip-border-radius: 5px;
        --sl-tooltip-padding: 4px;
        --sl-tooltip-font-size: 14px;
        --sl-tooltip-color: #0d1543;
        --sl-tooltip-font-family: 'Ubuntu', sans-serif;
      }
    `,
  ];
}
