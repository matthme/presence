import { createContext } from '@lit/context';
import { AppAgentClient } from '@holochain/client';
import { UnzoomStore } from './unzoom-store';

export const clientContext = createContext<AppAgentClient>('appAgentClient');
export const unzoomStoreContext = createContext<UnzoomStore>('unzoomStore');

