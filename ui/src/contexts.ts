import { createContext } from '@lit/context';
import { AppClient } from '@holochain/client';
import { RoomStore } from './room-store';

export const clientContext = createContext<AppClient>('appAgentClient');
export const roomStoreContext = createContext<RoomStore>('roomStore');

