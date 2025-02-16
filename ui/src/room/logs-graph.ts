import { LitElement, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { AppClient } from '@holochain/client';
import { localized } from '@lit/localize';
import { consume } from '@lit/context';
import { WeaveClient } from '@theweave/api';
import Plotly, { PlotData } from 'plotly.js-dist-min';

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
    const trace1: Partial<PlotData> = {
      x: [1, 2, 3, 4],
      y: [10, 15, 13, 17],
      type: 'scatter',
    };

    const trace2: Partial<PlotData> = {
      x: [1, 2, 3, 4],
      y: [16, 5, 11, 9],
      type: 'scatter',
    };

    const trace3: Partial<PlotData> = {
      x: [1, 2, 3, 4],
      y: [10, 15, 13, 17],
      mode: 'markers',
    };

    const data = [trace1, trace2, trace3];

    Plotly.newPlot(this.graph, data);
    this.loading = false;
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
