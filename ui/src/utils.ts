import {
  AgentPubKeyB64,
  AppInfo,
  CellType,
  ClonedCell,
  ProvisionedCell,
} from '@holochain/client';
import {
  ConnectionStatus,
  StreamAndTrackInfo,
  TrackInfo,
} from './types';

export type CellTypes = {
  provisioned: ProvisionedCell;
  cloned: ClonedCell[];
};

export function groupRoomNetworkSeed(appletNetworkSeed: string, uuid: string) {
  return `groupRoom#${appletNetworkSeed}#${uuid}`;
}

export function getCellTypes(appInfo: AppInfo): CellTypes {
  const provisionedCellInfo = appInfo.cell_info.presence.find(
    cellInfo => cellInfo.type === CellType.Provisioned
  );
  const provisionedCell = provisionedCellInfo
    ? provisionedCellInfo.value
    : undefined;

  if (!provisionedCell) throw new Error('Provisioned cell not found.');
  const clonedCells = appInfo.cell_info.presence
    ? appInfo.cell_info.presence
        .filter(cellInfo => cellInfo.type === CellType.Cloned)
        .map(cellInfo => cellInfo.value)
    : [];

  return {
    provisioned: provisionedCell,
    cloned: clonedCells,
  } as CellTypes;
}

export function connectionStatusToColor(
  status?: ConnectionStatus,
  offlineColor = 'transparent'
): string {
  if (!status) return offlineColor;
  switch (status.type) {
    case 'Disconnected':
      return 'transparent';
    case 'AwaitingInit':
      return 'gray';
    case 'AcceptSent':
      return 'blue';
    case 'InitSent':
      return 'blue';
    case 'SdpExchange':
      return 'yellow';
    case 'Connected':
      return '#48e708';
    case 'Blocked':
      return '#c72100';
    default:
      return offlineColor;
  }
}

export const sortConnectionStatuses = (
  a: [AgentPubKeyB64, ConnectionStatus],
  b: [AgentPubKeyB64, ConnectionStatus]
) => {
  const [pubkey_a, status_a] = a;
  const [pubkey_b, status_b] = b;
  // If both have equal connection status, sort by pubkey
  if (status_a.type === status_b.type) {
    return pubkey_a.localeCompare(pubkey_b);
  }
  // Disconnected is last
  if (status_a.type === 'Disconnected') return 1;
  if (status_b.type === 'Disconnected') return -1;
  // Everything else gets sorted by pubkey
  return pubkey_a.localeCompare(pubkey_b);

  // Connected is first - this is not being used for now as it may be harder to follow
  // state changes visually if the icons move around
  // if (status_a.type === "Connected") return 1;
  // if (status_b.type === "Connected") return -1;
};

export function getStreamInfo(
  stream: MediaStream | undefined | null
): StreamAndTrackInfo {
  let streamInfo: StreamAndTrackInfo = {
    stream: null,
    tracks: [],
  };

  if (stream) {
    const tracks = stream.getTracks();
    const tracksInfo: TrackInfo[] = [];
    tracks.forEach(track => {
      tracksInfo.push({
        kind: track.kind as 'audio' | 'video',
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
      });
    });
    streamInfo = {
      stream: {
        active: stream.active,
      },
      tracks: tracksInfo,
    };
  }
  return streamInfo;
}

export function readLocalStorage<T>(key: string): T | null;
// eslint-disable-next-line no-redeclare
export function readLocalStorage<T>(key: string, defaultValue?: T): T;
// eslint-disable-next-line no-redeclare
export function readLocalStorage<T>(key: string, defaultValue?: T): T | null {
  const val = window.localStorage.getItem(key);
  if (val) return JSON.parse(val);
  return defaultValue || null;
}

export function writeLocalStorage<T>(key: string, value: T): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function readSessionStorage<T>(key: string): T | null;
// eslint-disable-next-line no-redeclare
export function readSessionStorage<T>(key: string, defaultValue?: T): T;
// eslint-disable-next-line no-redeclare
export function readSessionStorage<T>(key: string, defaultValue?: T): T | null {
  const val = window.sessionStorage.getItem(key);
  if (val) return JSON.parse(val);
  return defaultValue || null;
}

export function writeSessionStorage<T>(key: string, value: T): void {
  window.sessionStorage.setItem(key, JSON.stringify(value));
}

export const downloadJson = (filename: string, text: string) => {
  const element = document.createElement('a');
  element.setAttribute(
    'href',
    `data:text/json;charset=utf-8,${encodeURIComponent(text)}`
  );
  element.setAttribute('download', filename);

  element.style.display = 'none';
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
};

export function formattedDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${
    date.getMonth() + 1
  }-${date.getDate()}-${date.getHours()}_${`00${date.getMinutes()}`.slice(
    -2
  )}_${`00${date.getSeconds()}`.slice(-2)}`;
}
