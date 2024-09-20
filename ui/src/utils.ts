import {
  AppInfo,
  CellType,
  ClonedCell,
  DnaHash,
  ProvisionedCell,
  RoleName,
} from '@holochain/client';
import { ConnectionStatus } from './room-view';

export type CellTypes = {
  provisioned: ProvisionedCell;
  cloned: ClonedCell[];
}

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
  networkSeed: string,
): RoleName | undefined {
  for (const [role, cells] of Object.entries(appInfo.cell_info)) {
    for (const c of cells) {
      if (CellType.Provisioned in c) {
        if (c[CellType.Provisioned].dna_modifiers.network_seed === networkSeed) {
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
  dnaHash: DnaHash,
): RoleName | undefined {
  for (const [role, cells] of Object.entries(appInfo.cell_info)) {
    for (const c of cells) {
      if (CellType.Provisioned in c) {
        if (c[CellType.Provisioned].cell_id[0].toString() === dnaHash.toString()) {
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

export function connectionStatusToColor(status?: ConnectionStatus, offlineColor = 'transparent'): string {
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
    default:
      return offlineColor;
  }
}
