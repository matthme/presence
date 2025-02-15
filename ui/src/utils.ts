import {
  AgentPubKeyB64,
  AppInfo,
  CellType,
  ClonedCell,
  DnaHash,
  ProvisionedCell,
  RoleName,
} from '@holochain/client';
import { ConnectionStatus } from './types';

export type CellTypes = {
  provisioned: ProvisionedCell;
  cloned: ClonedCell[];
};

export function groupRoomNetworkSeed(appletNetworkSeed: string, uuid: string) {
  return `groupRoom#${appletNetworkSeed}#${uuid}`;
}

export function getCellTypes(appInfo: AppInfo): CellTypes {
  const provisionedCellInfo = appInfo.cell_info.presence.find(
    cellInfo => CellType.Provisioned in cellInfo
  );
  const provisionedCell = provisionedCellInfo
    ? (
        provisionedCellInfo as {
          [CellType.Provisioned]: ProvisionedCell;
        }
      )[CellType.Provisioned]
    : undefined;

  if (!provisionedCell) throw new Error('Provisioned cell not found.');
  const clonedCells = appInfo.cell_info.presence
    ? appInfo.cell_info.presence
        .filter(cellInfo => CellType.Cloned in cellInfo)
        .map(
          cellInfo =>
            (cellInfo as { [CellType.Cloned]: ClonedCell })[CellType.Cloned]
        )
    : [];

  return {
    provisioned: provisionedCell,
    cloned: clonedCells,
  };
}

export function roleNameForNetworkSeed(
  appInfo: AppInfo,
  networkSeed: string
): RoleName | undefined {
  for (const [role, cells] of Object.entries(appInfo.cell_info)) {
    for (const c of cells) {
      if (CellType.Provisioned in c) {
        if (
          c[CellType.Provisioned].dna_modifiers.network_seed === networkSeed
        ) {
          return role;
        }
      } else if (CellType.Cloned in c) {
        if (c[CellType.Cloned].dna_modifiers.network_seed === networkSeed) {
          return c[CellType.Cloned].clone_id;
        }
      }
    }
  }
  return undefined;
}

export function roleNameForDnaHash(
  appInfo: AppInfo,
  dnaHash: DnaHash
): RoleName | undefined {
  for (const [role, cells] of Object.entries(appInfo.cell_info)) {
    for (const c of cells) {
      if (CellType.Provisioned in c) {
        if (
          c[CellType.Provisioned].cell_id[0].toString() === dnaHash.toString()
        ) {
          return role;
        }
      } else if (CellType.Cloned in c) {
        if (c[CellType.Cloned].cell_id[0].toString() === dnaHash.toString()) {
          return c[CellType.Cloned].clone_id;
        }
      }
    }
  }
  return undefined;
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
