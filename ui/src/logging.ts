import { isEqual } from 'lodash-es';
import { AgentPubKeyB64 } from '@holochain/client';
import { nanoid } from 'nanoid';
import {
  readLocalStorage,
  readSessionStorage,
  writeLocalStorage,
  writeSessionStorage,
} from './utils';
import { PongMetaData, PongMetaDataV1, StreamAndTrackInfo } from './types';

declare global {
  interface Window {
    __PRESENCE_LOGGER_ACTIVE__: boolean;
  }
}

/**
 * A time block during which the stream state was the same
 * as specified in the info field.
 */
type StreamInfoLog = {
  /**
   * The time in unix epoch when this stream info was logged first
   */
  t_first: number;
  /**
   * The time in unix epoch when this stream info was logged last
   */
  t_last: number;
  info: StreamAndTrackInfo;
};

type SessionInfo = {
  start?: number;
  end?: number;
};

/**
 * A time block during which the pong metadata received from an agent
 * was the same `n_pong` times.
 */
type PongMetadataInfo = {
  /**
   * The time in unix epoch when this same pong metadata value was received first
   * in a row
   */
  t_first: number;
  /**
   * The time in unix epoch when this same pong metadata value was received last
   * in a row
   */
  t_last: number;
  /**
   * The number of pongs during which this same pong metadata was received in a row
   */
  n_pongs: number;
  /**
   * The actual pong metadata
   */
  metaData: PongMetaDataV1;
};

type CustomLog = {
  timestamp: number;
  log: string;
};

export class PresenceLogger {
  /**
   * The id of the current call session.
   */
  sessionId: string;

  /**
   * The log of stream info for my own stream, keyed by
   * timestamp
   */
  myStreamStatusLog: StreamInfoLog[] = [];

  agentPongMetadataLogs: Record<AgentPubKeyB64, PongMetadataInfo[]> = {};

  customLogs: CustomLog[] = [];

  constructor() {
    if (window.__PRESENCE_LOGGER_ACTIVE__)
      throw new Error(
        'Only a single instance of PresenceLogger can be instantiated at a time. There is already another instance active.'
      );
    window.__PRESENCE_LOGGER_ACTIVE__ = true;

    // Get or create session id
    const existingSessionId = readSessionStorage<string>('session_id');
    if (existingSessionId) {
      this.sessionId = existingSessionId;
    } else {
      const sessionId = nanoid(6);
      this.sessionId = sessionId;
      writeSessionStorage('session_id', sessionId);
    }

    // Add session info for this session if there is none yet
    const sessionInfos = readLocalStorage<Record<string, SessionInfo>>(
      'session_infos',
      {}
    );
    const existingSessionInfo = sessionInfos[this.sessionId];
    if (!existingSessionInfo) {
      sessionInfos[this.sessionId] = {
        start: Date.now(),
      };
      window.localStorage.setItem(
        'session_infos',
        JSON.stringify(sessionInfos)
      );
    }

    // Add an interval to write full state to localStorage every 15 seconds
    window.setInterval(() => {
      console.log('writing log to localStorage.');
      this.write();
    }, 15_000);

    // Populate the logs with pre-existing values for the same session by reading
    // from localStorage
    this._read();

    // Remove logs from sessions older than 1 week
    this._garbageCollect();
  }

  /**
   * Deletes any logs older than 1 week
   */
  _garbageCollect() {
    const week_ms = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const olderThanOneWeek = (timestamp: number) => now - timestamp > week_ms;

    const sessionInfos = readLocalStorage<Record<string, SessionInfo>>(
      'session_infos',
      {}
    );

    Object.entries(sessionInfos).forEach(([id, info]) => {
      if (info.start && olderThanOneWeek(info.start)) {
        console.log('Deleting old logs...');
        // Delete all logs for this session
        window.localStorage.removeItem(`log_my_stream_${id}`);
        window.localStorage.removeItem(`log_pong_metadata_${id}`);
        window.localStorage.removeItem(`custom_logs_${id}`);
      }
    });
  }

  /**
   * Read all logs from the current session from localStorage.
   * This method should only be called in the conlog_my_stream_structor to populate
   * the logs on the PresenceLogger instance object.
   */
  private _read() {
    this.myStreamStatusLog = readLocalStorage<StreamInfoLog[]>(
      `log_my_stream_${this.sessionId}`,
      []
    );
    // Potentially needs to be sorted but in principle should already
    // be sorted
    // .sort((info_a, info_b) => info_a.t_first - info_b.t_first);

    this.agentPongMetadataLogs = readLocalStorage<
      Record<AgentPubKeyB64, PongMetadataInfo[]>
    >(`log_pong_metadata_${this.sessionId}`, {});

    this.customLogs = readLocalStorage<CustomLog[]>(
      `custom_logs_${this.sessionId}`,
      []
    );
  }

  /**
   * Declare this session ended. Updates the session info in localStorage
   * with an end timestamp.
   */
  endSession() {
    const sessionInfos = readLocalStorage<Record<string, SessionInfo>>(
      'session_infos',
      {}
    );
    const existingSessionInfo = sessionInfos[this.sessionId];
    if (!existingSessionInfo) {
      // THIS CASE SHOULD NEVER HAPPEN. A session info should have been created
      // created in the constructor and available at this point.
      sessionInfos[this.sessionId] = {
        end: Date.now(),
      };
    } else {
      sessionInfos[this.sessionId] = {
        start: existingSessionInfo.start,
        end: Date.now(),
      };
    }

    writeLocalStorage('session_infos', sessionInfos);

    // write logs to localStorage
    this.write();
  }

  write() {
    // Write my audio/video stream logs
    writeLocalStorage<StreamInfoLog[]>(
      `log_my_stream_${this.sessionId}`,
      this.myStreamStatusLog
    );

    // Write agent pong metadata
    writeLocalStorage<Record<AgentPubKeyB64, PongMetadataInfo[]>>(
      `log_pong_metadata_${this.sessionId}`,
      this.agentPongMetadataLogs
    );

    writeLocalStorage<CustomLog[]>(
      `custom_logs_${this.sessionId}`,
      this.customLogs
    );
  }

  logMyStreamInfo(info: StreamAndTrackInfo) {
    const now = Date.now();
    const latestLog = this.myStreamStatusLog[this.myStreamStatusLog.length - 1];

    // Compare current info with info of latest log and if its equal, update the
    // `t_last` timestamp only, otherwise push a new `StreamInfoLog`
    const isSameInfo = latestLog ? isEqual(info, latestLog.info) : false;
    if (isSameInfo) {
      const newInfo: StreamInfoLog = {
        t_first: latestLog.t_first,
        t_last: now,
        info,
      };
      this.myStreamStatusLog[this.myStreamStatusLog.length - 1] = newInfo;
    } else {
      this.myStreamStatusLog.push({
        t_first: now,
        t_last: now,
        info,
      });
    }
  }

  logAgentPongMetaData(
    agent: AgentPubKeyB64,
    data: PongMetaDataV1
  ) {
    const now = Date.now();
    const agentMetadataLogs = this.agentPongMetadataLogs[agent] || [];
    const latestMetadata = agentMetadataLogs[agentMetadataLogs.length - 1];

    // We don't want to store the `knownAgents` field because it contains `lastSeen`
    // which changes too frequently and therefore the metadata would always change
    // and the timeseries gets cluttered too much
    const cleanedData = structuredClone(data); // Make a clone to not delete the field on the original object
    delete cleanedData.knownAgents;

    // Compare current info with info of latest log and if its equal, update the
    // `t_last` timestamp and `n_pongs` value only, otherwise push a new
    // `PongMetadataInfo` log
    const isSameMetadata = latestMetadata
      ? isEqual(cleanedData, latestMetadata.metaData)
      : false;
    if (isSameMetadata) {
      const newInfo: PongMetadataInfo = {
        t_first: latestMetadata.t_first,
        t_last: Date.now(),
        n_pongs: latestMetadata.n_pongs + 1,
        metaData: latestMetadata.metaData,
      };
      agentMetadataLogs[agentMetadataLogs.length - 1] = newInfo;
      this.agentPongMetadataLogs[agent] = agentMetadataLogs;
    } else {
      agentMetadataLogs.push({
        t_first: Date.now(),
        t_last: Date.now(),
        n_pongs: 1,
        metaData: cleanedData,
      });
      this.agentPongMetadataLogs[agent] = agentMetadataLogs;
    }
  }

  /**
   * Log a custom message. If no timestamp is provided, the timestamp
   * is taken as the timestamp at the time of logging.
   *
   * @param msg
   * @param timestamp
   */
  logCustomMessage(msg: string, timestamp?: number) {
    this.customLogs.push({
      timestamp: timestamp || Date.now(),
      log: msg,
    });
  }
}
