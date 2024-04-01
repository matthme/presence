import { createContext } from '@lit/context';
import { AppAgentClient } from '@holochain/client';
import { RoomStore } from './room-store';

export const clientContext = createContext<AppAgentClient>('appAgentClient');
export const roomStoreContext = createContext<RoomStore>('roomStore');

