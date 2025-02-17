import { LitElement, PropertyValues, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import {
  AgentPubKeyB64,
  AppClient,
  decodeHashFromBase64,
  encodeHashToBase64,
} from '@holochain/client';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit/context';
import { WeaveClient } from '@theweave/api';
import Plotly, {
  Dash,
  Data,
  Datum,
  Layout,
  PlotData,
  Shape,
} from 'plotly.js-dist-min';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import './room-view';

import { RoomStore } from './room-store';
import {
  clientContext,
  roomStoreContext,
  streamsStoreContext,
} from '../contexts';
import { plotlyStyles, sharedStyles } from '../sharedStyles';
import { weaveClientContext } from '../types';
import { StreamsStore } from '../streams-store';
import { SimpleEventType, StreamInfoLog } from '../logging';
import './elements/avatar-with-nickname';

@localized()
@customElement('logs-graph')
export class LogsGraph extends LitElement {
  @consume({ context: roomStoreContext })
  roomStore!: RoomStore;

  @consume({ context: streamsStoreContext })
  @property({ type: Object })
  streamsStore!: StreamsStore;

  @consume({ context: clientContext })
  @state()
  client!: AppClient;

  @consume({ context: weaveClientContext })
  @state()
  weaveClient!: WeaveClient;

  @property()
  agent!: AgentPubKeyB64;

  @state()
  loading = true;

  @query('#graph')
  graph!: HTMLElement;

  @state()
  autoFollow = true;

  shapes: Partial<Shape>[] = [];

  // updated(changedValues: PropertyValues) {
  //   super.updated(changedValues);
  //   if (changedValues.has('agent')) {
  //     // this.firstUpdated();
  //     // this.requestUpdate();
  //   }
  // }

  async firstUpdated() {
    const data: Data[] = [];

    /**
     * Trace indices:
     * 0 - Our own stream
     * 1 - Our own video track
     * 2 - Our own audio track
     * 3 - How our peer perceives our stream state
     * 4 - How our peer perceives our video track state
     * 5 - How our peer perceives our audio track state
     */

    // Load inital data from the logger into the plot
    const myStreamData = this.myStreamTraces();
    data.push(...myStreamData);

    const agentStreamData = this.agentStreamTraces();
    data.push(...agentStreamData);

    const shapes = this.agentEvents();
    this.shapes = shapes;

    const layout: Partial<Layout> = {
      showlegend: false,
      shapes,
      hovermode: 'closest',
      hoverlabel: {
        namelength: -1,
      },
    };

    Plotly.newPlot(this.graph, data, layout);

    // Register a handler to extend the traces based on new events
    this.registerEventHandlers();
  }

  myStreamTraces(): Data[] {
    const myLogInfos = this.streamsStore.logger.myStreamStatusLog;
    return loadStreamAndTrackInfo(myLogInfos, 'actual', false);
  }

  agentStreamTraces(): Data[] {
    const agentPongMetadataLogs =
      this.streamsStore.logger.agentPongMetadataLogs[this.agent] || [];

    const streamLogs: StreamInfoLog[] = agentPongMetadataLogs.map(log => ({
      t_first: log.t_first,
      t_last: log.t_last,
      info: log.metaData.streamInfo
        ? log.metaData.streamInfo
        : {
            stream: null,
            tracks: [],
          },
    }));

    return loadStreamAndTrackInfo(streamLogs, `perceived`, true);
  }

  agentEvents(): Partial<Shape>[] {
    const shapes: Partial<Shape>[] = [];

    const allAgentEvents = this.streamsStore.logger.agentEvents;
    const myEvents =
      allAgentEvents[encodeHashToBase64(this.client.myPubKey)] || [];
    const agentEvents = allAgentEvents[this.agent] || [];
    const pongEvents = agentEvents.filter(event => event.event === 'Pong');

    // Create rectangles for Pongs
    let tempRect: (Partial<Shape> & { x1: number }) | undefined;
    pongEvents
      .sort((a, b) => a.timestamp - b.timestamp)
      .forEach(event => {
        if (tempRect && event.timestamp - tempRect.x1 < 3_500) {
          tempRect.x1 = event.timestamp; // Update the right end of the rectangle
        } else if (!tempRect) {
          // start a new rectangle
          tempRect = {
            type: 'rect',
            name: 'Pong',
            x0: event.timestamp,
            x1: event.timestamp,
            y0: -0.5,
            y1: 0.5,
            line: {
              color: 'f2da0080',
            },
            fillcolor: 'f2da0080',
          };
        } else {
          // finish the rectangle and add it to the shapes array
          shapes.push(tempRect);
          tempRect = undefined;
        }
      });

    [
      ...myEvents,
      ...agentEvents.filter(event => event.event !== 'Pong'), // Filter out Pong events
    ].forEach(payload => {
      const [color, dash] = simpleEventTypeToColor(payload.event);
      const [y0, y1] = yEventType(payload.event);
      shapes.push({
        type: 'line',
        x0: payload.timestamp,
        y0,
        x1: payload.timestamp,
        y1,
        line: {
          color,
          dash,
        },
        name: payload.event,
      });
    });

    return shapes;
  }

  registerEventHandlers() {
    this.streamsStore.logger.on('simple-event', payload => {
      if (
        payload.event in
        [
          'MyAudioOn',
          'MyAudioOff',
          'MyVideoOn',
          'MyVideoOff',
          'ChangeMyAudioInput',
        ]
      ) {
        if (payload.agent !== encodeHashToBase64(this.client.myPubKey)) return;
      } else if (payload.agent !== this.agent) return;

      // If it's a Pong event, we want to use a rectanlge instead of lines in order
      // not to overload the computational load of rendering as this otherwise
      // freezes up Presence as a whole
      if (payload.event === 'Pong') {
        // Search all shapes for Pong rectangles with a timestamp less than 4.5 seconds ago
        // which would correspond to < 2x ping frequency and indicate that no Pong had been
        // lost. Otherwise we create a separate triangle to visualize gaps in Pongs.
        const matchingRectIdx = this.shapes.findIndex(
          shape =>
            shape.type === 'rect' &&
            shape.name === 'Pong' &&
            typeof shape.x1 === 'number' &&
            payload.timestamp - shape.x1 < 3_500
        );
        if (matchingRectIdx !== -1) {
          const matchingRect = this.shapes[matchingRectIdx];
          matchingRect.x1 = payload.timestamp;
          this.shapes[matchingRectIdx] = matchingRect;
        } else {
          this.shapes.push({
            type: 'rect',
            name: 'Pong',
            x0: payload.timestamp,
            x1: payload.timestamp,
            y0: -0.5,
            y1: 0.5,
            line: {
              color: 'f2da0080',
            },
            fillcolor: 'f2da0080',
          });
        }
      } else {
        const [color, dash] = simpleEventTypeToColor(payload.event);
        const [y0, y1] = yEventType(payload.event);
        this.addVerticalLine(
          payload.timestamp,
          payload.event,
          color,
          dash,
          y0,
          y1
        );
      }

      Plotly.relayout(this.graph, {
        shapes: this.shapes,
        xaxis: this.autoFollow
          ? {
              range: [payload.timestamp - 120_000, payload.timestamp + 120_000],
            }
          : undefined,
      });
    });

    this.streamsStore.logger.on('my-stream-info', payload => {
      // Load the new traces to the plot
      const streamState = payload.info.stream ? 1 : 0;
      const videoTrack = payload.info.tracks.find(
        track => track.kind === 'video'
      );
      const videoTrackState = videoTrack ? (videoTrack.muted ? 2 : 1) : 0;
      const audioTrack = payload.info.tracks.find(
        track => track.kind === 'audio'
      );
      const audioTrackState = audioTrack ? (audioTrack.muted ? 2 : 1) : 0;

      Plotly.extendTraces(
        this.graph,
        {
          x: [[payload.t_last], [payload.t_last], [payload.t_last]],
          y: [[streamState], [videoTrackState], [audioTrackState]],
        },
        [0, 1, 2]
      );
    });

    this.streamsStore.logger.on('agent-pong-metadata', payload => {
      if (payload.agent !== this.agent) return;
      const streamState = payload.info.metaData.streamInfo?.stream ? 1 : 0;
      const videoTrack = payload.info.metaData.streamInfo?.tracks.find(
        track => track.kind === 'video'
      );
      const videoTrackState = videoTrack ? (videoTrack.muted ? 2 : 1) : 0;
      const audioTrack = payload.info.metaData.streamInfo?.tracks.find(
        track => track.kind === 'audio'
      );
      const audioTrackState = audioTrack ? (audioTrack.muted ? 2 : 1) : 0;

      Plotly.extendTraces(
        this.graph,
        {
          x: [
            [payload.info.t_last],
            [payload.info.t_last],
            [payload.info.t_last],
          ],
          y: [
            [streamState * -1],
            [videoTrackState * -1],
            [audioTrackState * -1],
          ],
        },
        [3, 4, 5]
      );
    });
  }

  addVerticalLine(
    x: number,
    name: string,
    color: string,
    dash: Dash | undefined,
    y0: number,
    y1: number
  ) {
    this.shapes.push({
      type: 'line',
      x0: x,
      y0,
      x1: x,
      y1,
      line: {
        color,
        dash,
      },
      name,
    });
  }

  render() {
    return html`
      <!-- NOTE: This requires plotly styles applied explicitly since this is shadow DOM -->
      <div class="column secondary-font">
        <div
          class="column items-center"
          style="background: white; padding-top: 5px;"
        >
          <div class="row items-center">
            <span style="margin-right: 10px; font-size: 18px;"
              >${msg('Connection Logs with')}</span
            >
            <avatar-with-nickname
              .agentPubKey=${decodeHashFromBase64(this.agent)}
            ></avatar-with-nickname>
          </div>
        </div>
        <div class="tweaks column items-center" style="padding-top: 5px;">
          <div class="row" style="padding: 0 5px;">
            <input
              @change=${(e: Event) => {
                const checkbox = e.target as HTMLInputElement;
                this.autoFollow = checkbox.checked;
                console.log('Changed autofollow value: ', this.autoFollow);
              }}
              type="checkbox"
              checked
            />
            <span>${msg('auto-follow')}</span>
          </div>
        </div>
        <div id="graph"></div>
      </div>
    `;
  }

  // plotly styles applied here
  static styles = [
    sharedStyles,
    plotlyStyles,
    css`
      .tweaks {
        min-width: 1000px;
        background: white;
        font-size: 18px;
        color: black;
      }
    `,
  ];
}

function loadStreamAndTrackInfo(
  infoLog: StreamInfoLog[],
  name: string,
  inverse: boolean
): Data[] {
  const streamData: Partial<PlotData> = {
    x: [],
    y: [],
    type: 'scatter',
    name: `[My Stream] ${name}`,
    line: {
      dash: 'dash',
      color: 'black',
    },
  };

  infoLog.forEach(info => {
    let streamState = info.info.stream ? 1 : 0;
    if (inverse) streamState *= -1;
    (streamData.x as Datum[]).push(info.t_first);
    (streamData.y as Datum[]).push(streamState);
    (streamData.x as Datum[]).push(info.t_last);
    (streamData.y as Datum[]).push(streamState);
  });

  const videoTrackData: Partial<PlotData> = {
    x: [],
    y: [],
    type: 'scatter',
    name: `[My Video Track State] ${name}`,
    line: {
      color: 'darkblue',
    },
  };
  infoLog.forEach(info => {
    const videoTrack = info.info.tracks.find(track => track.kind === 'video');
    let videoTrackState = videoTrack ? (videoTrack.muted ? 2 : 1) : 0;
    if (inverse) videoTrackState *= -1;
    (videoTrackData.x as Datum[]).push(info.t_first);
    (videoTrackData.y as Datum[]).push(videoTrackState);
    (videoTrackData.x as Datum[]).push(info.t_last);
    (videoTrackData.y as Datum[]).push(videoTrackState);
  });

  const audioTrackData: Partial<PlotData> = {
    x: [],
    y: [],
    type: 'scatter',
    name: `[My Audio Track State] ${name}`,
    line: {
      color: 'darkred',
    },
  };
  infoLog.forEach(info => {
    const audioTrack = info.info.tracks.find(track => track.kind === 'audio');
    let audioTrackState = audioTrack ? (audioTrack.muted ? 2 : 1) : 0;
    if (inverse) audioTrackState *= -1;
    (audioTrackData.x as Datum[]).push(info.t_first);
    (audioTrackData.y as Datum[]).push(audioTrackState);
    (audioTrackData.x as Datum[]).push(info.t_last);
    (audioTrackData.y as Datum[]).push(audioTrackState);
  });

  return [streamData, videoTrackData, audioTrackData];
}

function simpleEventTypeToColor(
  event: SimpleEventType
): [string, Dash | undefined] {
  switch (event) {
    case 'Pong':
      return ['#f2da0080', undefined]; // darker yellow

    // WebRTC Connection Events
    case 'Connected':
      return ['green', undefined];
    case 'InitAccept':
      return ['lightblue', undefined];
    case 'InitRequest':
      return ['lightblue', undefined];
    case 'SdpData':
      return ['gray', undefined];
    case 'SimplePeerClose':
      return ['black', undefined];
    case 'SimplePeerError':
      return ['red', undefined];
    case 'SimplePeerStream':
      return ['darkblue', undefined];
    case 'SimplePeerTrack':
      return ['cyan', undefined];

    // WebRTC data signals
    case 'PeerAudioOnSignal':
      return ['darkred', undefined];
    case 'PeerAudioOffSignal':
      return ['darkred', 'dash'];
    case 'PeerVideoOnSignal':
      return ['darkblue', undefined];
    case 'PeerVideoOffSignal':
      return ['darkblue', 'dash'];
    case 'PeerChangeAudioInput':
      return ['darkred', 'dot'];
    case 'PeerChangeVideoInput':
      return ['darkblue', 'dot'];

    // My own events
    case 'MyAudioOn':
      return ['darkred', undefined];
    case 'MyAudioOff':
      return ['darkred', 'dash'];
    case 'MyVideoOn':
      return ['darkblue', undefined];
    case 'MyVideoOff':
      return ['darkblue', 'dash'];
    case 'ChangeMyAudioInput':
      return ['darkred', 'dot'];
    case 'ChangeMyVideoInput':
      return ['darkblue', 'dot'];

    // Reconcile attempts
    case 'ReconcileAudio':
      return ['darkred', undefined];
    case 'ReconcileStream':
      return ['black', undefined];
    case 'ReconcileVideo':
      return ['darkblue', undefined];

    default:
      return ['pink', undefined];
  }
}

function yEventType(event: SimpleEventType): [number, number] {
  switch (event) {
    case 'Pong':
      return [-0.5, 0.5];

    // WebRTC Connection Events
    case 'Connected':
      return [0, 1.5];
    case 'InitAccept':
      return [0, 1.5];
    case 'InitRequest':
      return [0, 1.5];
    case 'SdpData':
      return [0, 1.5];
    case 'SimplePeerClose':
      return [0, 1.5];
    case 'SimplePeerError':
      return [0, 1.5];
    case 'SimplePeerStream':
      return [0, 1.5];
    case 'SimplePeerTrack':
      return [0, 1.5];

    // WebRTC data signals
    case 'PeerAudioOnSignal':
      return [0, -0.75];
    case 'PeerAudioOffSignal':
      return [0, -0.75];
    case 'PeerVideoOnSignal':
      return [0, -0.75];
    case 'PeerVideoOffSignal':
      return [0, -0.75];
    case 'PeerChangeAudioInput':
      return [0, -0.75];
    case 'PeerChangeVideoInput':
      return [0, -0.75];

    // My own events
    case 'MyAudioOn':
      return [0, 0.75];
    case 'MyAudioOff':
      return [0, 0.75];
    case 'MyVideoOn':
      return [0, 0.75];
    case 'MyVideoOff':
      return [0, 0.75];
    case 'ChangeMyAudioInput':
      return [0, 0.75];
    case 'ChangeMyVideoInput':
      return [0, 0.75];

    // Reconcile attempts
    case 'ReconcileStream':
      return [-1.2, 1.2];
    case 'ReconcileAudio':
      return [-1.2, 1.2];
    case 'ReconcileVideo':
      return [-1.2, 1.2];
    default:
      return [0, 0.5];
  }
}
