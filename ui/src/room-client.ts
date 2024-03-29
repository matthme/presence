import { EntryRecord, ZomeClient } from '@holochain-open-dev/utils';
import { AgentPubKey, AppAgentClient, RoleName, Record, ActionHash } from '@holochain/client';
import {
  Attachment,
  DescendentRoom,
  InitAcceptInput,
  InitRequestInput,
  RoomInfo,
  RoomSignal,
  SdpDataInput,
} from './types';

export class RoomClient extends ZomeClient<RoomSignal> {
  constructor(
    public client: AppAgentClient,
    public roleName: RoleName,
    public zomeName = 'room'
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

  async createAttachment(attachment: Attachment): Promise<EntryRecord<Attachment>> {
    const record = await this.callZome('create_attachment', attachment);
    return new EntryRecord(record);
  }

  async getAllDescendentRooms(): Promise<Array<[DescendentRoom, AgentPubKey, ActionHash]>> {
    return this.callZome('get_all_descendent_rooms', null);
  }

  async createDescendentRoom(input: DescendentRoom): Promise<ActionHash> {
    return this.callZome('create_descendent_room', input)
  }

  async getRoomInfo(): Promise<RoomInfo | undefined> {
    const maybeRoomInfoRecord: Record | undefined = await this.callZome('get_room_info', null);
    if (maybeRoomInfoRecord) {
      const entryRecord = new EntryRecord<RoomInfo>(maybeRoomInfoRecord);
      return entryRecord.entry;
    }
    return undefined;
  }

  async setRoomInfo(roomInfo: RoomInfo): Promise<void> {
    return this.callZome('set_room_info', roomInfo);
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
