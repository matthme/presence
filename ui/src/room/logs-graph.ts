import { LitElement, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { AgentPubKeyB64, AppClient } from '@holochain/client';
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

  myStreamTraces(): Data[] {
    const myLogInfos = this.streamsStore.logger.myStreamStatusLog;
    return loadStreamAndTrackInfo(myLogInfos, 'actual', false);
  }

  agentStreamTraces(agent: AgentPubKeyB64): Data[] {
    const agentPongMetadataLogs =
      this.streamsStore.logger.agentPongMetadataLogs[agent] || [];

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

    return loadStreamAndTrackInfo(streamLogs, `perceived by ${agent}`, true);
  }

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

    Object.keys(this.streamsStore.logger.agentPongMetadataLogs).forEach(
      agent => {
        const agentStreamData = this.agentStreamTraces(agent);
        data.push(...agentStreamData);
      }
    );

    const layout: Partial<Layout> = {
      title: { text: 'Logs' },
      showlegend: false,
      hovermode: "closest",
      hoverlabel: {
        namelength: -1,
      }
    };

    Plotly.newPlot(this.graph, data, layout);

    // Register a handler to extend the traces based on new events
    this.streamsStore.logger.on('simple-event', payload => {
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
      <div class="column">
        <div class="tweaks secondary-font">
          <div class="row">
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
    name: `(Stream) ${name}`,
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
    name: `(Video Track State) ${name}`,
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
    name: `(Audio Track State) ${name}`,
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
    case 'AudioOffSignal':
      return ['darkred', 'dash'];
    case 'AudioOnSignal':
      return ['darkred', undefined];
    case 'VideoOffSignal':
      return ['darkblue', 'dash'];

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
    case 'AudioOffSignal':
      return [0, 0.75];
    case 'AudioOnSignal':
      return [0, 0.75];
    case 'VideoOffSignal':
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
