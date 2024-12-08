import { createContext } from '@lit/context';
import { AppClient } from '@holochain/client';
import { RoomStore } from './room-store';
import { StreamsStore } from './streams-store';

export const clientContext = createContext<AppClient>('appAgentClient');
export const roomStoreContext = createContext<RoomStore>('roomStore');
export const streamsStoreContext = createContext<StreamsStore>('streamsStore');

