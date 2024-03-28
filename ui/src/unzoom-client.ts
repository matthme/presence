import { EntryRecord, ZomeClient } from '@holochain-open-dev/utils';
import { AgentPubKey, AppAgentClient, RoleName, Record } from '@holochain/client';
import {
  Attachment,
  DescendentRoom,
  InitAcceptInput,
  InitRequestInput,
  RoomInfo,
  SdpDataInput,
  UnzoomSignal,
} from './types';

export class UnzoomClient extends ZomeClient<UnzoomSignal> {
  constructor(
    public client: AppAgentClient,
    public roleName: RoleName,
    public zomeName = 'unzoom'
  ) {
    super(client, roleName, zomeName);
  }

  async getAllAgents(): Promise<AgentPubKey[]> {
    return this.callZome('get_all_agents', null);
  }

  async getLatestRoomInfo(): Promise<RoomInfo> {
    return this.callZome('get_latest_room_info', null);
  }

  async getAllAttachments(): Promise<Array<EntryRecord<Attachment>>> {
    const records: Array<Record> = await this.callZome('get_all_attachments', null);
    return records.map((record) => new EntryRecord<Attachment>(record));
  }

  async getAllDescendentRooms(): Promise<Array<DescendentRoom>> {
    return this.callZome('get_all_descendent_rooms', null);
  }

  /**
   * Ping all given agents for passive availability (i.e. not in the front-end), listening for their pong later
   */
  async pingBackend(agentPubKeys: AgentPubKey[]): Promise<void> {
    return this.callZome('ping', agentPubKeys);
  }

  async pingFrontend(agentPubKeys: AgentPubKey[]): Promise<void> {
    return this.callZome('ping_ui', agentPubKeys);
  }

  /**
   * Send a pong to an agent that sent a ping_ui
   * @param agentPubKey
   * @returns
   */
  async pongFrontend(agentPubKey: AgentPubKey): Promise<void> {
    return this.callZome('pong_ui', agentPubKey);
  }

  async sendInitRequest(payload: InitRequestInput): Promise<void> {
    return this.callZome('send_init_request', payload);
  }

  async sendInitAccept(payload: InitAcceptInput): Promise<void> {
    return this.callZome('send_init_accept', payload);
  }

  async sendSdpData(payload: SdpDataInput): Promise<void> {
    return this.callZome('send_sdp_data', payload);
  }
}
