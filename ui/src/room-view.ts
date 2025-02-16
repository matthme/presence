/* eslint-disable no-console */
import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  encodeHashToBase64,
  AgentPubKeyB64,
  decodeHashFromBase64,
  EntryHash,
} from '@holochain/client';

import { AsyncStatus, StoreSubscriber } from '@holochain-open-dev/stores';
import {
  mdiAccount,
  mdiChevronUp,
  mdiCog,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiLock,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiMonitorScreenshot,
  mdiPaperclip,
  mdiPencilCircleOutline,
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
import { AssetStoreContent, WAL, WeaveClient } from '@theweave/api';

import { roomStoreContext, streamsStoreContext } from './contexts';
import { sharedStyles } from './sharedStyles';
import './avatar-with-nickname';
import { RoomInfo, StreamAndTrackInfo, weaveClientContext } from './types';
import { RoomStore } from './room-store';
import './attachment-element';
import './agent-connection-status';
import './agent-connection-status-icon';
import './toggle-switch';
import { sortConnectionStatuses } from './utils';
import { PING_INTERVAL, StreamsStore } from './streams-store';
import { AgentInfo, ConnectionStatuses } from './types';

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

  @property()
  wal!: WAL;

  @property({ type: Boolean })
  private = false;

  @state()
  pingInterval: number | undefined;

  @state()
  assetStoreContent: AsyncStatus<AssetStoreContent> | undefined;

  _allAgentsFromAnchor = new StoreSubscriber(
    this,
    () => this.roomStore.allAgents,
    () => [this.roomStore]
  );

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

  _audioInputDevices = new StoreSubscriber(
    this,
    () => this.streamsStore.audioInputDevices(),
    () => [this.streamsStore]
  );

  _videoInputDevices = new StoreSubscriber(
    this,
    () => this.streamsStore.videoInputDevices(),
    () => [this.streamsStore]
  );

  _audioOutputDevices = new StoreSubscriber(
    this,
    () => this.streamsStore.audioOutputDevices(),
    () => [this.streamsStore]
  );

  _audioInputId = new StoreSubscriber(
    this,
    () => this.streamsStore.audioInputId(),
    () => [this.streamsStore]
  );

  _audioOutputId = new StoreSubscriber(
    this,
    () => this.streamsStore.audioOutputId(),
    () => [this.streamsStore]
  );

  _videoInputId = new StoreSubscriber(
    this,
    () => this.streamsStore.videoInputId(),
    () => [this.streamsStore]
  );

  @state()
  _microphone = false;

  @state()
  _camera = false;

  @state()
  _maximizedVideo: string | undefined; // id of the maximized video if any

  @state()
  _displayError: string | undefined;

  @state()
  _joinAudio = new Audio('doorbell.mp3');

  @state()
  _leaveAudio = new Audio('percussive-drum-hit.mp3');

  @state()
  _reconnectAudio = new Audio('old-phone-ring-connect.mp3#t=0,3.5');

  @state()
  _showAttachmentsPanel = false;

  @state()
  _showAudioSources = false;

  @state()
  _showVideoSources = false;

  @state()
  _panelMode: 'assets' | 'people' | 'settings' = 'assets';

  @state()
  _showConnectionDetails = false;

  @state()
  _unsubscribe: (() => void) | undefined;

  closeClosables = () => {
    if (this._showAttachmentsPanel) {
      this._showAttachmentsPanel = false;
    }
    if (this._showAudioSources) {
      this._showAudioSources = false;
    }
    if (this._showVideoSources) {
      this._showVideoSources = false;
    }
  };

  sideClickListener = (e: MouseEvent) => {
    this.closeClosables();
  };

  keyDownListener = (e: KeyboardEvent) => {
    console.log('GOT KEYPRESS EVENT: ', e.key);
    if (e.key === 'Escape') {
      this.closeClosables();
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
    this.streamsStore.logger.endSession();
    this.dispatchEvent(
      new CustomEvent('quit-room', { bubbles: true, composed: true })
    );
  }

  async firstUpdated() {
    this.addEventListener('click', this.sideClickListener);
    document.addEventListener('keydown', this.keyDownListener);
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
              console.log('@peer-stream: Tracks: ', event.stream.getTracks());
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
    this._reconnectAudio.volume = 0.1;
    this._roomInfo = await this.roomStore.client.getRoomInfo();

    this._weaveClient.assets.assetStore(this.wal).subscribe(status => {
      console.log('Got asset store update: ', status);
      this.assetStoreContent = status;
      this.requestUpdate();
    });
  }

  async addAttachment() {
    const dstWal = await this._weaveClient.assets.userSelectAsset();
    console.log('Got WAL: ', dstWal);
    if (dstWal) {
      this._weaveClient.assets.addAssetRelation(this.wal, dstWal);
    }
  }

  async removeAttachment(relationHash: EntryHash) {
    await this._weaveClient.assets.removeAssetRelation(relationHash);
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
      this.assetStoreContent && this.assetStoreContent.status === 'complete'
        ? this.assetStoreContent.value.linkedFrom.length
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
    if (!this.assetStoreContent) return html`loading...`;
    switch (this.assetStoreContent.status) {
      case 'pending':
        return html`loading...`;
      case 'error':
        console.error(
          'Failed to load attachments: ',
          this.assetStoreContent.error
        );
        return html`Failed to load attachments: ${this.assetStoreContent.error}`;
      case 'complete': {
        return html`
          <div class="column attachments-list">
            ${repeat(
              this.assetStoreContent.value.linkedFrom.sort(
                (walRelationAndTags_a, walRelationAndTags_b) =>
                  walRelationAndTags_a.createdAt -
                  walRelationAndTags_b.createdAt
              ),
              walRelationAndTags =>
                encodeHashToBase64(walRelationAndTags.relationHash),
              walRelationAndTags => html`
                <attachment-element
                  style="margin-bottom: 8px;"
                  .walRelationAndTags=${walRelationAndTags}
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
        return (
          !!status &&
          status.type !== 'Disconnected' &&
          status.type !== 'Blocked'
        );
      })
      .sort((key_a, key_b) => key_a.localeCompare(key_b));
    const absentAgents = knownAgentsKeysB64
      .filter(pubkeyB64 => {
        const status = this._connectionStatuses.value[pubkeyB64];
        return (
          !status || status.type === 'Disconnected' || status.type === 'Blocked'
        );
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
                  style="width: 100%;"
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
                    style="width: 100%;"
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

  renderTrackStatuses(pubkeyB64: AgentPubKeyB64) {
    const perceivedStreamInfo =
      this._othersConnectionStatuses.value[pubkeyB64].perceivedStreamInfo;
    return html`
      <!-- Audio track icon -->
      <sl-tooltip
        hoist
        class="tooltip-filled"
        placement="top"
        content="${streamAndTrackInfoToText(perceivedStreamInfo, 'audio')}"
        style="--sl-tooltip-background-color: ${streamAndTrackInfoToColor(
          perceivedStreamInfo,
          'audio'
        )};"
      >
        <sl-icon
          style="font-size: 20px; color: ${streamAndTrackInfoToColor(
            perceivedStreamInfo,
            'audio'
          )}"
          .src=${wrapPathInSvg(mdiMicrophone)}
        ></sl-icon>
      </sl-tooltip>

      <!-- Video track icon -->
      <sl-tooltip
        hoist
        class="tooltip-filled"
        placement="top"
        content="${streamAndTrackInfoToText(perceivedStreamInfo, 'video')}"
        style="--sl-tooltip-background-color: ${streamAndTrackInfoToColor(
          perceivedStreamInfo,
          'video'
        )};"
      >
        <sl-icon
          style="font-size: 20px; color: ${streamAndTrackInfoToColor(
            perceivedStreamInfo,
            'video'
          )}"
          .src=${wrapPathInSvg(mdiVideo)}
        ></sl-icon>
      </sl-tooltip>
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
            class="sidepanel-tab ${this._panelMode === 'assets'
              ? 'tab-selected'
              : ''}"
            tabindex="0"
            @click=${() => {
              this._panelMode = 'assets';
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ')
                this._panelMode = 'assets';
            }}
          >
            <div class="row center-content">
              <sl-icon
                .src=${wrapPathInSvg(mdiPaperclip)}
                style="transform: rotate(5deg); margin-right: 2px;"
              ></sl-icon>
              assets
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
          <div
            class="sidepanel-tab ${this._panelMode === 'settings'
              ? 'tab-selected'
              : ''}"
            tabindex="0"
            @click=${() => {
              this._panelMode = 'settings';
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ')
                this._panelMode = 'settings';
            }}
          >
            <div class="row center-content">
              <sl-icon
                .src=${wrapPathInSvg(mdiCog)}
                style="transform: rotate(2deg); margin-right: 2px;"
              ></sl-icon>
              settings
            </div>
          </div>
        </div>
        ${this.renderAttachmentPanelContent()}
      </div>
    `;
  }

  renderAttachmentPanelContent() {
    switch (this._panelMode) {
      case 'assets':
        return html`
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
              + attach asset
            </div>
            ${this.renderAttachments()}
          </div>
        `;
      case 'people':
        return this.renderConnectionStatuses();
      case 'settings':
        return html`
          <div
            class="column"
            style="margin-top: 18px; padding: 0 20px; align-items: flex-start; position: relative;"
          >
            <div class="row items-center">
              <toggle-switch
                class="toggle-switch ${this.streamsStore.trickleICE
                  ? 'active'
                  : ''}"
                .toggleState=${this.streamsStore.trickleICE}
                @toggle-on=${() => {
                  this.streamsStore.enableTrickleICE();
                }}
                @toggle-off=${() => {
                  this.streamsStore.disableTrickleICE();
                }}
              ></toggle-switch>
              <span
                class="secondary-font"
                style="color: #c3c9eb; margin-left: 10px; font-size: 23px;"
                >trickle ICE (ON by default)</span
              >
            </div>
          </div>
        `;
      default:
        return html`unknown tab`;
    }
  }

  renderToggles() {
    return html`
      <div class="toggles-panel">
        <sl-tooltip
          content="${this._microphone
            ? msg('Turn Audio Off')
            : msg('Turn Audio On')}"
          hoist
        >
          <div
            class="toggle-btn ${this._microphone ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this._microphone) {
                await this.streamsStore.audioOff();
              } else {
                await this.streamsStore.audioOn(true);
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._microphone) {
                  await this.streamsStore.audioOff();
                } else {
                  await this.streamsStore.audioOn(true);
                }
              }
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${this._microphone ? '' : 'btn-icon-off'}"
              .src=${this._microphone
                ? wrapPathInSvg(mdiMicrophone)
                : wrapPathInSvg(mdiMicrophoneOff)}
            ></sl-icon>

            <!-- Audio input toggle -->
            <div
              class="toggle-sub-btn column center-content"
              tabindex="0"
              @click=${async (e: any) => {
                e.stopPropagation();
                this._showAudioSources = !this._showAudioSources;
                await this.streamsStore.updateMediaDevices();
              }}
              @keypress=${async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  this._showAudioSources = !this._showAudioSources;
                  await this.streamsStore.updateMediaDevices();
                }
              }}
              @mouseover=${(e: any) => e.stopPropagation()}
              @focus=${() => {}}
            >
              <sl-icon
                class="sub-btn-icon"
                .src=${wrapPathInSvg(mdiChevronUp)}
              ></sl-icon>
            </div>

            <!-- Audio input sources -->
            ${this._showAudioSources
              ? html`
                  <div
                    class="column audio-input-sources secondary-font"
                    @click=${(e: any) => {
                      e.stopPropagation();
                    }}
                    @keypress=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                      }
                    }}
                    @mouseover=${(e: any) => e.stopPropagation()}
                    @focus=${() => {}}
                  >
                    <div class="input-source-title">
                      ${msg('Audio Input Source')}
                    </div>
                    ${this._audioInputDevices.value.map(device => {
                      let isSelected = false;
                      if (
                        !this._audioInputId.value &&
                        device.deviceId === 'default'
                      ) {
                        isSelected = true;
                      }
                      if (
                        this._audioInputId.value &&
                        device.deviceId === this._audioInputId.value
                      ) {
                        isSelected = true;
                      }
                      return html`
                        <div
                          class="audio-source column"
                          tabindex="0"
                          @click=${async (e: any) => {
                            this.closeClosables();
                            await this.streamsStore.changeAudioInput(
                              device.deviceId
                            );
                          }}
                          @keypress=${async (e: KeyboardEvent) => {
                            if (e.key === 'Enter') {
                              this.closeClosables();
                              await this.streamsStore.changeAudioInput(
                                device.deviceId
                              );
                            }
                          }}
                        >
                          <div class="row">
                            <div
                              style="${isSelected ? '' : 'color: transparent'}"
                            >
                              &#10003;&nbsp;
                            </div>
                            <div>${deviceLabel(device.label)}</div>
                          </div>
                        </div>
                      `;
                    })}
                  </div>
                `
              : html``}
          </div>
        </sl-tooltip>

        <sl-tooltip
          content="${this._camera
            ? msg('Turn Camera Off')
            : msg('Turn Camera On')}"
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
          >
            <sl-icon
              class="toggle-btn-icon ${this._camera ? '' : 'btn-icon-off'}"
              .src=${this._camera
                ? wrapPathInSvg(mdiVideo)
                : wrapPathInSvg(mdiVideoOff)}
            ></sl-icon>

            <!-- Video input toggle -->
            <div
              class="toggle-sub-btn column center-content"
              tabindex="0"
              @click=${async (e: any) => {
                e.stopPropagation();
                this._showVideoSources = !this._showVideoSources;
                await this.streamsStore.updateMediaDevices();
              }}
              @keypress=${async (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  this._showVideoSources = !this._showVideoSources;
                  await this.streamsStore.updateMediaDevices();
                }
              }}
              @mouseover=${(e: any) => e.stopPropagation()}
              @focus=${() => {}}
            >
              <sl-icon
                class="sub-btn-icon"
                .src=${wrapPathInSvg(mdiChevronUp)}
              ></sl-icon>
            </div>

            <!-- Video Input Sources -->
            ${this._showVideoSources
              ? html`
                  <div
                    class="column audio-input-sources secondary-font"
                    @click=${(e: any) => {
                      e.stopPropagation();
                    }}
                    @keypress=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                      }
                    }}
                    @mouseover=${(e: any) => e.stopPropagation()}
                    @focus=${() => {}}
                  >
                    <div class="input-source-title">
                      ${msg('Video Input Source')}
                    </div>
                    ${this._videoInputDevices.value.map((device, idx) => {
                      let isSelected = false;
                      if (
                        !this._videoInputId.value &&
                        idx === 0
                      ) {
                        isSelected = true;
                      }
                      if (
                        this._videoInputId.value &&
                        device.deviceId === this._videoInputId.value
                      ) {
                        isSelected = true;
                      }
                      return html`
                        <div
                          class="audio-source column"
                          tabindex="0"
                          @click=${async (e: any) => {
                            this.closeClosables();
                            await this.streamsStore.changeVideoInput(
                              device.deviceId
                            );
                          }}
                          @keypress=${async (e: KeyboardEvent) => {
                            if (e.key === 'Enter') {
                              this.closeClosables();
                              await this.streamsStore.changeVideoInput(
                                device.deviceId
                              );
                            }
                          }}
                        >
                          <div class="row">
                            <div
                              style="${isSelected ? '' : 'color: transparent'}"
                            >
                              &#10003;&nbsp;
                            </div>
                            <div>${deviceLabel(device.label)}</div>
                          </div>
                        </div>
                      `;
                    })}
                  </div>
                `
              : html``}
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
          >
            <sl-icon
              class="toggle-btn-icon ${this.streamsStore.screenShareStream
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
              ? knownAgents[pubkeyb64]?.lastSeen
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
              ${this._showConnectionDetails
                ? html`<div
                    class="row"
                    style="position: absolute; top: 3px; right: 9px;"
                  >
                    ${this.renderTrackStatuses(pubkeyB64)}
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
                ${this._showConnectionDetails
                  ? html`
                      <sl-tooltip
                        content="log stream info"
                        class="tooltip-filled"
                      >
                        <sl-icon-button
                          src=${wrapPathInSvg(mdiPencilCircleOutline)}
                          style="margin-bottom: -5px;"
                          @click=${() => {
                            const videoEl = this.shadowRoot?.getElementById(
                              conn.connectionId
                            ) as HTMLVideoElement;
                            if (videoEl) {
                              const stream = videoEl.srcObject;
                              const tracks = stream
                                ? (stream as MediaStream).getTracks()
                                : null;
                              console.log(
                                '\nSTREAMINFO:',
                                stream,
                                '\nTRACKS: ',
                                tracks
                              );
                              const tracksInfo: any[] = [];
                              tracks?.forEach(track => {
                                tracksInfo.push({
                                  kind: track.kind,
                                  enabled: track.enabled,
                                  muted: track.muted,
                                  readyState: track.readyState,
                                });
                              });
                              const streamInfo = stream
                                ? {
                                    active: (stream as MediaStream).active,
                                  }
                                : null;

                              navigator.clipboard.writeText(
                                JSON.stringify(
                                  {
                                    stream: streamInfo,
                                    tracks: tracksInfo,
                                  },
                                  undefined,
                                  2
                                )
                              );
                            }
                          }}
                        ></sl-icon-button>
                        <sl-tooltip></sl-tooltip>
                      </sl-tooltip>
                    `
                  : html``}
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
        position: relative;
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

      .toggle-sub-btn {
        background: #22365c;
        border-radius: 50%;
        width: 16px;
        height: 16px;
        position: absolute;
        bottom: 0px;
        right: 0px;
        border: 3px solid #0e142c;
        color: #6482c9;
      }

      .toggle-sub-btn:hover {
        background: #17529f;
      }

      .btn-off {
        background: #22365c;
      }

      .audio-input-sources {
        position: absolute;
        align-items: flex-start;
        bottom: 20px;
        left: calc(100% - 20px);
        z-index: 1;
        background: #0e142c;
        border-radius: 8px;
        font-size: 15px;
        width: 170px;
        padding: 6px;
        cursor: default;
      }

      .input-source-title {
        text-align: right;
        width: 100%;
        font-size: 12px;
        color: white;
        margin-top: -3px;
        color: #a4c3ff;
      }

      .audio-source {
        width: calc(100% - 6px);
        flex: 1;
        align-items: flex-start;
        text-align: left;
        padding: 3px;
        border-radius: 5px;
        cursor: pointer;
      }

      .audio-source:hover {
        background: #263368;
      }

      /*
      .toggle-btn:hover {
        background: #17529f;
      }

      .toggle-btn:hover:not(.btn-off) {
        background: #22365c;
      }
      */

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

function streamAndTrackInfoToColor(
  info: StreamAndTrackInfo | undefined,
  kind: 'audio' | 'video'
): string {
  if (!info || !info.stream) return 'gray';
  const track = info.tracks.find(track => track.kind === kind);
  if (!track) return 'gray';
  if (track && !track.muted) return '#0886e7';
  if (track && track.muted) return '#e7bb08';
  return 'white';
}

function streamAndTrackInfoToText(
  info: StreamAndTrackInfo | undefined,
  kind: 'audio' | 'video'
): string | undefined {
  if (!info || !info.stream) return `No ${kind} WebRTC track`;
  const track = info.tracks.find(track => track.kind === kind);
  if (!track) return `No ${kind} WebRTC track`;
  if (track && !track.muted) return `${kind} WebRTC track in state 1`;
  if (track && track.muted) return `${kind} WebRTC track in state 2`;
  return `Unusual ${kind} WebRTC track state: ${track}`;
}

function deviceLabel(label: string): string {
  if (label === 'Default') return 'System Default';
  return label;
}
