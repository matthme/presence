import { LitElement, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { AppClient } from '@holochain/client';
import { localized } from '@lit/localize';
import { consume } from '@lit/context';
import { WeaveClient } from '@theweave/api';
import Plotly, { Data, Datum, Layout, PlotData } from 'plotly.js-dist-min';

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
import { StreamAndTrackInfo, weaveClientContext } from '../types';
import { StreamsStore } from '../streams-store';
import { StreamInfoLog } from '../logging';

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

  @state()
  loading = true;

  @query('#graph')
  graph!: HTMLElement;

  async firstUpdated() {
    const data: Data[] = [];
    // Load inital data from the logger into the plot
    const myLogInfos = this.streamsStore.logger.myStreamStatusLog;
    const myStreamData = loadStreamAndTrackInfo(myLogInfos, 'actual');

    data.push(...myStreamData);

    const myStreamTrackTrace: Partial<PlotData> = {
      x: [],
      y: [],
      type: 'scatter',
      name: 'Our actual stream',
      line: {
        dash: 'dash',
      },
    };

    myLogInfos.forEach(info => {
      const streamState = info.info.stream ? 1 : 0;
      (myStreamTrackTrace.x as Datum[]).push(info.t_first);
      (myStreamTrackTrace.y as Datum[]).push(streamState);
      (myStreamTrackTrace.x as Datum[]).push(info.t_last);
      (myStreamTrackTrace.y as Datum[]).push(streamState);
    });

    data.push(myStreamTrackTrace);

    // Add what other agents see about our stream
    Object.entries(this.streamsStore.logger.agentPongMetadataLogs).forEach(
      ([agent, logs]) => {
        const agentPerceivedVideoTrackTrace: Partial<PlotData> = {
          x: [],
          y: [],
          type: 'scatter',
          name: `Our video track from the perspective of ${agent}`,
        };

        logs.forEach(info => {
          const videoTrack = info.metaData.streamInfo?.tracks.find(
            track => track.kind === 'video'
          );
          const videoTrackState = videoTrack ? (videoTrack.muted ? -2 : -1) : 0;
          (agentPerceivedVideoTrackTrace.x as Datum[]).push(info.t_first);
          (agentPerceivedVideoTrackTrace.y as Datum[]).push(videoTrackState);
          (agentPerceivedVideoTrackTrace.x as Datum[]).push(info.t_last);
          (agentPerceivedVideoTrackTrace.y as Datum[]).push(videoTrackState);
        });

        const agentPerceivedStreamTrace: Partial<PlotData> = {
          x: [],
          y: [],
          type: 'scatter',
          name: `Our stream from the perspective of ${agent}`,
        };

        logs.forEach(info => {
          const streamState = info.metaData.streamInfo?.stream ? -1 : 0;
          (agentPerceivedStreamTrace.x as Datum[]).push(info.t_first);
          (agentPerceivedStreamTrace.y as Datum[]).push(streamState);
          (agentPerceivedStreamTrace.x as Datum[]).push(info.t_last);
          (agentPerceivedStreamTrace.y as Datum[]).push(streamState);
        });

        data.push(agentPerceivedStreamTrace, agentPerceivedVideoTrackTrace);
      }
    );

    // const trace3: Partial<PlotData> = {
    //   x: [1, 2, 3, 4],
    //   y: [10, 15, 13, 17],
    //   mode: 'markers',
    // };

    // const data = [myStreamTrackTrace];

    const layout: Partial<Layout> = {
      title: { text: 'Logs' },
      showlegend: false,
    };

    Plotly.newPlot(this.graph, data, layout);

    // Register a handler to extend the traces based on new events
  }

  render() {
    return html`
      <!-- NOTE: This requires plotly styles applied explicitly since this is shadow DOM -->
      <div id="graph"></div>
    `;
  }

  // plotly styles applied here
  static styles = [sharedStyles, plotlyStyles, css``];
}

function loadStreamAndTrackInfo(
  infoLog: StreamInfoLog[],
  name: string
): Data[] {
  const streamData: Partial<PlotData> = {
    x: [],
    y: [],
    type: 'scatter',
    name: `(Stream) ${name}`,
    line: {
      dash: 'dash',
    },
  };

  infoLog.forEach(info => {
    const streamState = info.info.stream ? 1 : 0;
    (streamData.x as Datum[]).push(info.t_first);
    (streamData.y as Datum[]).push(streamState);
    (streamData.x as Datum[]).push(info.t_last);
    (streamData.y as Datum[]).push(streamState);
  });

  const videoTrackData: Partial<PlotData> = {
    x: [],
    y: [],
    type: 'scatter',
    name: `(Video) ${name}`,
    line: {
      dash: 'dash',
    },
  };
  infoLog.forEach(info => {
    const videoTrack = info.info.tracks.find(track => track.kind === 'video');
    const videoTrackState = videoTrack ? (videoTrack.muted ? -2 : -1) : 0;
    (videoTrackData.x as Datum[]).push(info.t_first);
    (videoTrackData.y as Datum[]).push(videoTrackState);
    (videoTrackData.x as Datum[]).push(info.t_last);
    (videoTrackData.y as Datum[]).push(videoTrackState);
  });

  const audioTrackData: Partial<PlotData> = {
    x: [],
    y: [],
    type: 'scatter',
    name: `(Audio) ${name}`,
    line: {
      dash: 'dash',
    },
  };
  infoLog.forEach(info => {
    const audioTrack = info.info.tracks.find(track => track.kind === 'audio');
    const audioTrackState = audioTrack ? (audioTrack.muted ? -2 : -1) : 0;
    (audioTrackData.x as Datum[]).push(info.t_first);
    (audioTrackData.y as Datum[]).push(audioTrackState);
    (audioTrackData.x as Datum[]).push(info.t_last);
    (audioTrackData.y as Datum[]).push(audioTrackState);
  });

  return [streamData, videoTrackData, audioTrackData];
}
