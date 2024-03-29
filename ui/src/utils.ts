import {
  AppInfo,
  CellType,
  ClonedCell,
  ProvisionedCell,
} from '@holochain/client';

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
